// Run: node --test (from the repo root)
// Checks and fixes as rounds on the change's own card (0.20.0): `job-start <slug> --id <card>
// --round check|fix` puts the job on the card as a round, its report is that round's verdict, and
// the card shows them on one line ("check 1: 2 problems · fix: done · check 2: running"). Old
// sub-card checks ("500-check") keep working. Also the job's own pane: one message per stop.
// Herdr is the fake (tests/fixtures/fake-herdr.mjs); the store is a scratch folder.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, readBoard, readInbox, render, roundsLine, STOPPED_LINES } from "../board.mjs"
import { workerResumed, workerStop } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const COORD = "w1:p1"
const WORKER = "w8:p2"
const T0 = "2026-11-10T13:00:00.000Z"
const at = (min) => new Date(Date.parse(T0) + min * 60_000)

function setup({ slug = "login-check" } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-check-rounds-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, "store")
  mkdirSync(store)
  const fake = join(base, "herdr.json")
  writeFileSync(
    fake,
    JSON.stringify({
      agents: [
        { pane_id: COORD, name: "", agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base },
        { pane_id: WORKER, name: slug, agent_status: "idle", interactive_ready: true, workspace_id: "w8", cwd: base },
      ],
    }),
  )
  const common = { ...process.env, HOME: base, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, TZ: "UTC", NO_COLOR: "1" }
  const coordEnv = { ...common, HERDR_PANE_ID: COORD, HERDR_WORKSPACE_ID: "w1" }
  const workerEnv = { ...common, HERDR_PANE_ID: WORKER, HERDR_WORKSPACE_ID: "w8", JOB_AGENT_ROLE: "worker", JOB_BOARD_NOTIFY_DELAY_MS: "0" }
  const run = (env, now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, JOB_BOARD_NOW: now.toISOString() }, encoding: "utf8" })
  const board = (now, ...args) => {
    const r = run(coordEnv, now, ...args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const card = (id) => JSON.parse(readFileSync(file, "utf8")).items.find((i) => i.id === id)
  const report = (name, body) => {
    const path = join(base, `${name}.json`)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  return { base, store, file, coordEnv, workerEnv, run, board, card, report, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("a check and a fix run as rounds on the change's card: each report is its round's verdict; one line shows them all", () => {
  const s = setup()
  try {
    const build = s.report("build", { status: "done", summary: "Built the login fix.", tested: "read-only" })
    s.board(at(0), "job-start", "login-build", "--title", "Login fix: build", "--desc", "The redirect loop.", "--report", build)
    s.board(at(1), "job-report", "login-build")
    assert.equal(s.card(1).column, "done")

    // Check 1 on the same card: back in Doing, the check's job on it, the build's kept.
    const c1 = s.report("check1", { status: "running" })
    const r1 = s.board(at(2), "job-start", "login-check", "--id", "1", "--round", "check", "--report", c1)
    assert.match(r1.stdout, /^1 → doing: Login fix: build \(job login-check\)/)
    let c = s.card(1)
    assert.deepEqual([c.column, c.job, c.former_jobs], ["doing", "login-check", ["login-build"]])
    assert.deepEqual(c.rounds.map((r) => [r.kind, r.n, r.job, r.status]), [["check", 1, "login-check", "running"]])
    assert.equal(roundsLine(c), "check 1: running")
    // The same start again (job-open finishing a start) adds no second round.
    s.board(at(2), "job-start", "login-check", "--id", "1", "--round", "check", "--report", c1)
    assert.equal(s.card(1).rounds.length, 1)

    // Its verdict: fix first, two problems. The card stays in Doing: the fix is the next step.
    writeFileSync(c1, JSON.stringify({ status: "done", verdict: "fix-first", summary: "Two problems.", findings: [{ severity: "medium", what: "a" }, { severity: "low", what: "b" }], tested: "read-only" }))
    const rep1 = s.board(at(3), "job-report", "login-check")
    assert.match(rep1.stdout, /^1 → doing: Login fix: build \(check 1: 2 problems\)/)
    c = s.card(1)
    assert.equal(c.column, "doing")
    assert.deepEqual([c.rounds[0].status, c.rounds[0].verdict, c.rounds[0].problems], ["done", "fix-first", 2])
    assert.equal(c.now.text, "check 1 finished: 2 problems")
    assert.equal(readInbox(s.file).messages.length, 0, "nothing for the coordinator to rewrite")

    // The fix: a round of the build job on the same card.
    const f = s.report("fix", { status: "running" })
    s.board(at(4), "job-start", "login-build", "--id", "1", "--round", "fix", "--report", f)
    writeFileSync(f, JSON.stringify({ status: "done", summary: "Fixed both.", tested: { command: "npm test", exit: 0, after_last_edit: true } }))
    s.board(at(5), "job-report", "login-build")
    assert.equal(roundsLine(s.card(1)), "check 1: 2 problems · fix: done")

    // Check 2: running. The card shows the whole line, on the card and in get.
    const c2 = s.report("check2", { status: "running" })
    s.board(at(6), "job-start", "login-check2", "--id", "1", "--round", "check", "--report", c2)
    c = s.card(1)
    assert.equal(roundsLine(c), "check 1: 2 problems · fix: done · check 2: running")
    assert.deepEqual([...c.former_jobs].sort(), ["login-build", "login-check"])
    const wide = render(buildView(readBoard(s.file), null, { now: at(6) }), { width: 120, now: at(6), layout: "wide" })
    assert.match(wide, /check 1: 2 problems · fix: done · check 2: running/)
    const got = s.board(at(6), "get", "1").stdout
    assert.match(got, /\nRounds:\n {2}check 1: 2 problems · job login-check\n {2}fix: done · job login-build\n {2}check 2: running · job login-check2\n/)

    // Check 1's report rewritten late: only its round's verdict changes; the card follows its last round.
    writeFileSync(c1, JSON.stringify({ status: "done", verdict: "fix-first", summary: "Three problems.", findings: [{ what: "a" }, { what: "b" }, { what: "c" }] }))
    const late = s.board(at(7), "job-report", "login-check", c1)
    assert.match(late.stdout, /^1 stays doing: Login fix: build \(check 1: 3 problems; a later round runs on it\)/)
    assert.equal(roundsLine(s.card(1)), "check 1: 3 problems · fix: done · check 2: running")

    // Check 2 passes and asks the merge question with its own buttons: Waiting on you.
    writeFileSync(c2, JSON.stringify({ status: "done", verdict: "ok-to-merge", summary: "Both fixed.", findings: [], needs_user: [{ ask: "Merge the login fix now?", options: ["Merge the login fix", "Wait for a review"], suggest: "Merge the login fix" }], tested: "read-only" }))
    s.board(at(8), "job-report", "login-check2")
    c = s.card(1)
    assert.equal(c.column, "waiting")
    assert.equal(c.ask, "Merge the login fix now?")
    assert.equal(roundsLine(c), "check 1: 3 problems · fix: done · check 2: ok to merge")
    // The same report again: nothing changes.
    assert.match(s.board(at(9), "job-report", "login-check2").stdout, /^1 unchanged \(waiting on you\)/)
    // json carries the rounds as stored.
    const json = JSON.parse(s.board(at(9), "json", "--project", "all").stdout)
    assert.equal(json.items[0].rounds.length, 3)
  } finally {
    s.done()
  }
})

test("the change's job reporting again while a check round runs on its card: the card follows the round; the job's stop reads its own report", () => {
  const s = setup({ slug: "login-build" })
  try {
    const build = s.report("build", { status: "done", summary: "Built the login fix.", tested: "read-only" })
    s.board(at(0), "job-start", "login-build", "--title", "Login fix: build", "--desc", "d", "--report", build)
    s.board(at(1), "job-report", "login-build")
    s.board(at(2), "job-start", "login-check", "--id", "1", "--round", "check", "--report", s.report("check1", { status: "running" }))
    // The build job rewrites its report while the check runs: noted, the card stays with its round.
    writeFileSync(build, JSON.stringify({ status: "done", summary: "Built the login fix; one more test.", tested: "read-only" }))
    const r = s.board(at(3), "job-report", "login-build", build)
    assert.match(r.stdout, /^1 stays doing: Login fix: build \(job login-build reported again; a later round runs on it\)/)
    assert.deepEqual([s.card(1).column, s.card(1).job], ["doing", "login-check"])
    assert.match(readInbox(s.file).messages.at(-1).text, /job login-build reported again \(done\) while a later round runs on the card/)
    // The same again: nothing new.
    assert.match(s.board(at(4), "job-report", "login-build", build).stdout, /^1 unchanged/)
    assert.equal(readInbox(s.file).messages.length, 1)
    // The build job's stop: its card is found (not "on no card"), and its own report read, from
    // the job's record as job-open writes it, not the check's on the card.
    const jobs = join(s.base, "state", "job-skill", "jobs")
    mkdirSync(jobs, { recursive: true })
    writeFileSync(join(jobs, "login-build.json"), JSON.stringify({ slug: "login-build", card: 1, report: build }))
    const stop = workerStop({ hook_event_name: "Stop", cwd: s.base, last_assistant_message: "Done." }, { ...s.workerEnv, XDG_STATE_HOME: join(s.base, "state") }, { now: at(5) })
    assert.equal(stop.text, "[job finished] login-build — done — Built the login fix; one more test.")
  } finally {
    s.done()
  }
})

test("--round: needs --id, takes check or fix, and no --parent; a card's rounds survive a bad hand edit", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "doing", "Login fix: build", "--desc", "d")
    for (const args of [["--round", "check"], ["--id", "1", "--round", "review"], ["--id", "1", "--round", "check", "--parent", "1"]]) {
      const r = s.run(s.coordEnv, at(1), "job-start", "login-check", ...args)
      assert.equal(r.status, 2, args.join(" "))
    }
    assert.equal(s.card(1).rounds, undefined)
    const state = JSON.parse(readFileSync(s.file, "utf8"))
    state.items[0].rounds = [{ kind: "check", n: 1, job: "ok-job", status: "done" }, { kind: "nope", job: "x" }, "junk", { kind: "fix", job: "BAD SLUG" }]
    writeFileSync(s.file, JSON.stringify(state))
    assert.deepEqual(readBoard(s.file).items[0].rounds.map((r) => r.job), ["ok-job"])
  } finally {
    s.done()
  }
})

test("old sub-card checks keep working: '1-check' names the check card under card 1", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "doing", "Login fix: build", "--job", "login-build", "--desc", "d")
    s.board(at(1), "add", "doing", "Login fix: check", "--parent", "1", "--job", "login-check-old", "--desc", "An old-style check.")
    assert.match(s.board(at(2), "move", "1-check", "done").stdout, /^2 → done: Login fix: check/)
  } finally {
    s.done()
  }
})

test("a job's own pane: job-report sends no note of its own; its '[job finished]' says when the report is on no card", () => {
  const s = setup({ slug: "login-check" })
  try {
    const path = s.report("check", { status: "done", summary: "Fine.", tested: "read-only" })
    s.board(at(0), "job-start", "login-check", "--title", "Login fix: check", "--desc", "d", "--report", path)
    s.board(at(1), "job-report", "login-check")
    // Rewritten after it was applied: from the coordinator's pane that is a note; from the job's own pane none.
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fine, after a second look.", tested: "read-only" }))
    const r = s.run(s.workerEnv, at(2), "job-report", "login-check", path, "--if-final")
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readInbox(s.file).messages.length, 0, "the job's [job finished] is the one message")
    // No card for the job at all: the stop line says the report is on no card.
    const other = setup({ slug: "lost-job" })
    try {
      other.board(at(0), "add", "todo", "Something else", "--desc", "d")
      const stop = workerStop({ hook_event_name: "Stop", cwd: other.base, last_assistant_message: "Done." }, other.workerEnv, { now: at(1) })
      assert.match(stop.text, / — no report yet — Done\.$/)
      // A final report in the job's record (job-open's), on no card: the one line says so.
      const jobs = join(other.base, "state", "job-skill", "jobs")
      mkdirSync(jobs, { recursive: true })
      writeFileSync(join(jobs, "lost-job.json"), JSON.stringify({ slug: "lost-job", report: other.report("lost", { status: "done", summary: "Checked the export.", tested: "read-only" }) }))
      const env = { ...other.workerEnv, XDG_STATE_HOME: join(other.base, "state") }
      const final = workerStop({ hook_event_name: "Stop", cwd: other.base, last_assistant_message: "Done." }, env, { now: at(2) })
      assert.equal(final.text, "[job finished] lost-job — done — Checked the export. (its report is on no card)")
    } finally {
      other.done()
    }
  } finally {
    s.done()
  }
})

test("a job's 'stopped without a report' line is over once it works again: hidden while its agent works, cleared on its next prompt", () => {
  const s = setup({ slug: "login-check" })
  try {
    s.board(at(0), "job-start", "login-check", "--title", "Login fix: check", "--desc", "d")
    s.board(at(1), "now", "1", STOPPED_LINES[0], "--only")
    const view = (status) => buildView(readBoard(s.file), [{ name: "login-check", agent_status: status, workspace_id: "w8", pane_id: WORKER }], { now: at(2) })
    assert.equal(view("idle").doing[0].now.text, STOPPED_LINES[0])
    assert.equal(view("working").doing[0].now, undefined)
    // The job's next prompt (UserPromptSubmit in its pane): the line is cleared on the card.
    assert.equal(workerResumed({ hook_event_name: "UserPromptSubmit", cwd: s.base }, s.workerEnv, { now: at(3) }), 1)
    assert.equal(s.card(1).now, undefined)
    // Any other line stays.
    s.board(at(4), "now", "1", "the check is reading the diff", "--only")
    assert.equal(workerResumed({ hook_event_name: "UserPromptSubmit", cwd: s.base }, s.workerEnv, { now: at(5) }), null)
    assert.equal(s.card(1).now.text, "the check is reading the diff")
  } finally {
    s.done()
  }
})
