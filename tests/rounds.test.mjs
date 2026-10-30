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

import { appendInbox, inboxMessage, jobCard, JOB_CARD_RECENT_MS, readInbox, reportOutcome, strayMessages, unacked } from "../board.mjs"
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
    const hook = spawnSync(process.execPath, [HOOK], { cwd: s.base, env: { ...s.workerEnv, JOB_BOARD_NOW: at(2).toISOString() }, input: JSON.stringify({ hook_event_name: "Stop", session_id: "w", cwd: s.base, stop_hook_active: false, last_assistant_message: "Report written." }), encoding: "utf8" })
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

test("job-start without --id: a Waiting card with a question or buttons stays the user's (a new card, and a hint); one that asks nothing takes the round", () => {
  const s = setup()
  try {
    const r1 = s.report("round1", { status: "done", summary: "Added the rows.", needs_user: ["Keep the test server running?"] })
    s.board(at(0), "job-start", "rnm-tryout", "--title", "Export fix: try it", "--report", r1)
    s.board(at(1), "job-report", "rnm-tryout")
    s.board(at(2), "edit", "1", "--title", "Test server: keep it running?", "--ask", "Keep the test server running while you try it?", "--option", "Keep it running", "--option", "Stop it", "--suggest", "Keep it running")
    const before = s.card(1)
    // The replay: job-start with a new --title used to turn this card into the round, dropping
    // the question and its buttons without a word.
    const r2 = s.report("round2", { status: "running" })
    const started = s.board(at(3), "job-start", "rnm-tryout", "--title", "Export fix: try it on the test server", "--report", r2)
    assert.match(started.stdout, /^2 → doing: Export fix: try it on the test server \(job rnm-tryout\)/)
    assert.match(started.stderr, /card 1 of job rnm-tryout still waits on the user, so this round has a new card \(2\)\. For a round on card 1 instead: board\.mjs job-start rnm-tryout --id 1/)
    assert.deepEqual(s.card(1), before, "the question card is untouched: its ask, its buttons, its column")
    // No --title either: still a new card while the card asks something.
    s.board(at(4), "move", "2", "done")
    assert.match(s.board(at(5), "job-start", "rnm-tryout", "--report", s.report("round3", { status: "running" })).stdout, /^3 → doing/)
    assert.deepEqual(s.card(1), before)
    // A Waiting card that asks nothing (moved there by hand) takes the next round: no duplicate.
    s.board(at(6), "move", "3", "done")
    s.board(at(7), "add", "waiting", "Release notes: add rows")
    s.board(at(8), "edit", "4", "--job", "rnm-tryout")
    const r5 = s.report("round5", { status: "running" })
    const reused = s.board(at(9), "job-start", "rnm-tryout", "--report", r5)
    assert.match(reused.stdout, /^4 → doing: Release notes: add rows \(job rnm-tryout\)/)
    assert.doesNotMatch(reused.stderr, /still waits on the user/)
    assert.deepEqual([s.card(4).column, s.card(4).report], ["doing", r5])
    // …unless --title names another task: then it is a new card.
    s.board(at(10), "move", "4", "waiting")
    assert.match(s.board(at(11), "job-start", "rnm-tryout", "--title", "Export fix: second try", "--report", s.report("round6", { status: "running" })).stdout, /^5 → doing/)
    assert.equal(s.card(4).column, "waiting")
  } finally {
    s.done()
  }
})

test("job-start --id (and so job-round) refuses another job's card: a mistyped number moves nothing", () => {
  const s = setup()
  try {
    const fix = s.report("fix", { status: "running" })
    s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", fix)
    s.board(at(1), "job-start", "rnm-add-rows-check3", "--title", "Release notes rows: third check", "--report", s.report("check3", { status: "running" }))
    s.board(at(2), "move", "2", "done")
    const before = s.cards()
    // The replay: card 2 (the third check's, Done) typed for card 1.
    const r = s.run(s.coordEnv, at(3), "job-start", "rnm-add-rows", "--id", "2", "--report", s.report("fix2", { status: "running" }))
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /card 2 is job rnm-add-rows-check3's, not rnm-add-rows's: check the number, or link it first with board\.mjs edit 2 --job rnm-add-rows/)
    assert.deepEqual(s.cards(), before, "neither card changed")
    // The right number works; so does a card with no job yet, and one linked first with edit.
    const fix2 = s.report("fix2b", { status: "running" })
    assert.match(s.board(at(4), "job-start", "rnm-add-rows", "--id", "1", "--report", fix2).stdout, /^1 → doing/)
    s.board(at(5), "add", "todo", "Release notes: sort rows")
    assert.match(s.board(at(6), "job-start", "rnm-sort", "--id", "3").stdout, /^3 → doing: Release notes: sort rows \(job rnm-sort\)/)
    s.board(at(7), "edit", "2", "--job", "rnm-sort")
    assert.match(s.board(at(8), "job-start", "rnm-sort", "--id", "2").stdout, /^2 → doing/)
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

test("a held report run again after the cards under it close is a no-op: never a Done card back to Waiting with the FYI as its question", () => {
  for (const after of ["done", "doing"]) {
    const s = setup()
    try {
      const fix = s.report("fix3", { status: "running" })
      s.board(at(0), "job-start", "rnm-add-rows", "--title", "Release notes: add rows", "--report", fix)
      s.board(at(1), "job-start", "rnm-add-rows-check4", "--title", "Release notes rows: check", "--parent", "1", "--report", s.report("check4", { status: "running" }))
      s.board(at(2), "job-start", "rnm-add-rows-check5", "--title", "Release notes rows: fifth check", "--parent", "1", "--report", s.report("check5", { status: "running" }))
      // The round's report lands while both checks are open, its needs_user an FYI: held in Doing.
      writeFileSync(fix, JSON.stringify({ status: "done", summary: "Fixed the sort order.", needs_user: ["FYI: a stray empty test row is still in production."], notes: ["The check will look at it."] }))
      assert.match(s.board(at(3), "job-report", "rnm-add-rows", "--if-final").stdout, /^1 stays in Doing: Release notes: add rows \(it waits on #2, #3;/)
      assert.deepEqual([s.card(1).column, s.card(1).ask], ["doing", ""])
      const notes = () => unacked(s.file, { workspace: "w1" }).filter((m) => m.kind === "note").length
      assert.equal(notes(), 1)
      // The checks close; the coordinator moves the card to Done (or leaves it in Doing).
      s.board(at(4), "move", "2", "done")
      s.board(at(5), "move", "3", "done")
      if (after === "done") s.board(at(6), "move", "1", "done")
      const settled = s.card(1)
      // A restarted wait, a --once check or the follower runs the same report again.
      assert.equal(s.board(at(7), "job-report", "rnm-add-rows", "--if-final").stdout, "", `${after}: quiet`)
      assert.match(s.board(at(8), "job-report", "rnm-add-rows").stdout, new RegExp(`^1 unchanged \\(${after}\\): Release notes: add rows`))
      assert.deepEqual(s.card(1), settled, `${after}: the card is as the coordinator left it`)
      assert.equal(s.card(1).ask, "", `${after}: the FYI never becomes the question`)
      assert.equal(notes(), 1, `${after}: no new note`)
      // A rewritten report still applies (the round's real end).
      writeFileSync(fix, JSON.stringify({ status: "done", summary: "Fixed the sort order; the stray row is gone." }))
      s.board(at(9), "job-report", "rnm-add-rows")
      assert.equal(s.card(1).column, "done")
    } finally {
      s.done()
    }
  }
})

test("a final report rewritten after it was applied tells the coordinator, even when the card stays Done; a new round's first report doesn't", () => {
  const s = setup({ slug: "review" })
  try {
    const path = s.report("review", { status: "done", summary: "Ready: no problems found." })
    s.board(at(0), "job-start", "review", "--title", "Release notes review: findings", "--report", path)
    s.board(at(1), "job-report", "review", "--if-final")
    assert.equal(s.card(1).column, "done")
    const notes = () => unacked(s.file, { workspace: "w1" }).filter((m) => m.kind === "note")
    assert.equal(notes().length, 0, "a plain done needs no note")
    // The replay: the job rewrites it with the real verdict, still done with nothing for the user.
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fix first: the Inspector crashes on an empty row." }))
    const r = s.run(s.coordEnv, at(19), "job-report", "review", "--if-final")
    assert.equal(r.status, 0, r.stderr)
    assert.equal(s.card(1).column, "done")
    assert.equal(notes().length, 1)
    assert.match(notes()[0].text, /^\[job note\] review — card 1 \(Release notes review: findings\): the job rewrote its final report after it was applied; the card is done on the new one\. Its summary now: Fix first: the Inspector crashes on an empty row\. Read the report again/)
    assert.equal(notes()[0].workspace, "w1")
    // Run again: nothing new.
    s.board(at(20), "job-report", "review")
    assert.equal(notes().length, 1)
    // Rewritten into a question: one note, saying both.
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fix first: the Inspector crashes.", needs_user: ["Fix the Inspector crash before release?"] }))
    s.board(at(21), "job-report", "review")
    assert.equal(notes().length, 2)
    assert.match(notes()[1].text, /rewrote its final report .* the card is waiting on you on the new one\. .* is waiting on the user with the job's own words/)
    // A new round on the card (job-start --id, a new report): its first report is no rewrite.
    s.board(at(22), "move", "1", "done")
    const r2 = s.report("review-2", { status: "running" })
    s.board(at(23), "job-start", "review", "--id", "1", "--report", r2)
    writeFileSync(r2, JSON.stringify({ status: "done", summary: "Second pass: clean." }))
    s.board(at(24), "job-report", "review")
    assert.equal(s.card(1).column, "done")
    assert.equal(notes().length, 2, "no rewrite note for a new round's report")
  } finally {
    s.done()
  }
})

test("a job's message finds an old Done card only while it is recent: a slug used again later without a card isn't sent the old card's owner", () => {
  const now = new Date(T0)
  const card = (updated) => ({ id: 7, job: "review", column: "done", workspace: "w1", origin: COORD, report: "/x/review.json", updated })
  const recent = new Date(now - JOB_CARD_RECENT_MS + 60_000).toISOString()
  const old = new Date(now - JOB_CARD_RECENT_MS - 60_000).toISOString()
  assert.equal(jobCard({ items: [card(recent)] }, "review", "w8", now)?.id, 7, "this run's card, Done before its stop")
  assert.equal(jobCard({ items: [card(old)] }, "review", "w8", now), null, "last week's card")
  assert.equal(jobCard({ items: [{ ...card(old), column: "doing" }] }, "review", "w8", now)?.id, 7, "an open card, however old")
  assert.equal(jobCard({ items: [card("")] }, "review", "w8", now), null, "no time: not recent")
  // Through the hook: a stop with only an old Done card goes to the job's workspace, without that
  // card's report.
  const s = setup({ slug: "review" })
  try {
    const path = s.report("review-old", { status: "done", summary: "Last week's verdict." })
    s.board(at(0), "job-start", "review", "--title", "Release notes review: findings", "--report", path)
    s.board(at(1), "job-report", "review")
    const later = at(1 + 2 * 24 * 60)
    const hook = spawnSync(process.execPath, [HOOK], { cwd: s.base, env: { ...s.workerEnv, JOB_BOARD_NOW: later.toISOString() }, input: JSON.stringify({ hook_event_name: "Stop", session_id: "w2", cwd: s.base, stop_hook_active: false, last_assistant_message: "Started." }), encoding: "utf8" })
    assert.equal(hook.status, 0, hook.stderr)
    return until(() => readInbox(s.file).messages.length === 1).then(() => {
      const [m] = readInbox(s.file).messages
      assert.doesNotMatch(m.text, /Last week's verdict/)
      assert.equal(m.workspace, "w8")
      assert.notEqual(m.card, 1)
    }).finally(() => s.done())
  } catch (e) {
    s.done()
    throw e
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
