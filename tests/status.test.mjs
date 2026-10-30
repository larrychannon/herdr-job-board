// Run: node --test (from the repo root)
// Status lines (0.13.0): `now <ref> "<text>"` on a card and its family (--only: the card alone),
// --event, the wording check, job-report's own line and its "job report" event, a card under a
// parent done, "out of date" on the card, its row and its details, the turn reminder, and the
// Stop hook's block once per card and event for the cards this pane owns.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, detailLines, familyOf, readBoard, render, reportStatusLine, statusProblems, statusStale } from "../board.mjs"
import { handle, staleReminder } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = "w1:p1"

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-status-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = (now) => ({ ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" })
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
  const ok = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const file = join(state, "board.json")
  const items = () => readBoard(file).items
  const item = (id) => items().find((i) => i.id === id)
  // Cards written outside Herdr have no owner pane; the hook tests need one.
  const own = (...ids) => {
    const s = JSON.parse(readFileSync(file, "utf8"))
    for (const i of s.items) if (ids.includes(i.id)) i.origin = PANE
    writeFileSync(file, JSON.stringify(s))
  }
  return { base, state, file, run, ok, items, item, own, done: () => rmSync(base, { recursive: true, force: true }) }
}

/** 1 Login fix ← 2 review, 3 docs; 4 apart. */
function family(t) {
  t.ok("2026-10-30T10:00:00Z", "add", "doing", "Login fix: build", "--desc", "Fix the login page.")
  t.ok("2026-10-30T10:00:00Z", "add", "doing", "Login fix review: check", "--parent", "1", "--job", "rev", "--desc", "A fresh review.")
  t.ok("2026-10-30T10:00:00Z", "add", "todo", "Login fix docs: write", "--parent", "1", "--desc", "The help page.")
  t.ok("2026-10-30T10:00:00Z", "add", "todo", "Export to CSV", "--desc", "Another thing.")
}

test("now: written on the card and its open family; --only the card alone; --clear; another family untouched", () => {
  const t = setup()
  try {
    family(t)
    const out = t.ok("2026-10-30T10:01:00Z", "now", "2", "built, the review is running")
    assert.match(out, /^2 now: built, the review is running \(also #1, #3\)/)
    for (const id of [1, 2, 3]) assert.equal(t.item(id).now.text, "built, the review is running")
    assert.equal(t.item(4).now, undefined)
    t.ok("2026-10-30T10:02:00Z", "now", "3", "waiting for the review first", "--only")
    assert.equal(t.item(3).now.text, "waiting for the review first")
    assert.equal(t.item(1).now.text, "built, the review is running")
    t.ok("2026-10-30T10:03:00Z", "now", "3", "--clear", "--only")
    assert.equal(t.item(3).now, undefined)
    assert.deepEqual(familyOf(readBoard(t.file), t.item(3)).map((i) => i.id).sort(), [1, 2, 3])
    // Bad use writes nothing.
    assert.equal(t.run("2026-10-30T10:04:00Z", "now", "1").status, 2)
    assert.equal(t.run("2026-10-30T10:04:00Z", "now", "1", "x", "--event", "Merged #12").status, 2)
  } finally {
    t.done()
  }
})

test("now: the wording check refuses numbers (nothing written); --allow-wording; the generated lines pass", () => {
  const t = setup()
  try {
    family(t)
    const r = t.run("2026-10-30T10:01:00Z", "now", "1", "PR 12 merged, build 340 live")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /status line says "PR 12", a PR number/)
    assert.equal(t.item(1).now, undefined)
    t.ok("2026-10-30T10:01:00Z", "now", "1", "PR 12 merged", "--allow-wording", "--only")
    assert.equal(t.item(1).now.text, "PR 12 merged")
    for (const status of ["done", "blocked", "failed"]) for (const column of ["done", "waiting"]) for (const held of [false, true]) assert.deepEqual(statusProblems(reportStatusLine(status, column, held)), [])
  } finally {
    t.done()
  }
})

test("stale: a job report, a card under it done, and an --event put older family lines out of date; writing again clears it", () => {
  const t = setup()
  try {
    family(t)
    t.ok("2026-10-30T10:01:00Z", "now", "1", "built, the review is running")
    for (const id of [1, 2, 3]) assert.equal(statusStale(t.item(id)), false)
    const report = join(t.base, "rev.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "No problems found." }))
    t.ok("2026-10-30T10:05:00Z", "job-report", "rev", report)
    // The reviewed card is Done with its own fresh line; its family's lines are out of date.
    assert.equal(t.item(2).column, "done")
    assert.equal(t.item(2).now.text, "the job finished: its report is ready to check")
    assert.equal(statusStale(t.item(1)), true)
    assert.equal(statusStale(t.item(3)), true)
    assert.equal(statusStale(t.item(2)), false, "a Done card is never stale")
    assert.equal(t.item(1).event.kind, "job report")
    t.ok("2026-10-30T10:06:00Z", "now", "1", "reviewed, ready to merge")
    assert.equal(statusStale(t.item(1)), false)
    assert.equal(statusStale(t.item(3)), false)
    // A card under it done (by hand).
    t.ok("2026-10-30T10:07:00Z", "done", "3")
    assert.equal(statusStale(t.item(1)), true)
    assert.equal(t.item(1).event.kind, "card done")
    // --event with --only: the card is fresh, the rest of the family is not.
    t.ok("2026-10-30T10:08:00Z", "add", "todo", "Login fix deploy: run", "--parent", "1", "--desc", "Deploy it.")
    t.ok("2026-10-30T10:08:30Z", "now", "5", "waiting for the merge", "--only")
    t.ok("2026-10-30T10:09:00Z", "now", "1", "merged, waiting for your deploy OK", "--event", "merge", "--only")
    assert.equal(statusStale(t.item(1)), false)
    assert.equal(statusStale(t.item(5)), true)
    // Without --only the family gets it, and nothing is stale.
    t.ok("2026-10-30T10:10:00Z", "now", "1", "deploying", "--event", "deploy")
    assert.equal(statusStale(t.item(5)), false)
    assert.equal(t.item(5).now.text, "deploying")
    // A card with no line, or a card outside the family, is never stale.
    assert.equal(statusStale(t.item(4)), false)
  } finally {
    t.done()
  }
})

test("view: the line on top of the card, 'out of date' in its row, card and details", () => {
  const t = setup()
  try {
    family(t)
    t.ok("2026-10-30T10:01:00Z", "now", "1", "built, the review is running")
    t.ok("2026-10-30T10:02:00Z", "done", "3")
    const now = new Date("2026-10-30T10:03:00Z")
    const view = buildView(readBoard(t.file), null, { now })
    const one = view.doing.find((e) => e.id === 1)
    assert.equal(one.stale, true)
    const text = detailLines(one, 80, { now }).lines.map((l) => l.map((s) => s.t ?? "").join("")).join("\n")
    assert.match(text, /Now \(out of date: card done on #3 since\): built, the review is running/)
    const wide = render(view, { width: 130, height: 30, color: false, now })
    assert.match(wide, /Now \(out of date: card done on #3 since\):/)
    const inbox = render(view, { width: 90, height: 30, color: false, now })
    assert.match(inbox, /^\s+1\s+Login fix: build\s+(?:status out of date|waiting on 1)/m)
    // Fresh: plain "Now:".
    t.ok("2026-10-30T10:04:00Z", "now", "1", "reviewed, ready to merge")
    const fresh = buildView(readBoard(t.file), null, { now })
    const d = detailLines(fresh.doing.find((e) => e.id === 1), 80, { now }).lines.map((l) => l.map((s) => s.t ?? "").join("")).join("\n")
    assert.match(d, /\n {2}Now: reviewed, ready to merge/)
  } finally {
    t.done()
  }
})

test("hooks: the reminder lists stale cards; Stop blocks once per card and event for this pane's own cards only", () => {
  const t = setup()
  try {
    family(t)
    t.ok("2026-10-30T10:01:00Z", "now", "1", "built, the review is running")
    t.own(1)
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: PANE, JOB_BOARD_HOME: t.state, HOME: join(t.base, ".git", "home") }
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.base, prompt: "hi" }
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: t.base, stop_hook_active: false, last_assistant_message: "Done. Tests pass." }
    handle(prompt, env)
    assert.equal(handle(stop, env).stdout, "", "nothing is stale yet")
    t.ok("2026-10-30T10:02:00Z", "done", "3")
    assert.match(staleReminder(readBoard(t.file)), /#1 "Login fix: build" \(card done on #3 since\)/)
    const ctx = JSON.parse(handle(prompt, env).stdout).hookSpecificOutput.additionalContext
    assert.match(ctx, /status lines out of date/)
    const first = JSON.parse(handle(stop, env).stdout)
    assert.equal(first.decision, "block")
    assert.match(first.reason, /#1 "Login fix: build"/)
    assert.doesNotMatch(first.reason, /#2 /, "card 2 is stale too, but not this pane's")
    // Once per card and event: the next stop passes, in this turn and the next.
    assert.equal(handle(stop, env).stdout, "")
    handle(prompt, env)
    assert.equal(handle(stop, env).stdout, "")
    assert.equal(handle({ ...stop, stop_hook_active: true }, env).stdout, "")
    // A new event: blocks once more. Another pane: never.
    t.ok("2026-10-30T10:03:00Z", "add", "todo", "Login fix deploy: run", "--parent", "1", "--desc", "Deploy it.")
    t.ok("2026-10-30T10:04:00Z", "done", "5")
    assert.equal(JSON.parse(handle(stop, env).stdout).decision, "block")
    t.ok("2026-10-30T10:05:00Z", "done", "2")
    assert.equal(handle(stop, { ...env, HERDR_PANE_ID: "w1:p9" }).stdout, "")
    // Written again: nothing to block.
    t.ok("2026-10-30T10:06:00Z", "now", "1", "reviewed, ready to merge")
    assert.equal(handle({ ...stop, session_id: "s2" }, env).stdout, "")
    assert.equal(staleReminder(readBoard(t.file)), "")
  } finally {
    t.done()
  }
})

test("hooks: the Waiting-card block comes first; a status line write is not a Waiting card update", () => {
  const t = setup()
  try {
    t.ok("2026-10-30T10:00:00Z", "add", "waiting", "Login fix: merge", "--desc", "Ready.", "--ask", "Merge the login fix now?", "--option", "Merge the login fix", "--option", "Wait for the review", "--suggest", "Merge the login fix")
    t.own(1)
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: PANE, JOB_BOARD_HOME: t.state, HOME: join(t.base, ".git", "home") }
    handle({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.base, prompt: "hi" }, env)
    t.ok("2026-10-30T10:01:00Z", "now", "1", "reviewed, ready to merge")
    const r = JSON.parse(handle({ hook_event_name: "Stop", session_id: "s1", cwd: t.base, stop_hook_active: false, last_assistant_message: "Merge it now?" }, env).stdout)
    assert.equal(r.decision, "block")
    assert.match(r.reason, /no Waiting card was added or updated/)
  } finally {
    t.done()
  }
})
