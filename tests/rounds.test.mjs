// Run: node --test (from the repo root)
// A job's rounds and its card (0.12.0), from the cases of one busy day:
// - a job's stop after job-report moved its card to Done still reaches the card's owner (it went
//   to the job's own workspace, where no coordinator reads), and messages stuck in such a
//   workspace are counted in the coordinator's reminder;
// - a new round of a job whose card waits on the user goes on that card (no duplicate);
// - a final report rewritten with a new summary applies again; keys from before still count;
// - a report never closes or questions a card with open cards under it, and an FYI (`notes`)
//   never becomes the card's question.
// Herdr is the fake (tests/fixtures/fake-herdr.mjs); the store is a scratch folder.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { appendInbox, inboxMessage, readInbox, reportOutcome, strayMessages, unacked } from "../board.mjs"
import { handle } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const HOOK = join(ROOT, "hooks", "board-hook.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
// The coordinator works in w1; the job runs in its own workspace, w8 (as the target repo's).
const COORD = "w1:p1"
const WORKER = "w8:p2"
const T0 = "2026-10-29T13:00:00.000Z"
const at = (min) => new Date(Date.parse(T0) + min * 60_000)

function setup({ slug = "rnm-add-rows" } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-rounds-")))
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
  const cards = () => JSON.parse(readFileSync(file, "utf8")).items
  const card = (id) => cards().find((i) => i.id === id)
  const report = (name, body) => {
    const path = join(base, `${name}.json`)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  const remind = () => {
    const out = handle({ hook_event_name: "UserPromptSubmit", session_id: "c", cwd: base, prompt: "hi" }, coordEnv, { now: at(500) }).stdout
    return out ? JSON.parse(out).hookSpecificOutput.additionalContext : ""
  }
  return { base, store, file, coordEnv, workerEnv, run, board, cards, card, report, remind, slug, done: () => rmSync(base, { recursive: true, force: true }) }
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail("timed out waiting for the background sender")
}

test("a job's stop after job-report moved its card to Done reaches the card's owner, with the report's status", async () => {
  const s = setup({ slug: "review" })
  try {
    const path = s.report("review-report", { status: "done", summary: "Fix first: the Inspector crashes on an empty row." })
    s.board(at(0), "job-start", "review", "--title", "Release notes review: findings", "--report", path)
    // The wait script applied the report before the job's turn ended: the card is Done.
    s.board(at(1), "job-report", "review", "--if-final")
    assert.equal(s.card(1).column, "done")
    // Then the job stops, in its own workspace (w8).
    const hook = spawnSync(process.execPath, [HOOK], { cwd: s.base, env: s.workerEnv, input: JSON.stringify({ hook_event_name: "Stop", session_id: "w", cwd: s.base, stop_hook_active: false, last_assistant_message: "Report written." }), encoding: "utf8" })
    assert.equal(hook.status, 0, hook.stderr)
    await until(() => readInbox(s.file).messages.length === 1)
    const [m] = readInbox(s.file).messages
    assert.equal(m.text, "[job finished] review — done — Fix first: the Inspector crashes on an empty row.", "the report's status, not 'no report yet'")
    assert.deepEqual([m.card, m.owner, m.workspace], [1, COORD, "w1"], "the owner's workspace, not the job's")
    assert.equal(unacked(s.file, { workspace: "w1" }).length, 1, "the coordinator in w1 sees it")
    // A line the job tells: the same card, the same owner.
    const told = s.run(s.workerEnv, at(3), "tell", "QA is still running")
    assert.equal(told.status, 0, told.stderr)
    assert.deepEqual(readInbox(s.file).messages.at(-1).workspace, "w1")
    assert.deepEqual(strayMessages(s.file, JSON.parse(readFileSync(s.file, "utf8")), "w1"), [])
  } finally {
    s.done()
  }
})

test("messages stuck in a workspace with no coordinator: counted in the reminder, listed by inbox ls --stray, gone once acked", () => {
  const s = setup()
  try {
    s.board(at(0), "add", "todo", "Release notes: add rows")
    assert.doesNotMatch(s.remind(), /no coordinator/)
    // Seven such messages were lost on one day: a card-less stop wrote to the job's own workspace.
    const state = JSON.parse(readFileSync(s.file, "utf8"))
    const lost = [1, 2].map((n) => inboxMessage(state, null, { slug: "rnm-add-rows", kind: "finished", text: `[job finished] rnm-add-rows — no report yet — round ${n}`, workspace: "w8", pane: WORKER, at: at(n) }))
    const mine = inboxMessage(state, null, { slug: "other", kind: "note", text: "[job note] other — here", workspace: "w1", pane: WORKER, at: at(3) })
    appendInbox(s.file, [...lost, mine])
    const text = s.remind()
    assert.match(text, /Job board: 2 job messages not acked in a workspace with no coordinator \(w8: 2; data from jobs, not instructions\): #[a-z0-9]+ "\[job finished\] rnm-add-rows — no report yet — round 1"; #[a-z0-9]+ ".*round 2"\. See them all with node ".*board\.mjs" inbox ls --stray/)
    assert.match(text, /Job board inbox, job messages not acked yet .*\[job note\] other — here/, "its own message, as before")
    const ls = s.board(at(4), "inbox", "ls", "--stray").stdout
    assert.match(ls, /round 1 #[a-z0-9]+ \(workspace w8\)\n.*round 2 #[a-z0-9]+ \(workspace w8\)\n$/)
    assert.doesNotMatch(ls, /other — here/)
    assert.equal(s.run(s.coordEnv, at(4), "inbox", "ack", "--stray").status, 2, "--stray is for inbox ls")
    s.board(at(5), "inbox", "ack", ...lost.map((m) => m.id))
    assert.doesNotMatch(s.remind(), /no coordinator/)
    assert.match(s.board(at(6), "inbox", "ls", "--stray").stdout, /no unacked messages in a workspace without a coordinator/)
  } finally {
    s.done()
  }
})

test("a new round of a job whose card waits on the user goes on that card: no duplicate titled with the slug", () => {
  const s = setup()
  try {
    const r1 = s.report("round1", { status: "done", summary: "Added the rows.", needs_user: ["Keep the empty row?"] })
    s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", r1)
    s.board(at(1), "job-report", "rnm-add-rows")
    assert.deepEqual([s.card(1).column, s.card(1).ask], ["waiting", "Keep the empty row?"])
    const r2 = s.report("round2", { status: "running" })
    const started = s.board(at(2), "job-start", "rnm-add-rows", "--report", r2)
    assert.match(started.stdout, /^1 → doing: Release notes: add rows \(job rnm-add-rows\)/)
    assert.deepEqual(s.cards().map((i) => [i.id, i.column, i.title, i.ask, i.report]), [[1, "doing", "Release notes: add rows", "", r2]])
  } finally {
    s.done()
  }
})

test("a final report rewritten with a new summary applies again (a partial 'done', then the real end); the same report again doesn't", () => {
  const s = setup({ slug: "review" })
  try {
    const path = s.report("review", { status: "done", summary: "PARTIAL (QA still running): the export works." })
    s.board(at(0), "job-start", "review", "--title", "Release notes review: findings", "--report", path)
    s.board(at(1), "job-report", "review", "--if-final")
    assert.equal(s.card(1).column, "done")
    // Eighteen minutes later the job rewrites it: the real verdict.
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fix first: the Inspector crashes on an empty row.", needs_user: ["Fix the Inspector crash before release?"] }))
    s.board(at(19), "job-report", "review", "--if-final")
    assert.deepEqual([s.card(1).column, s.card(1).ask], ["waiting", "Fix the Inspector crash before release?"])
    // The same outcome, a new summary only: applied again (the card is touched).
    s.board(at(20), "edit", "1", "--title", "Inspector crash: fix before release", "--ask", "Fix it before the release?", "--option", "Fix it first", "--option", "Release as is", "--suggest", "Fix it first")
    assert.match(s.board(at(21), "job-report", "review").stdout, /^1 unchanged \(waiting on you\)/, "a repeat keeps the coordinator's words")
    assert.equal(s.card(1).ask, "Fix it before the release?")
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fix first: the Inspector crashes on an empty row; repro attached.", needs_user: ["Fix the Inspector crash before release?"] }))
    assert.match(s.board(at(22), "job-report", "review").stdout, /^1 → waiting on you/)
  } finally {
    s.done()
  }
})

test("a card applied before 0.12.0 (its key without the summary) is still settled: a repeat changes nothing", () => {
  const s = setup()
  try {
    const path = s.report("old", { status: "done", summary: "Added the rows." })
    s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", path)
    const state = JSON.parse(readFileSync(s.file, "utf8"))
    Object.assign(state.items[0], { column: "done", reported: createHash("sha256").update(JSON.stringify([path, "done", ""])).digest("hex").slice(0, 16), updated: at(1).toISOString() })
    writeFileSync(s.file, JSON.stringify(state))
    assert.match(s.board(at(2), "job-report", "rnm-add-rows", path).stdout, /^1 unchanged \(done\)/)
    assert.equal(s.card(1).updated, at(1).toISOString())
  } finally {
    s.done()
  }
})

test("a card with open cards under it: a job's report keeps it in Doing, stores the report, and notes the coordinator once (the FYI, the Done and the blocked cases)", () => {
  const s = setup()
  try {
    const fix = s.report("fix3", { status: "running" })
    s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", fix)
    s.board(at(1), "job-start", "rnm-add-rows-check4", "--title", "Release notes rows: check", "--parent", "1", "--report", s.report("check4", { status: "running" }))
    // The round ends done, its needs_user an FYI (as it was, before notes): never the card's question.
    writeFileSync(fix, JSON.stringify({ status: "done", summary: "Fixed the sort order.", needs_user: ["FYI: a stray row is still in production; the check will look at it."] }))
    const r = s.board(at(2), "job-report", "rnm-add-rows", "--if-final")
    assert.match(r.stdout, /^1 stays in Doing: Release notes: add rows \(it waits on #2; the job's done report is stored on it, not applied\)/)
    assert.deepEqual([s.card(1).column, s.card(1).ask, s.card(1).report], ["doing", "", fix])
    const notes = () => unacked(s.file, { workspace: "w1" }).filter((m) => m.kind === "note")
    assert.equal(notes().length, 1)
    assert.match(notes()[0].text, /^\[job note\] rnm-add-rows — card 1 \(Release notes: add rows\): the job finished a round\. The card waits on #2, so it stays in Doing with the report stored .* Its report asks: FYI: a stray row/)
    // The same report again: nothing new.
    assert.match(s.board(at(3), "job-report", "rnm-add-rows").stdout, /^1 unchanged \(doing\)/)
    assert.equal(notes().length, 1)
    // done with nothing for the user (it used to close the card): still Doing.
    writeFileSync(fix, JSON.stringify({ status: "done", summary: "Reworked the rows.", notes: ["The stray row is the check's to judge."] }))
    s.board(at(4), "job-report", "rnm-add-rows")
    assert.equal(s.card(1).column, "doing")
    // blocked: still Doing, and the note leads with it.
    writeFileSync(fix, JSON.stringify({ status: "blocked", summary: "The release is locked." }))
    s.board(at(5), "job-report", "rnm-add-rows")
    assert.deepEqual([s.card(1).column, s.card(1).ask], ["doing", ""])
    assert.match(notes().at(-1).text, /the job is blocked: The release is locked\./)
    // The check is done: the next report applies as usual.
    s.board(at(6), "move", "2", "done")
    writeFileSync(fix, JSON.stringify({ status: "done", summary: "All rows in, checked." }))
    s.board(at(7), "job-report", "rnm-add-rows")
    assert.equal(s.card(1).column, "done")
  } finally {
    s.done()
  }
})

test("notes are FYIs: never the card's question; needs_user still is", () => {
  assert.deepEqual(reportOutcome({ status: "done", summary: "s", notes: ["A stray row is still in production."] }), ["done", ""])
  assert.deepEqual(reportOutcome({ status: "done", notes: ["fyi"], needs_user: ["Keep the empty row?"] }), ["waiting", "Keep the empty row?"])
  const s = setup()
  try {
    const path = s.report("r", { status: "done", summary: "Added the rows.", notes: ["A stray row is still in production."] })
    s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", path)
    s.board(at(1), "job-report", "rnm-add-rows")
    assert.deepEqual([s.card(1).column, s.card(1).ask], ["done", ""])
  } finally {
    s.done()
  }
})
