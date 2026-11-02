// Run: node --test (from the repo root)
// A card's "where it stands" is never lost, cut or hidden silently (0.17.0, round two):
// - a Now line a person gave in --desc is the card's status line until something else writes
//   that line (job-open's "a job is working on it", job-report, not-run, a parent's line, now on
//   the card); then it stays on the card, at the end of its description as "Earlier: …";
// - a card from before (its Now line still in its stored description) keeps it there on an edit,
//   a move and a job-start that give no --desc: it is shown at the top, and moved only by a --desc;
// - a Now line over a status line's 200 characters, a second Now line and one that leads into
//   what follows (ends with ":") stay in the description, whole; nothing is cut when read;
// - a Done card keeps its Now line in its description, where a Done card shows it;
// - the Queue's safety check reads the status line too.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, copyPayload, markStart, readBoard } from "../board.mjs"
import { needsYes, queueReason } from "../hooks/board-hook.mjs"

const BOARD = join(fileURLToPath(new URL("../", import.meta.url)), "board.mjs")
const T = "2026-11-02T10:00:00Z"
const LATER = "2026-11-02T11:00:00Z"
const LAST = "2026-11-02T12:00:00Z"

// A Now paragraph like card 318's on the live board: over 200 characters.
const PARA =
  "phase 1 is done and checked; phase 4's first step waits on two answers from the account team, and the mail check needs one more look before it can run on its own every morning, because the Gmail needs a fresh sign-in to check. The rest of phase 4 waits for their answers; phases 2-3 don't."

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-now-kept-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = (now) => {
    const e = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" }
    delete e.JOB_AGENT_ROLE
    return e
  }
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
  const ok = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(state, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  const raw = () => JSON.parse(readFileSync(file, "utf8"))
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex")
  /** Rewrite card `id` in the file by hand, as an older board left it. */
  const patch = (id, fn) => {
    const s = raw()
    fn(s.items.find((i) => i.id === id))
    writeFileSync(file, JSON.stringify(s))
  }
  /** Everything card `id` shows: its view entry's status line, description, ask, as one text (and its copy text). */
  const shown = (id, now = LAST) => {
    const v = buildView(readBoard(file), [], { now: new Date(now), doneDays: 30 })
    const entry = [...v.waiting, ...v.doing, ...v.queue, ...v.todo, ...v.doneToday].find((e) => e.id === id)
    assert.ok(entry, `card ${id} is on the board`)
    return copyPayload(entry).text
  }
  return { base, state, home, file, env, run, ok, item, raw, hash, patch, shown, done: () => rmSync(base, { recursive: true, force: true }) }
}

const report = (t, name, body) => {
  const path = join(t.base, `${name}.json`)
  writeFileSync(path, JSON.stringify(body))
  return path
}

// --- finding 1: nothing a person wrote is replaced without being kept ------------------------------

test("card 318's shape: job-start --id and job-open's line keep an older card's Now paragraph on the card, whole", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "SFC integration: phase 2", "--desc", "Four phases, in order.")
    // As the board left it before 0.17.0: the Now paragraph in the description, no status line.
    t.patch(1, (i) => (i.desc = `Four phases, in order.\n\nNow: ${PARA}`))
    assert.ok(PARA.length > 200)
    // The two board calls job-open makes.
    t.ok(LATER, "job-start", "sfc-phase2", "--id", "1")
    assert.match(t.item(1).desc, new RegExp(`Now: ${PARA.slice(0, 60)}`), "job-start without --desc leaves the description as it is")
    t.ok(LATER, "now", "1", "a job is working on it", "--only")
    const card = t.shown(1)
    assert.ok(card.includes(PARA), card)
    assert.match(card, /Now: a job is working on it/)
  } finally {
    t.done()
  }
})

test("a Now line given in --desc, replaced by job-open's line, job-report, not-run or a parent's line: kept as 'Earlier:'", () => {
  const t = setup()
  try {
    // job-start with --desc, then job-open's line, then the job's report.
    const path = report(t, "r1", { status: "running", summary: "" })
    t.ok(T, "job-start", "login-fix", "--title", "Login page: fix the redirect", "--desc", "It loops after sign-in.\nNow: the fix is drafted; it needs a check on the old browsers", "--report", path)
    assert.equal(t.item(1).now.text, "the fix is drafted; it needs a check on the old browsers")
    t.ok(T, "now", "1", "a job is working on it", "--only")
    assert.equal(t.item(1).now.text, "a job is working on it")
    assert.equal(t.item(1).desc, "It loops after sign-in.\nEarlier: the fix is drafted; it needs a check on the old browsers")
    // A line nobody gave in --desc is the board's own: replaced, as before.
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fixed the redirect.", needs_user: ["Ship the fix with the release?"] }))
    t.ok(LATER, "job-report", "login-fix", path)
    assert.equal(t.item(1).now.text, "the job finished and needs your answer")
    assert.equal(t.item(1).desc.match(/Earlier:/g).length, 1, t.item(1).desc)

    // job-report straight over a line from --desc.
    const path2 = report(t, "r2", { status: "running", summary: "" })
    t.ok(T, "job-start", "docs-tidy", "--title", "Docs: tidy the old pages", "--desc", "Old pages.\nNow: two pages are left; the job does them", "--report", path2)
    writeFileSync(path2, JSON.stringify({ status: "done", summary: "Tidied the pages.", needs_user: ["Delete the old pages too?"] }))
    t.ok(LATER, "job-report", "docs-tidy", path2)
    assert.equal(t.item(2).desc, "Old pages.\nEarlier: two pages are left; the job does them")
    assert.ok(t.shown(2).includes("two pages are left; the job does them"))

    // not-run on a Waiting card made with a Now line.
    t.ok(T, "add", "waiting", "App: deploy the fix", "--desc", "The fix is merged.\nNow: staging looks right; yes deploys it", "--ask", "Deploy the fix now?", "--option", "Deploy the fix", "--option", "Wait a day", "--suggest", "Deploy the fix")
    t.ok(LATER, "not-run", "3", "--type", "deploy the fix", "--label", "Deploy the fix")
    assert.match(t.item(3).now.text, /couldn't run|type/i)
    assert.equal(t.item(3).desc, "The fix is merged.\nEarlier: staging looks right; yes deploys it")

    // now on a parent, without --only, over a child made with a Now line.
    t.ok(T, "add", "doing", "Login fix: release", "--desc", "Ship the login fix.")
    t.ok(T, "add", "doing", "Login fix: check", "--parent", "4", "--desc", "A fresh check.\nNow: the check runs on the old browsers first")
    t.ok(LATER, "now", "4", "both cards are in progress")
    assert.equal(t.item(5).now.text, "both cards are in progress")
    assert.equal(t.item(5).desc, "A fresh check.\nEarlier: the check runs on the old browsers first")

    // now --clear on it: kept too. A new --desc Now line replaces it: the person's own change.
    t.ok(T, "add", "todo", "Search: build the filters", "--desc", "Filters.\nNow: the design is agreed")
    t.ok(LATER, "edit", "6", "--desc", "Filters.\nNow: the first filter is built")
    assert.equal(t.item(6).desc, "Filters.")
    t.ok(LAST, "now", "6", "--clear")
    assert.equal(t.item(6).now, undefined)
    assert.equal(t.item(6).desc, "Filters.\nEarlier: the first filter is built")
  } finally {
    t.done()
  }
})

// --- finding 2: no cut ------------------------------------------------------------------------

test("a Now line over 200 characters is never cut: in --desc it stays in the description, whole; an older card's is shown whole and kept on its next edit", () => {
  const t = setup()
  try {
    const long = `the fix is ready ${"and checked again ".repeat(15)}`.trim()
    assert.ok(long.length > 200)
    const r = t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", `It loops.\nNow: ${long}`)
    assert.match(r.stderr, /card 1: its Now line is longer than 200 characters/)
    assert.match(r.stderr, /kept in the description/)
    assert.equal(t.item(1).desc, `It loops.\nNow: ${long}`)
    assert.equal(t.item(1).now, undefined)
    assert.ok(t.shown(1).includes(long))

    // Card 318 on the live board: its long Now line, read, then edited and moved.
    t.ok(T, "add", "todo", "SFC integration: phase 2", "--desc", "Four phases.")
    t.patch(2, (i) => (i.desc = `Four phases.\n\nNow: ${PARA}`))
    assert.ok(t.shown(2).includes(PARA), "shown whole when read")
    t.ok(LATER, "edit", "2", "--title", "SFC integration: phase two")
    t.ok(LATER, "move", "2", "doing")
    assert.equal(t.item(2).desc, `Four phases.\n\nNow: ${PARA}`)
    assert.equal(t.item(2).now, undefined)
    // The now command: a line over 200 is refused, nothing written (it has no description to keep the rest in).
    const before = t.hash()
    const n = t.run(LATER, "now", "2", long)
    assert.equal(n.status, 2, n.stderr)
    assert.match(n.stderr, /longer than 200 characters/)
    assert.equal(t.hash(), before)
  } finally {
    t.done()
  }
})

test("two Now lines, or one that leads into what follows (ends with ':'), stay in the description, nothing dropped", () => {
  const t = setup()
  try {
    const r = t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops.\nNow: the fix is drafted\nNow: the check is next")
    assert.equal(t.item(1).desc, "It loops.\nNow: the fix is drafted\nNow: the check is next")
    assert.equal(t.item(1).now, undefined)
    assert.match(r.stderr, /card 1: its description has 2 Now lines/)
    t.ok(T, "add", "waiting", "Mail check: sign in again", "--desc", "The mail check stopped.\nNow: the sign-in ran out. Type this in my chat (one line, with the !):\n! python3 mail_check.py --login", "--ask", "Sign in again now?", "--option", "Sign in now", "--option", "Wait a day", "--suggest", "Sign in now")
    assert.equal(t.item(2).desc, "The mail check stopped.\nNow: the sign-in ran out. Type this in my chat (one line, with the !):\n! python3 mail_check.py --login")
    assert.equal(t.item(2).now, undefined)
  } finally {
    t.done()
  }
})

// --- finding 3: a Done card shows its Now line ----------------------------------------------------

test("a Now line given to a Done card stays in its description, where a Done card shows it; a status line from --desc goes back there when the card is done", () => {
  const t = setup()
  try {
    t.ok(T, "add", "doing", "Login page: fix the redirect", "--desc", "It loops.")
    t.ok(LATER, "move", "1", "done", "--desc", "Fixed the login page.\nNow: merged and installed; the old page is gone")
    assert.equal(t.item(1).desc, "Fixed the login page.\nNow: merged and installed; the old page is gone")
    assert.ok(t.shown(1).includes("merged and installed; the old page is gone"))
    t.ok(LATER, "edit", "1", "--desc", "Fixed the login page.\nNow: merged, installed and checked")
    assert.ok(t.shown(1).includes("merged, installed and checked"))

    // A card whose status line came from --desc, then done: the line goes back into its description.
    t.ok(T, "add", "doing", "Docs: tidy the old pages", "--desc", "Old pages.\nNow: the last page is done; nothing is left")
    assert.equal(t.item(2).now.text, "the last page is done; nothing is left")
    t.ok(LATER, "done", "2")
    assert.ok(t.shown(2).includes("the last page is done; nothing is left"))
    assert.equal(t.item(2).desc, "Old pages.\nNow: the last page is done; nothing is left")

    // An older Done card: an edit with no --desc keeps its Now line in its description.
    t.ok(T, "add", "done", "Search: build the filters", "--desc", "Filters.\nNow: shipped in the last release")
    assert.equal(t.item(3).desc, "Filters.\nNow: shipped in the last release")
    t.ok(LATER, "edit", "3")
    t.ok(LATER, "move", "3", "done")
    assert.equal(t.item(3).desc, "Filters.\nNow: shipped in the last release")
  } finally {
    t.done()
  }
})

// --- hidden by a parent's built line ----------------------------------------------------------

test("a parent's Now line from --desc, while its line is built from the cards under it, is still shown in its description", () => {
  const t = setup()
  try {
    t.ok(T, "add", "doing", "Login fix: release", "--desc", "Ship the login fix.\nNow: the fix waits on the check; then it ships with the release")
    t.ok(T, "add", "doing", "Login fix: check", "--parent", "1", "--desc", "A fresh check.")
    const card = t.shown(1)
    assert.match(card, /Now: #2 /, card)
    assert.ok(card.includes("the fix waits on the check; then it ships with the release"), card)
  } finally {
    t.done()
  }
})

// --- older wording allowances and the start mark ---------------------------------------------------

test("a Now line allowed with --allow-wording before 0.17.0 is still allowed when the same --desc is sent again", () => {
  const t = setup()
  try {
    t.ok(T, "add", "doing", "Login page: fix the redirect", "--desc", "It loops.\nNow: PR #83 is open", "--allow-wording")
    // As the old code stored it: the line in the description, allowed as "the description says …".
    t.patch(1, (i) => {
      i.desc = "It loops.\nNow: PR #83 is open"
      delete i.now
      i.wording_ok = (i.wording_ok || []).map((l) => l.replace(/^the status line says/, "the description says"))
    })
    assert.match(t.raw().items[0].wording_ok[0], /^the description says "PR #83"/)
    t.ok(LATER, "edit", "1", "--desc", "It loops.\nNow: PR #83 is open")
    assert.equal(t.item(1).now.text, "PR #83 is open")
  } finally {
    t.done()
  }
})

// --- finding 4: the Queue's safety check reads the status line -------------------------------------

test("the Queue's check reads the status line: a Now line naming a delete or a merge and deploy keeps the card a question", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Old log cleanup: build", "--desc", "Tidy the old job logs.\nNow: the script is ready; it deletes the old records from the users table")
    t.ok(T, "add", "todo", "Search: build the filters", "--desc", "Filters.\nNow: the code is ready; next is the merge and the production deploy")
    assert.ok(t.item(1).now?.text || /Now:/.test(t.item(1).desc))
    for (const id of [1, 2]) markStart(t.file, id, true, new Date(LATER))
    markStart(t.file, 2, false, new Date(LATER))
    const s = readBoard(t.file)
    const room = { name: s.items[0].project, room: 1, max: 2, jobs: [], mb: 8000, min: 2000 }
    // Marked "start without asking": the delete is never covered by the mark.
    const marked = s.items.find((i) => i.id === 1)
    assert.ok(needsYes(marked.title, [marked.desc, marked.now?.text].filter(Boolean).join("\n"), true))
    const r1 = queueReason(s, marked, room, 1, 2)
    assert.match(r1, /which the mark never covers: move it to Waiting/)
    assert.doesNotMatch(r1, /without asking first/)
    // Unmarked: the merge and the production deploy make it a question.
    const r2 = queueReason(s, s.items.find((i) => i.id === 2), room, 1, 2)
    assert.match(r2, /is never started from the Queue: move it to Waiting/)
    assert.doesNotMatch(r2, /Start its job on this card/)
  } finally {
    t.done()
  }
})

test("an edit of something else (--parent) of an older queued card with a Now line in its description keeps the user's 'start without asking'", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Search: build the filters", "--desc", "Filters.")
    t.ok(T, "add", "todo", "Search: the whole feature", "--desc", "All of it.")
    t.patch(1, (i) => (i.desc = "Filters.\nNow: the design is agreed; the job builds the first filter"))
    markStart(t.file, 1, true, new Date(T))
    assert.equal(buildView(readBoard(t.file), [], { now: new Date(T) }).queue[0].startMarked, true)
    t.ok(LATER, "edit", "1", "--parent", "2")
    assert.equal(t.item(1).desc, "Filters.\nNow: the design is agreed; the job builds the first filter")
    assert.equal(buildView(readBoard(t.file), [], { now: new Date(LATER) }).queue[0].startMarked, true)
    // A new Now line given in --desc is a change of its words: the mark ends.
    t.ok(LATER, "edit", "1", "--desc", "Filters.\nNow: the design changed; next is the production deploy")
    assert.equal(buildView(readBoard(t.file), [], { now: new Date(LATER) }).queue[0].startMarked, false)
  } finally {
    t.done()
  }
})
