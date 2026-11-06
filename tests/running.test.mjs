// Run: node --test (from the repo root)
// A stage running from another pane (0.19.0): `running <ref> "<label>"` marks a card as running a
// merge or a deploy, its row shows "<label> · N min" where a job's state goes (a working or
// blocked job agent wins), it counts as busy (not "not reviewed yet", not in the reminder), and
// after 2 h it reads "stuck?"; --clear and done remove it.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, detailLines, readBoard, render, unreviewedReminder } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-running-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = (now) => ({ ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1", JOB_AGENT_ROLE: "" })
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
  const ok = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const file = join(state, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  return { run, ok, file, item, done: () => rmSync(base, { recursive: true, force: true }) }
}

const T0 = "2026-11-06T10:00:00Z"
const at = (min) => new Date(Date.parse(T0) + min * 60_000)
const rowOf = (out, title) => out.split("\n").find((l) => l.includes(title)) ?? ""

test("running: set, shown on the row as label · age, same label keeps its time, a new one starts over, --clear removes it", () => {
  const t = setup()
  try {
    t.ok(T0, "add", "doing", "Release the GUI", "--desc", "Ship it.")
    assert.equal(t.ok(T0, "running", "1", "merging").trim(), "1 running: merging")
    assert.deepEqual(t.item(1).running, { label: "merging", since: "2026-11-06T10:00:00.000Z" })
    const row = rowOf(render(buildView(readBoard(t.file), null, { now: at(4) }), { width: 100, height: 30, color: false, now: at(4) }), "Release the GUI")
    assert.match(row, /Release the GUI\s+merging · 4 min\s+\S/)
    // The same label again keeps its time; another label starts over.
    t.ok(at(5).toISOString(), "running", "1", "merging")
    assert.equal(t.item(1).running.since, "2026-11-06T10:00:00.000Z")
    t.ok(at(6).toISOString(), "running", "1", "deploying the GUI")
    assert.deepEqual(t.item(1).running, { label: "deploying the GUI", since: "2026-11-06T10:06:00.000Z" })
    const later = render(buildView(readBoard(t.file), null, { now: at(10) }), { width: 100, height: 30, color: false, now: at(10) })
    assert.match(rowOf(later, "Release the GUI"), /deploying the GUI · 4 min/)
    // The details panel says it too.
    const entry = buildView(readBoard(t.file), null, { now: at(10) }).doing[0]
    const details = detailLines(entry, 80, { now: at(10) }).lines.map((l) => l.map((s) => s.t ?? "").join("")).join("\n")
    assert.match(details, /running: deploying the GUI · 4 min/)
    assert.equal(t.ok(at(11).toISOString(), "running", "1", "--clear").trim(), "1 running mark cleared")
    assert.equal(t.item(1).running, undefined)
    assert.doesNotMatch(render(buildView(readBoard(t.file), null, { now: at(12) }), { width: 100, height: 30, color: false, now: at(12) }), /deploying the GUI ·/)
  } finally {
    t.done()
  }
})

test("running: after 2 h the row says stuck? in amber, with no working bar", () => {
  const t = setup()
  try {
    t.ok(T0, "add", "waiting", "Release the GUI", "--desc", "Ship it.", "--ask", "Deploy the GUI now?", "--option", "Deploy the GUI", "--option", "Wait for the review", "--suggest", "Deploy the GUI")
    t.ok(T0, "running", "1", "deploying the GUI")
    const fresh = buildView(readBoard(t.file), null, { now: at(119) })
    assert.equal(fresh.waiting[0].running.stuck, false)
    const view = buildView(readBoard(t.file), null, { now: at(125) })
    assert.equal(view.waiting[0].running.stuck, true)
    const plain = render(view, { width: 100, height: 30, color: false, now: at(125), frame: 2 })
    assert.match(rowOf(plain, "Release the GUI"), /deploying the GUI · stuck\? 2 h 5 min/)
    assert.doesNotMatch(rowOf(plain, "Release the GUI"), /\[ *= *\]/)
    const color = render(view, { width: 100, height: 30, color: true, now: at(125) })
    assert.match(color, /\x1b\[1;33mdeploying the GUI · stuck\? 2 h 5 min/)
    // Fresh, it has the working colour and bar.
    const working = render(fresh, { width: 100, height: 30, color: true, now: at(119), frame: 0 })
    assert.match(working, /\x1b\[32mdeploying the GUI · 1 h 59 min/)
    assert.match(working, /\[= {3}\]/)
  } finally {
    t.done()
  }
})

test("running: a working or blocked job agent wins; an idle one doesn't, and the card is busy (not unreviewed, not in the reminder)", () => {
  const t = setup()
  try {
    t.ok(T0, "job-start", "gui-fix", "--title", "Fix the GUI", "--desc", "A fix.")
    t.ok(T0, "running", "gui-fix", "merging")
    const agents = (status) => [{ name: "gui-fix", agent_status: status, workspace_id: "", pane_id: "w1:p2" }]
    const now = at(30)
    const working = buildView(readBoard(t.file), agents("working"), { now }).doing[0]
    assert.equal(working.running, undefined)
    const blocked = buildView(readBoard(t.file), agents("blocked"), { now }).waiting[0]
    assert.equal(blocked.running, undefined)
    const idle = buildView(readBoard(t.file), agents("idle"), { now }).doing[0]
    assert.equal(idle.running.label, "merging")
    assert.ok(!idle.unreviewed, "a running merge is not 'not reviewed yet'")
    assert.match(rowOf(render(buildView(readBoard(t.file), agents("idle"), { now }), { width: 100, height: 30, color: false, now }), "Fix the GUI"), /merging · 30 min/)
    const state = readBoard(t.file)
    assert.equal(unreviewedReminder(state, {}, { agents: () => agents("idle"), now }), "")
    // Without the mark the same idle job is unreviewed.
    t.ok(now.toISOString(), "running", "gui-fix", "--clear")
    assert.equal(buildView(readBoard(t.file), agents("idle"), { now: at(60) }).doing[0].unreviewed, true)
  } finally {
    t.done()
  }
})

test("running: unknown card exits 1, a done card is refused, done clears the mark, help lists it", () => {
  const t = setup()
  try {
    t.ok(T0, "add", "doing", "Release the GUI", "--desc", "Ship it.")
    const missing = t.run(T0, "running", "99", "merging")
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no item 99 on the board/)
    assert.equal(t.run(T0, "running", "1").status, 2, "a label or --clear is needed")
    t.ok(T0, "running", "1", "merging")
    t.ok(T0, "done", "1")
    assert.equal(t.item(1).running, undefined)
    const late = t.run(T0, "running", "1", "merging")
    assert.equal(late.status, 1)
    assert.match(late.stderr, /card 1 is done/)
    assert.match(t.ok(T0, "help"), /^ {2}running <ref> "<label>" \| running <ref> --clear/m)
    assert.match(t.ok(T0, "help", "running"), /running takes: --clear, --project/)
  } finally {
    t.done()
  }
})
