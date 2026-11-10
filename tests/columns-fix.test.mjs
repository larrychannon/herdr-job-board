// Run: node --test (from the repo root)
// Where a card shows, from the check of 0.20.0:
// - a Done card shows in To do while real work is left under it (a job's done report included),
//   is never archived while it does, and `done` says where it shows;
// - a Doing card shown Done only through its follow-ups is stored Done when the last one is;
// - a round never takes over another running job's card; a reused slug's round is found by its
//   report file;
// - a live job's agent idle on its own background command, its report not final, is not "in
//   Doing, nothing running"; a finished round is; the reminder says to check the tab first;
// - only "Follow-up: …" (or "… follow-up: answer", or --follow-up) is a follow-up.
// Herdr is the fake (tests/fixtures/fake-herdr.mjs); the store is a scratch folder.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, cardFlag, DOING_IDLE_TEXT, flagReminder, isFollowUp, readBoard, roundOf, roundsLine, shownColumn, STOPPED_LINES } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const COORD = "w1:p1"
const T0 = "2026-11-10T13:00:00.000Z"
const at = (min) => new Date(Date.parse(T0) + min * 60_000)
const DAY = 24 * 60

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-columns-fix-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, "store")
  mkdirSync(store)
  const fake = join(base, "herdr.json")
  writeFileSync(fake, JSON.stringify({ agents: [{ pane_id: COORD, name: "", agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base }] }))
  const env = { ...process.env, HOME: base, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, TZ: "UTC", NO_COLOR: "1", HERDR_PANE_ID: COORD, HERDR_WORKSPACE_ID: "w1" }
  delete env.JOB_AGENT_ROLE
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, JOB_BOARD_NOW: now.toISOString() }, encoding: "utf8" })
  const board = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const card = (id) => readBoard(file).items.find((i) => i.id === id)
  const shown = (id) => {
    const state = readBoard(file)
    return shownColumn(state, state.items.find((i) => i.id === id))
  }
  const report = (name, body) => {
    const path = join(base, `${name}.json`)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  return { base, store, file, run, board, card, shown, report, done: () => rmSync(base, { recursive: true, force: true }) }
}

// --- a Done card with real work left under it ----------------------------------------------------

test("a job's done report on a card with a To do part: the card shows in To do, not Done; Done once that part is done", () => {
  const s = setup()
  try {
    const path = s.report("build", { status: "done", summary: "Built it.", tested: "read-only" })
    s.board(at(0), "job-start", "gcp-build", "--title", "Create nodes on GCP: build", "--desc", "d", "--report", path)
    s.board(at(1), "add", "todo", "Node password: seen in a job's log", "--parent", "1")
    const reported = s.board(at(2), "job-report", "gcp-build")
    assert.match(reported.stdout, /^1 → done: Create nodes on GCP: build$/m, "stdout as before")
    assert.match(reported.stderr, /^board: #1 shows in To do until only follow-ups are left under it\.$/m, "says where it shows, as done does")
    assert.equal(s.card(1).column, "done", "stored Done, as the report says")
    assert.equal(s.shown(1), "todo", "real work is left under it")
    const view = buildView(readBoard(s.file), null, { now: at(3) })
    assert.ok(view.todo.some((e) => e.id === 1 && e.shown === "todo"))
    assert.deepEqual(view.doneToday, [])
    assert.match(s.board(at(3), "get", "1").stdout, /Shows in To do: the work under it waits to start \(its own column: Done\)/)
    assert.equal(JSON.parse(s.board(at(3), "json").stdout).items.find((i) => i.id === 1).shown_column, "todo")
    s.board(at(4), "done", "2")
    assert.equal(s.shown(1), "done")
  } finally {
    s.done()
  }
})

test("a Done card is never archived while real work under it is open; one with only follow-ups left is", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "doing", "Create nodes on GCP: build")
    s.board(at(0), "add", "todo", "Node password: seen in a job's log", "--parent", "1")
    s.board(at(0), "add", "doing", "Login fix: build")
    s.board(at(0), "add", "todo", "Follow-up: two low findings of the check", "--parent", "3")
    s.board(at(1), "done", "1")
    s.board(at(1), "done", "3")
    // Eight days on, any write archives Done cards over a week old.
    s.board(at(8 * DAY), "add", "todo", "Something else")
    assert.ok(s.card(1), "#1 kept: its part is real work")
    assert.equal(s.shown(1), "todo")
    assert.equal(s.card(3), undefined, "#3 archived: only a follow-up was left")
    assert.ok(s.card(4), "the follow-up stays, a plain To do card")
    // The part done: #1 shows Done and goes with the next archive.
    s.board(at(8 * DAY + 1), "done", "2")
    s.board(at(16 * DAY), "add", "todo", "Later")
    assert.equal(s.card(1), undefined)
  } finally {
    s.done()
  }
})

test("done on a card with open parts says where it shows: To do while real work is left; Done when only follow-ups are", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "doing", "Release: build")
    s.board(at(0), "add", "todo", "Release part: later", "--parent", "1")
    const one = s.board(at(1), "done", "1")
    assert.match(one.stderr, /^board: #1 had open cards for it: #2\. They keep their link, and #1 shows in To do until only follow-ups are left under it\.$/m)
    assert.doesNotMatch(one.stderr, /shows where the most urgent/)
    s.board(at(2), "add", "doing", "Login fix: build")
    s.board(at(2), "add", "todo", "Follow-up: one low finding", "--parent", "3")
    const two = s.board(at(3), "done", "3")
    assert.match(two.stderr, /^board: #3 had open cards for it: #4\. They keep their link, and only follow-ups are left under it, so #3 shows in Done\.$/m)
  } finally {
    s.done()
  }
})

test("a Doing card shown Done only through its follow-ups is stored Done when the last of them is done: it never shows in Doing again", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "doing", "Login fix: build")
    s.board(at(0), "add", "todo", "Login part: tests", "--parent", "1")
    s.board(at(0), "add", "todo", "Follow-up: one low finding", "--parent", "1")
    // The real part done: only the follow-up is left, so #1 shows Done, still stored Doing.
    s.board(at(1), "done", "2")
    assert.deepEqual([s.card(1).column, s.shown(1)], ["doing", "done"])
    // The follow-up done: #1 is stored Done, so it doesn't fall back to Doing ("nothing running").
    s.board(at(2), "done", "3")
    assert.deepEqual([s.card(1).column, s.shown(1)], ["done", "done"])
    // A Doing card with a job of its own is its job's to finish: never stored Done for it.
    s.board(at(3), "add", "doing", "API: build", "--job", "api-build")
    s.board(at(3), "add", "todo", "Follow-up: docs", "--parent", "4")
    s.board(at(4), "done", "5")
    assert.equal(s.card(4).column, "doing")
    // A Doing card shown in Doing for a real part is not stored Done when only a follow-up closes.
    s.board(at(5), "add", "doing", "Search: build")
    s.board(at(5), "add", "doing", "Search part: index", "--parent", "6")
    s.board(at(5), "add", "todo", "Follow-up: tune", "--parent", "6")
    s.board(at(6), "done", "8")
    assert.equal(s.card(6).column, "doing")
  } finally {
    s.done()
  }
})

// --- rounds ----------------------------------------------------------------------------------------

test("a round never takes over another running job's card: refused with the job and the number; allowed once that job reported, or with no report path", () => {
  const s = setup()
  try {
    const other = s.report("other", { status: "running" })
    s.board(at(0), "job-start", "other-job", "--title", "Other change: build", "--desc", "d", "--report", other)
    const before = readFileSync(s.file, "utf8")
    const r = s.run(at(1), "job-start", "login-check", "--id", "1", "--round", "check", "--report", s.report("check", { status: "running" }))
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /card 1 is job other-job's, which is still running \(its report isn't final\): check the number/)
    assert.equal(readFileSync(s.file, "utf8"), before, "the card is unchanged")
    // That job reported: its card takes a round.
    writeFileSync(other, JSON.stringify({ status: "done", summary: "Built.", tested: "read-only" }))
    s.board(at(2), "job-start", "login-check", "--id", "1", "--round", "check", "--report", s.report("check", { status: "running" }))
    assert.deepEqual([s.card(1).job, s.card(1).rounds.length], ["login-check", 1])
    // A card with a job and no report path (linked by hand): allowed, as before.
    s.board(at(3), "add", "doing", "Hand-linked: build", "--job", "hand-job")
    s.board(at(4), "job-start", "hand-check", "--id", "2", "--round", "check")
    assert.equal(s.card(2).job, "hand-check")
    // A round on a card whose current job is another slug's running round: refused, the card unchanged.
    const running = readFileSync(s.file, "utf8")
    const fix = s.run(at(5), "job-start", "login-build", "--id", "1", "--round", "fix", "--report", s.report("fix", { status: "running" }))
    assert.equal(fix.status, 2, fix.stderr)
    assert.match(fix.stderr, /card 1 is job login-check's, which is still running/)
    assert.equal(readFileSync(s.file, "utf8"), running, "the card is unchanged")
  } finally {
    s.done()
  }
})

test("a round follows a finished round on the card, but never takes another slug's running round (a check typed onto the wrong card)", () => {
  const s = setup()
  try {
    for (const [n, name] of [[0, "a"], [1, "b"]]) {
      const build = s.report(`${name}-build`, { status: "done", summary: "Built.", tested: "read-only" })
      s.board(at(n), "job-start", `${name}-build`, "--title", `Change ${name.toUpperCase()}: build`, "--desc", "d", "--report", build)
      s.board(at(n), "job-report", `${name}-build`)
    }
    const ac = s.report("a-check", { status: "running" })
    s.board(at(2), "job-start", "a-check", "--id", "1", "--round", "check", "--report", ac)
    // B's check typed onto A's card while A's check runs: refused, naming the job and the card.
    const before = readFileSync(s.file, "utf8")
    const r = s.run(at(3), "job-start", "b-check", "--id", "1", "--round", "check", "--report", s.report("b-check", { status: "running" }))
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /card 1 is job a-check's, which is still running \(its report isn't final\): check the number/)
    assert.equal(readFileSync(s.file, "utf8"), before, "the card is unchanged")
    // On its own card it starts.
    s.board(at(4), "job-start", "b-check", "--id", "2", "--round", "check", "--report", s.report("b-check", { status: "running" }))
    assert.equal(s.card(2).job, "b-check")
    // A's check finished: its fix round follows on card 1.
    writeFileSync(ac, JSON.stringify({ status: "done", verdict: "fix-first", summary: "Two.", findings: [{ what: "a" }, { what: "b" }], tested: "read-only" }))
    s.board(at(5), "job-report", "a-check")
    s.board(at(6), "job-start", "a-build", "--id", "1", "--round", "fix", "--report", s.report("a-fix", { status: "running" }))
    assert.equal(s.card(1).job, "a-build")
    assert.equal(roundsLine(s.card(1)), "check 1: 2 problems · fix: running")
  } finally {
    s.done()
  }
})

test("one slug for check 1 and check 2: check 1's report applied again records nothing on check 2", () => {
  const s = setup()
  try {
    const build = s.report("build", { status: "done", summary: "Built.", tested: "read-only" })
    s.board(at(0), "job-start", "login-build", "--title", "Login fix: build", "--desc", "d", "--report", build)
    s.board(at(1), "job-report", "login-build")
    const c1 = s.report("check1", { status: "done", verdict: "fix-first", summary: "Two.", findings: [{ what: "a" }, { what: "b" }], tested: "read-only" })
    s.board(at(2), "job-start", "login-check", "--id", "1", "--round", "check", "--report", c1)
    s.board(at(3), "job-report", "login-check")
    const f = s.report("fix", { status: "done", summary: "Fixed.", tested: "read-only" })
    s.board(at(4), "job-start", "login-build", "--id", "1", "--round", "fix", "--report", f)
    s.board(at(5), "job-report", "login-build")
    // Check 2: the same slug, a new report file.
    const c2 = s.report("check2", { status: "running" })
    s.board(at(6), "job-start", "login-check", "--id", "1", "--round", "check", "--report", c2)
    assert.equal(roundsLine(s.card(1)), "check 1: 2 problems · fix: done · check 2: running")
    s.board(at(7), "job-report", "login-check", c1)
    assert.equal(roundsLine(s.card(1)), "check 1: 2 problems · fix: done · check 2: running", "check 2 still runs")
    assert.notEqual(s.card(1).now?.text, "check 2 finished: 2 problems")
    // roundOf: by report file first, else the slug's newest.
    const c = s.card(1)
    assert.equal(roundOf(c, "login-check", c1).n, 1)
    assert.equal(roundOf(c, "login-check", c2).n, 2)
    assert.equal(roundOf(c, "login-check").n, 2)
    assert.equal(roundOf(c, "login-check", "/no/such.json").n, 2)
  } finally {
    s.done()
  }
})

// --- "in Doing, nothing running" on a live job ---------------------------------------------------

test("a live job idle on its own background command, its report not final and no stopped line: not 'nothing running'; a finished round, or a stopped line, is", () => {
  const s = setup()
  try {
    const path = s.report("check", { status: "running" })
    const now = at(30)
    const card = { id: 1, title: "Login fix: build", column: "doing", job: "login-check", report: path, updated: at(0).toISOString(), since: at(0).toISOString() }
    const state = { items: [card] }
    const idle = () => "idle"
    assert.equal(cardFlag(state, card, "doing", { now, liveOf: idle }), "", "a test run in the background")
    assert.equal(cardFlag(state, card, "doing", { now, liveOf: () => "done" }), "", "Herdr's 'done' (a turn ended, unseen) too")
    // Its report final (a finished round): the next step is the coordinator's, so it is flagged.
    writeFileSync(path, JSON.stringify({ status: "done", verdict: "fix-first", findings: [] }))
    assert.equal(cardFlag(state, card, "doing", { now, liveOf: idle }), DOING_IDLE_TEXT)
    writeFileSync(path, JSON.stringify({ status: "running" }))
    // The job skill's "stopped without a report" line: it stopped, so it is flagged.
    for (const text of STOPPED_LINES) assert.equal(cardFlag(state, { ...card, now: { text } }, "doing", { now, liveOf: idle }), DOING_IDLE_TEXT)
    // No agent at all: flagged, as before.
    assert.equal(cardFlag(state, card, "doing", { now, liveOf: () => "" }), DOING_IDLE_TEXT)
    // The turn reminder: the idle live job isn't listed (it stopped waiting on its command, so it
    // isn't "finished — not reviewed" either); a flagged card's line says to check its tab first.
    const agents = () => [{ name: "login-check", agent_status: "idle", workspace_id: "w1" }]
    const stops = { "login-check": { state: "waiting", at: at(1).toISOString() } }
    assert.equal(flagReminder({ items: [card] }, { agents, now, stops }), "")
    const line = flagReminder({ items: [{ ...card, job: "", report: "" }] }, { agents, now })
    assert.match(line, /#1 "Login fix: build" \(in Doing, nothing running\)\. Check its tab first; never close a job whose agent is alive\. Then start what the card needs next, or tell the user why it waits\.$/)
    assert.doesNotMatch(line, /or close it/)
  } finally {
    s.done()
  }
})

// --- follow-ups ----------------------------------------------------------------------------------

test("a follow-up is a 'Follow-up: …' title, a '… follow-up: answer' title, or --follow-up; not any title that starts 'Follow-up'", () => {
  for (const title of ["Follow-up: 2 low findings of the check", "Follow-ups: docs", "followup: tidy", "Login fix follow-up: answer"]) assert.ok(isFollowUp({ title }), title)
  for (const title of ["Follow-up on the vendor: call them", "Follow up with the vendor", "Followups for Q4 planning", "Login fix: follow-up later"]) assert.ok(!isFollowUp({ title }), title)
  assert.ok(isFollowUp({ title: "Call the vendor", follow_up: true }))
  // Real work titled "Follow-up on …" holds its parent in To do.
  const items = [
    { id: 1, title: "Vendor contract: sign", column: "doing" },
    { id: 2, title: "Follow-up on the vendor: call them", column: "todo", parent: 1 },
  ]
  assert.equal(shownColumn({ items }, items[0]), "todo")
})
