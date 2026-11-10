// Run: node --test (from the repo root)
// A press runs the work (0.20.0): a merge question's button carries its action (`--action
// "<label>=<stage>"`, the coordinator's only), and a press of it records the press in the inbox
// (acked: the board carries it out) and starts the board's runner, which runs the merge script's
// run stage (`ship.mjs <repo> <card> run --approved-by board:<id> --stages …`) and tells the
// coordinator the result once. Without a run stage in the merge script nothing runs: the card says
// the press is recorded. The merge script is a fake (JOB_BOARD_SHIP); the store a scratch folder.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, createAnswerer, optionsOf, pressAction, readBoard, readInbox, RUN_UNAVAILABLE_LINE, unacked } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const NOW = "2026-11-10T14:00:00Z"

// A merge script with the run stage: `contract` lists it; a run writes its words to a file,
// prints two lines and exits with FAKE_SHIP_EXIT.
const SHIP_RUNS = `import { appendFileSync } from "node:fs"
const argv = process.argv.slice(2)
if (argv[0] === "contract") { console.log(JSON.stringify({ stages: ["plan", "ask", "merge", "install", "run"] })); process.exit(0) }
appendFileSync(process.env.FAKE_SHIP_LOG, JSON.stringify({ argv, cwd: process.cwd(), run: process.env.JOB_BOARD_RUN }) + "\\n")
console.log("merging the change")
console.log(process.env.FAKE_SHIP_EXIT === "0" ? "merged and installed" : "the install failed")
process.exit(Number(process.env.FAKE_SHIP_EXIT || 0))
`
// Today's merge script: no run stage, "contract" is no repo (a usage error, exit 2).
const SHIP_OLD = `const argv = process.argv.slice(2)
if (argv.length !== 3) { process.stderr.write("ship: usage: ship.mjs <repo> <card> plan|ask|approve|merge\\n"); process.exit(2) }
require("node:fs").appendFileSync(process.env.FAKE_SHIP_LOG, "ran\\n")
`

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-press-run-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, ".git", "board-state")
  const log = join(base, "ship-calls.jsonl")
  writeFileSync(log, "")
  const ships = { runs: join(base, "ship-runs.mjs"), old: join(base, "ship-old.cjs") }
  writeFileSync(ships.runs, SHIP_RUNS)
  writeFileSync(ships.old, SHIP_OLD)
  const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HOME: join(base, ".git", "home"), JOB_BOARD_NOW: NOW, TZ: "UTC", NO_COLOR: "1", FAKE_SHIP_LOG: log, FAKE_SHIP_EXIT: "0", JOB_BOARD_SHIP: ships.runs }
  delete env.JOB_AGENT_ROLE
  const run = (args, extra = {}) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, ...extra }, encoding: "utf8" })
  const ok = (args, extra) => {
    const r = run(args, extra)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const card = (id = 1) => readBoard(file).items.find((i) => i.id === id)
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean)
  const question = (extra = []) =>
    ok(["add", "waiting", "Login fix: merge and install", "--desc", "Checked, ready to go out.\nNow: the check passed", "--ask", "Merge the login fix and install it?", "--option", "Merge and install it", "--option", "Hold the merge", "--suggest", "Merge and install it", ...extra])
  return { base, store, file, env, ships, run, ok, card, calls, question, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("--action stores what a button runs, the coordinator's only: stage words, this card, its project's folder", () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const [go, hold] = optionsOf(s.card())
    assert.deepEqual(go.action, { stage: "merge+install", repo: s.base, card: 1 })
    assert.equal(hold.action, undefined)
    // A new set of buttons drops it unless given again; a new --suggest keeps it.
    s.ok(["edit", "1", "--suggest", "Hold the merge"])
    assert.equal(optionsOf(s.card())[0].action.stage, "merge+install")
    s.ok(["edit", "1", "--option", "Merge and install it", "--option", "Hold the merge", "--suggest", "Merge and install it"])
    assert.equal(optionsOf(s.card())[0].action, undefined)
    // Refused: a job's pane, a stage that isn't one, a label that isn't a button.
    const worker = s.run(["edit", "1", "--action", "Merge and install it=merge"], { JOB_AGENT_ROLE: "worker" })
    assert.equal(worker.status, 2)
    assert.match(worker.stderr, /--action is the coordinator's/)
    assert.equal(s.run(["edit", "1", "--action", "Merge and install it=rm -rf"]).status, 2)
    assert.equal(s.run(["edit", "1", "--action", "Ship it=merge"]).status, 2)
    assert.equal(optionsOf(s.card())[0].action, undefined, "nothing written on a refusal")
    // A stored action that isn't well formed is no action.
    const raw = JSON.parse(readFileSync(s.file, "utf8"))
    raw.items[0].options[0].action = { stage: "merge; rm -rf /", repo: s.base, card: 1 }
    writeFileSync(s.file, JSON.stringify(raw))
    assert.equal(optionsOf(s.card())[0].action, undefined)
  } finally {
    s.done()
  }
})

test("a press of a button with an action: the press is recorded (acked), the card leaves Waiting with its run, and the runner starts", async () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const started = []
    const answers = createAnswerer({ file: s.file, origin: "w1:p1", env: s.env, agents: () => null, runner: (...a) => started.push(a) })
    await answers.press({ type: "send", id: 1, label: "Merge and install it", key: "#1" })
    const c = s.card()
    assert.equal(c.column, "doing")
    assert.equal(c.answered.label, "Merge and install it")
    assert.deepEqual([c.run.stage, c.run.status, c.run.label], ["merge+install", "starting", "Merge and install it"])
    assert.equal(c.now.text, 'your press "Merge and install it": starting merge+install')
    assert.equal(started.length, 1)
    assert.deepEqual(started[0].slice(1, 3), [1, c.run.msg])
    // The press is in the inbox for ship.mjs to check (inbox get), acked: no coordinator acts on it.
    const m = readInbox(s.file).messages.find((x) => x.id === c.run.msg)
    assert.deepEqual([m.kind, m.card, m.label, m.action.stage], ["answer", 1, "Merge and install it", "merge+install"])
    assert.equal(unacked(s.file).length, 0)
    const got = JSON.parse(s.ok(["inbox", "get", c.run.msg]).stdout)
    assert.equal(got.label, "Merge and install it")
    // The other button goes to the coordinator as before (no runner).
    // The other button goes the coordinator's way as before: no runner (here no coordinator, so it says so).
    s.question()
    await answers.press({ type: "send", id: 2, label: "Hold the merge", key: "#2" })
    assert.equal(started.length, 1)
    assert.match(answers.notes["#2"].t, /^couldn't send/)
  } finally {
    s.done()
  }
})

test("the runner: asks the merge script for its run stage, runs it in the repo with the press, puts its last line on the card, tells the coordinator once", () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const r = pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => {} })
    assert.equal(r.stage, "merge+install")
    const runner = s.run(["run-press", "1", r.msg])
    assert.equal(runner.status, 0, runner.stderr)
    const [call] = s.calls().map((l) => JSON.parse(l))
    assert.deepEqual(call.argv, [s.base, "1", "run", "--approved-by", `board:${r.msg}`, "--stages", "merge,install"])
    assert.equal(call.cwd, s.base)
    assert.equal(call.run, r.msg)
    const c = s.card()
    assert.deepEqual([c.run.status, c.run.exit, c.run.last], ["ok", 0, "merged and installed"])
    assert.match(readFileSync(c.run.log, "utf8"), /merging the change\nmerged and installed/)
    const notes = unacked(s.file).filter((m) => m.kind === "note")
    assert.equal(notes.length, 1)
    assert.match(notes[0].text, /^\[board run\] card 1 \([^)]*Login fix: merge and install\): the "Merge and install it" press ran merge\+install: done — merged and installed/)
    // A second runner for the same press does nothing (the run is claimed once).
    assert.equal(s.run(["run-press", "1", r.msg]).status, 1)
    assert.equal(s.calls().length, 1)
    // The details and get say what ran.
    assert.match(s.ok(["get", "1"]).stdout, /Run: merge\+install \(the "Merge and install it" press\) · ok \(exit 0\)/)
  } finally {
    s.done()
  }
})

test("a run that fails says so on the card; a run going on shows as running, never 'nothing running'", () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const r = pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => {} })
    s.ok(["run-press", "1", r.msg], { FAKE_SHIP_EXIT: "3" })
    const c = s.card()
    assert.deepEqual([c.run.status, c.run.exit], ["failed", 3])
    assert.equal(c.now.text, "the merge+install run failed (exit 3): read its log")
    assert.match(unacked(s.file).find((m) => m.kind === "note").text, /ran merge\+install: failed \(exit 3\) — the install failed/)
    // While a run is marked as going on, the card shows it running (not "nothing running").
    const raw = JSON.parse(readFileSync(s.file, "utf8"))
    Object.assign(raw.items[0], { column: "doing", run: { ...raw.items[0].run, status: "running", at: NOW } })
    writeFileSync(s.file, JSON.stringify(raw))
    const v = buildView(readBoard(s.file), [], { now: new Date(Date.parse(NOW) + 60 * 60_000) })
    assert.equal(v.doing[0].flag, undefined)
    assert.deepEqual([v.doing[0].running.label, v.doing[0].running.stuck], ["merge+install", false])
    // A second press can't start another run on it.
    Object.assign(raw.items[0], { column: "waiting", ask: "Again?", options: [{ label: "Merge and install it", suggested: true, action: { stage: "merge", repo: s.base, card: 1 } }, { label: "Hold the merge" }] })
    writeFileSync(s.file, JSON.stringify(raw))
    assert.match(pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => assert.fail("no runner") }).error, /has a run going on already/)
  } finally {
    s.done()
  }
})

test("fail safe: a merge script without a run stage (or none at all) runs nothing; the card says the press is recorded, and the coordinator is told to carry it out", () => {
  for (const ship of ["old", "missing"]) {
    const s = setup()
    try {
      s.question(["--action", "Merge and install it=merge+install"])
      const r = pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => {} })
      s.ok(["run-press", "1", r.msg], { JOB_BOARD_SHIP: ship === "old" ? s.ships.old : join(s.base, "no-such-ship.mjs") })
      assert.deepEqual(s.calls(), [], `${ship}: nothing ran`)
      const c = s.card()
      assert.equal(c.run.status, "unavailable")
      assert.equal(c.now.text, RUN_UNAVAILABLE_LINE)
      assert.equal(c.column, "doing")
      const note = unacked(s.file).find((m) => m.kind === "note")
      assert.match(note.text, new RegExp(`the "Merge and install it" press is recorded, but the board can't run merge\\+install yet \\(${ship === "old" ? "the merge script has no run stage yet" : "no merge script at"}.*carry it out as before, with --approved-by board:${r.msg}`))
    } finally {
      s.done()
    }
  }
})

test("answer (a Telegram reply, the command line) does what a press does: an action button runs on the board, nothing is sent; another project's only with --front", async () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    // From another project's folder: its card, not this pane's: refused without --front, nothing runs.
    const other = join(s.base, "other")
    spawnSync("git", ["init", "-q", other])
    const away = spawnSync(process.execPath, [BOARD, "answer", "1", "1"], { cwd: other, env: s.env, encoding: "utf8" })
    assert.equal(away.status, 2)
    assert.match(away.stderr, /add --front to run it from here/)
    assert.equal(s.card().column, "waiting")
    // HERDR_ENV=0: a plain answer would need Herdr to send; an action button needs no coordinator.
    const r = s.run(["answer", "1", "1", "--from", "telegram"], { JOB_BOARD_SHIP: join(s.base, "no-such-ship.mjs") })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^card 1 → doing: your press "Merge and install it" runs merge\+install on the board/)
    assert.equal(s.card().answered.from, "telegram")
    // The real runner started in the background: let it end before the folder goes.
    const end = Date.now() + 10_000
    while (Date.now() < end && ["starting", "running"].includes(s.card().run.status)) await new Promise((done) => setTimeout(done, 50))
    assert.equal(s.card().run.status, "unavailable")
  } finally {
    s.done()
  }
})

test("a press of an action that isn't this card's (a hand edit, a copied card) runs nothing", () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const raw = JSON.parse(readFileSync(s.file, "utf8"))
    raw.items[0].options[0].action.card = 99
    writeFileSync(s.file, JSON.stringify(raw))
    const r = pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => assert.fail("no runner") })
    assert.match(r.error, /isn't this card's; nothing runs/)
    assert.equal(s.card().column, "waiting")
    assert.equal(readInbox(s.file).messages.length, 0)
  } finally {
    s.done()
  }
})

test("a job's own question with buttons never carries an action, whatever its report says", () => {
  const s = setup()
  try {
    const report = join(s.base, "report.json")
    s.ok(["job-start", "login", "--title", "Login fix: build", "--report", report])
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Built.", tested: "read-only", needs_user: [{ ask: "Merge it now?", options: ["Merge the login fix", "Wait for the review"], suggest: "Merge the login fix", action: { stage: "merge", repo: s.base, card: 1 } }] }))
    s.ok(["job-report", "login"])
    assert.equal(s.card().column, "waiting")
    assert.ok(optionsOf(s.card()).every((o) => !o.action))
  } finally {
    s.done()
  }
})

test("a run whose process is gone (a crash, a reboot) is not running: the card is 'in Doing, nothing running' again", () => {
  const s = setup()
  try {
    s.question(["--action", "Merge and install it=merge+install"])
    const r = pressAction(s.file, 1, "Merge and install it", { env: s.env, now: new Date(NOW), start: () => {} })
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid
    const raw = JSON.parse(readFileSync(s.file, "utf8"))
    Object.assign(raw.items[0], { updated: NOW, run: { ...raw.items[0].run, status: "running", pid: gone, at: NOW } })
    writeFileSync(s.file, JSON.stringify(raw))
    const v = buildView(readBoard(s.file), [], { now: new Date(Date.parse(NOW) + 60 * 60_000) })
    assert.equal(v.doing[0].running, undefined)
    assert.equal(v.doing[0].flag, "in Doing, nothing running")
    // The runner never claims a run whose words were changed on the card by hand.
    Object.assign(raw.items[0], { run: { ...raw.items[0].run, status: "starting", stage: "merge; rm" } })
    writeFileSync(s.file, JSON.stringify(raw))
    assert.equal(s.run(["run-press", "1", r.msg]).status, 1)
    assert.deepEqual(s.calls(), [])
    assert.equal(s.card().run.status, "failed")
  } finally {
    s.done()
  }
})
