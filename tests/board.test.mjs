// Run: node --test (from the repo root)
// board.mjs (the CLI, the only writer) and board-pane.mjs (the renderer). Herdr is faked by
// fixtures/fake-herdr.mjs; the real one is never called.
import "./guard.mjs"
import { idOrder } from "./id-order.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, reportOutcome, tokenText } from "../board.mjs"

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url))
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))
const BOARD = join(SCRIPTS, "board.mjs")
const PANE = join(SCRIPTS, "board-pane.mjs")
const FAKE_HERDR = join(FIXTURES, "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)

// Each test's store (JOB_BOARD_HOME): in its temp folder, never the user's.
let STATE = ""
function temp() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "job-board-")))
  STATE = join(base, "state")
  mkdirSync(STATE)
  return { base, done: () => rmSync(base, { recursive: true, force: true }) }
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=test", ...args], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function repo(base, name = "app") {
  const dir = join(base, name)
  mkdirSync(dir)
  git(dir, "init", "-q", "-b", "main")
  git(dir, "commit", "-q", "--allow-empty", "-m", "init")
  return dir
}

/** The env for a run: no real Herdr unless a fake state file is given. */
function envFor({ herdr = null, now = "2026-10-13T10:30:00Z", extra = {} } = {}) {
  // HOME too: nothing a test runs may look at the user's repos or boards.
  const env = { ...process.env, TZ: "UTC", JOB_BOARD_NOW: now, NO_COLOR: "1", JOB_BOARD_HOME: STATE, HOME: join(STATE, "..", "home"), ...extra }
  for (const key of ["JOB_BOARD_FILE", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT", "JOB_AGENT_ROLE"]) if (!(key in extra)) delete env[key]
  if (herdr) Object.assign(env, { HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", HERDR_PANE_ID: "w9:p1" }, extra)
  else Object.assign(env, { HERDR_ENV: "0", HERDR_WORKSPACE_ID: "", HERDR_PANE_ID: "" })
  return env
}

function board(cwd, args, opts = {}) {
  return spawnSync(process.execPath, [BOARD, ...args], { cwd, env: envFor(opts), encoding: "utf8" })
}

function ok(cwd, args, opts) {
  const r = board(cwd, args, opts)
  assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
  return r.stdout
}

// One board for every repo: the store.
const fileOf = () => join(STATE, "board.json")
const items = (dir) => JSON.parse(readFileSync(fileOf(dir), "utf8")).items
const fakeHerdr = (base, state) => {
  const path = join(base, "herdr.json")
  writeFileSync(path, JSON.stringify(state))
  return path
}
const herdrLog = (path) => JSON.parse(readFileSync(path, "utf8")).log

test("board: add, move, edit, done and rm; one board per repo, shared by its worktrees, never committed", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const wt = join(base, "app-wt-a")
    git(dir, "worktree", "add", "-q", wt, "-b", "feat/a")

    assert.match(ok(dir, ["add", "todo", "Build the range control", "--desc", "after the mockup"]), /^added 1 \(to do\): Build the range control/)
    assert.match(ok(wt, ["add", "waiting", "Merge #12?", "--ask", "merge PR #12 after a look at :3000"]), /^added 2 \(waiting on you\)/)
    assert.equal(ok(wt, ["path"]).trim(), fileOf(dir))
    assert.deepEqual(items(dir).map((i) => [i.id, i.column, i.title]), [
      [1, "todo", "Build the range control"],
      [2, "waiting", "Merge #12?"],
    ])
    assert.equal(items(dir)[1].ask, "merge PR #12 after a look at :3000")

    ok(dir, ["move", "1", "doing"])
    ok(dir, ["edit", "1", "--desc", "on #12", "--job", "range"])
    assert.match(ok(dir, ["done", "2"]), /2 → done: Merge #12\?/)
    let [one, two] = items(dir)
    assert.deepEqual([one.column, one.desc, one.job], ["doing", "on #12", "range"])
    assert.deepEqual([two.column, two.ask], ["done", ""], "a done item has no open question")
    // A job slug works as a reference too.
    ok(dir, ["move", "range", "todo"])
    assert.equal(items(dir)[0].column, "todo")
    ok(dir, ["rm", "1"])
    assert.deepEqual(items(dir).map((i) => i.id), [2])
    assert.equal(ok(dir, ["add", "todo", "next"]).match(/added (\d+)/)[1], "3", "ids are never reused")

    assert.equal(git(dir, "status", "--porcelain"), "", "the board lives in the store, not the work tree")
    assert.equal(board(dir, ["add", "later", "x"]).status, 2)
    assert.match(board(dir, ["move", "42", "done"]).stderr, /no item 42/)
    assert.equal(board(dir, ["move", "42", "done"]).status, 1)
    assert.equal(board(dir, ["add", "todo", "x", "--bogus", "y"]).status, 2)
    assert.equal(board(base, ["ls"]).status, 0, "outside a repo too: one board for every project")
  } finally {
    done()
  }
})

test("board: concurrent writers lose nothing", async () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const writers = 8
    const each = 6
    const runs = []
    for (let w = 0; w < writers; w++) {
      const script = `for i in $(seq 1 ${each}); do node '${BOARD}' add todo "writer ${w} item $i" >/dev/null || exit 1; done`
      runs.push(
        new Promise((resolve) => {
          const child = spawn("bash", ["-c", script], { cwd: dir, env: envFor() })
          child.on("exit", resolve)
        }),
      )
    }
    assert.deepEqual(await Promise.all(runs), Array(writers).fill(0))
    const all = items(dir)
    assert.equal(all.length, writers * each)
    assert.deepEqual(all.map((i) => i.id).sort((a, b) => a - b), Array.from({ length: writers * each }, (_, i) => i + 1))
    assert.equal(new Set(all.map((i) => i.title)).size, writers * each)
    assert.deepEqual(readdirSync(STATE).filter((f) => f.startsWith("board.json.")), [], "no lock or temp file left")
  } finally {
    done()
  }
})

/** The demo board: a small team's day, with fixed times. */
function seedDemo(dir) {
  const add = (args, now) => ok(dir, args, { now })
  const waiting = [
    ["Login page redesign: approve", "New sign-in screen with SSO buttons and a clearer error message. 3 small choices to confirm.", "Open the mockup, reply ok or change", "08:10"],
    ["Search filters mockup: approve", "Filter panel for the search page with saved filters. 4 choices, e.g. whether saved filters are per user.", "Reply ok or change", "09:00"],
    ["Billing fix (PR #12): review", "Invoices now round each line, not the total. Fixes the one-cent differences customers reported.", "Try the invoice page on :3000, then say merge", "09:40"],
    ["Docs move (PR #14): merge", "The docs move to the shared site. No content changes.", "Say merge (after #12)", "09:45"],
    ["Deploy v1.4: go", "After #12 and #14 merge: tag v1.4 and deploy it to production.", "Say go once merged", "10:00"],
  ]
  for (const [title, desc, ask, at] of waiting) add(["add", "waiting", title, "--desc", desc, "--ask", ask], `2026-10-13T${at}:00Z`)
  add(["edit", "5", "--option", "Go", "--option", "Not now", "--suggest", "Go"], "2026-10-13T10:00:00Z")
  add(["job-start", "search-ui", "--title", "Search filters: build", "--desc", "The filter panel from the approved mockup, with saved filters per user."], "2026-10-13T10:05:00Z")
  add(["job-start", "docs-links", "--title", "Docs site: fix broken links", "--desc", "Check every link on the new docs site and fix the ones that 404."], "2026-10-13T10:28:00Z")
  const todo = [
    ["Export to CSV", "Let people download any table as CSV. Three customers asked for it."],
    ["Dark mode", "Follow the system theme. The colour tokens are already in place."],
    ["Pick next: onboarding or settings", "From the roadmap: an onboarding tour or a new settings page. You pick."],
    ["Upgrade the test runner", "The current version reaches end of life next month."],
  ]
  for (const [title, desc] of todo) add(["add", "todo", title, "--desc", desc], "2026-10-13T10:29:00Z")
  add(["add", "todo", "Nightly backup check"], "2026-10-13T07:00:00Z")
  add(["done", "12"], "2026-10-13T07:30:00Z")
  idOrder(join(STATE, "board.json"))
}

const agent = (name, status, workspace = "w9") => ({ name, agent_status: status, workspace_id: workspace, pane_id: `${workspace}:p${name.length}` })

test("board-pane: wide from 120 (Waiting on top, Doing | To do below); the inbox at 88, compact at 60; Done folded to one line (snapshots)", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base, "my-app")
    seedDemo(dir)
    const herdr = fakeHerdr(base, { agents: [agent("search-ui", "working"), agent("docs-links", "working")] })
    const frame = (width, height, cwd = dir, keys = "") => {
      const r = spawnSync(process.execPath, [PANE, "--once", "--width", String(width), "--height", String(height), "--keys", keys], { cwd, env: envFor({ herdr }), encoding: "utf8" })
      assert.equal(r.status, 0, r.stderr)
      const lines = r.stdout.replace(/\n$/, "").split("\n")
      assert.ok(lines.every((l) => [...l].length <= width), `no line wider than ${width}`)
      assert.equal(lines.length, height, `exactly ${height} lines`)
      assert.equal(lines.at(-1), width >= 82 ? "Tab section · ↑↓ card · Enter details · c copy · d done · m mouse: board · q quit" : "Tab · ↑↓ · Space peek · Enter · c copy · d done · q", "the key hint is the last line")
      return r.stdout
    }
    // 88 is the board's 30% of a full-screen Herdr tab.
    for (const [width, height] of [[120, 40], [88, 40], [60, 30]]) {
      const text = frame(width, height)
      const snap = join(FIXTURES, `board-${width}x${height}.txt`)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, text)
      assert.equal(text, readFileSync(snap, "utf8"), `snapshot ${snap} (UPDATE_SNAPSHOTS=1 to rewrite)`)
      // Done is folded to one line: at the bottom of the lower area, just above the key hint, in
      // the wide layout; right after the last section in the inbox and compact.
      if (width >= 120) assert.equal(text.split("\n").at(-3), "DONE · 1 today ▸")
      else assert.match(text, /\n 11   Upgrade the test runner +1 min\n(?:\n)?DONE · 1 today ▸\n/)
      assert.doesNotMatch(text, /Nightly backup check|DONE \(/)
      // d opens it: today's cards, with the time they finished.
      const open = frame(width, height, dir, "d")
      assert.match(open, /DONE \(1\) ▾[\s\S]*12 (?:✓ )?Nightly backup check/, "Done: today's cards")
      assert.match(open, /\b07:30\b/, "with the time they finished")
      assert.doesNotMatch(open, /DONE · /)
    }
    assert.match(frame(120, 40), /\[ Go ✓ \]  \[ Not now \]  \[ Other… \]/, "answer buttons")
    // Waiting doesn't fit at 120 x 25: it scrolls, says how many cards are below, and leaves the
    // bottom half for the other sections.
    const wide = frame(120, 25).split("\n")
    const more = wide.findIndex((l) => /^↓ \d+ more$/.test(l))
    const bottom = wide.findIndex((l) => l.startsWith("DOING (2)"))
    assert.ok(more > 0 && more < bottom, "a ↓ marker at the end of Waiting")
    assert.ok(bottom <= 14, `Waiting takes about half the height (Doing starts on line ${bottom + 1})`)
    // G scrolls Waiting to its end: the last card, its buttons, and how many cards are above.
    const end = frame(120, 25, dir, "G")
    assert.match(end, /^↑ 4 above$/m)
    assert.match(end, /5▸Deploy v1\.4: go[\s\S]*\[ Go ✓ \]  \[ Not now \]  \[ Other… \]/)
    assert.doesNotMatch(end.split("DOING")[0], /↓ \d+ more/)

    // The inbox at 88 x 40: every card on one row, all of them in view; the selected one open
    // under its row (description, question, buttons), with the headline count on top.
    const inbox = frame(88, 40)
    assert.match(inbox, /^Job board · all projects · 5 need you +10:30$/m)
    assert.match(inbox, /^▸ 1 ! Login page redesign: approve +2 h 20 min\n {6}New sign-in screen/m)
    for (const id of [2, 3, 4, 5]) assert.match(inbox, new RegExp(`^ {2}${id} ! .+ (min|h)$`, "m"), `card ${id} on one row`)
    assert.doesNotMatch(inbox, /↓ \d+ more|↑ \d+ above/, "nothing out of view")
    // G: the last card is selected and open, with its buttons.
    assert.match(frame(88, 40, dir, "G"), /^▸ 5 ! Deploy v1\.4: go +30 min\n(?: {6}.*\n)* {6}\[ Go ✓ \]  \[ Not now \]  \[ Other… \]/m)

    // With nothing waiting, Waiting is one line and the rest goes to the bottom (another
    // store, JOB_BOARD_HOME, so the board has only this card).
    STATE = join(base, "calm-state")
    mkdirSync(STATE)
    const calm = repo(base, "calm")
    ok(calm, ["add", "todo", "Export to CSV", "--desc", "Let people download any table as CSV."])
    const quiet = frame(120, 30, calm).split("\n")
    assert.equal(quiet[2], "▸ WAITING ON YOU (0)  Nothing needs you")
    assert.equal(quiet[3], "")
    // Doing with nothing in it folds to its header, and To do has the width.
    assert.equal(quiet[4], "DOING (0) · nothing running")
    assert.equal(quiet[5], "")
    assert.match(quiet[6], /^TO DO \(1\)$/)
    assert.equal(quiet.at(-3), "DONE · 0 today ▸", "at the bottom, above the key hint")
    // The inbox folds every empty section to its header, with a rule.
    const calmInbox = frame(88, 30, calm).split("\n")
    assert.deepEqual(
      calmInbox.slice(2, 10).map((l) => l.replace(/ ─+$/, " ─")),
      ["▸ WAITING ON YOU (0)  Nothing needs you ─", "", "DOING (0) · nothing running ─", "", "TO DO (1) ─", " 1   Export to CSV                                                              just now", "", "DONE · 0 today ▸"],
    )
  } finally {
    done()
  }
})

test("board ls: everything, with Done open: today's finished cards and their times, not older ones", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["add", "todo", "Yesterday's thing"], { now: "2026-10-12T09:00:00Z" })
    ok(dir, ["done", "1"], { now: "2026-10-12T09:30:00Z" })
    ok(dir, ["add", "todo", "Nightly backup check"], { now: "2026-10-13T07:00:00Z" })
    ok(dir, ["done", "2"], { now: "2026-10-13T07:30:00Z" })
    ok(dir, ["add", "todo", "Release notes: draft"], { now: "2026-10-13T08:00:00Z" })
    ok(dir, ["done", "3"], { now: "2026-10-13T09:15:00Z" })
    ok(dir, ["add", "todo", "Export to CSV"])
    for (const width of ["120", "88", "60"]) {
      const text = ok(dir, ["ls", "--width", width])
      assert.match(text, /DONE \(2\)(?: ─+)?$/m, `${width}: Done's header, open (no ▾: there's nothing to click)`)
      assert.doesNotMatch(text, /DONE · /, `${width}: not folded`)
      // Newest first, each with the time it finished (beside it, or under it in a narrow column).
      const newest = text.search(/\b3 (?:✓ )?Release notes: draft\b/)
      assert.ok(newest >= 0 && newest < text.search(/\b2 (?:✓ )?Nightly backup check\b/), `${width}: today's cards, newest first`)
      assert.match(text, /\b09:15\b/)
      assert.match(text, /\b07:30\b/)
      assert.doesNotMatch(text, /Yesterday's thing/, `${width}: today's only`)
      assert.match(text, /Export to CSV/)
    }
  } finally {
    done()
  }
})

test("board ls, piped with no --width (an agent reading it): the wide layout, every card's description", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["add", "todo", "Export to CSV", "--desc", "Let people download any table as CSV."])
    ok(dir, ["add", "waiting", "Deploy: approve", "--desc", "Ships the invoice page.", "--ask", "Say go"])
    const text = ok(dir, ["ls"])
    assert.match(text, /Let people download any table as CSV\./, "a To do card's description")
    assert.match(text, /Ships the invoice page\.\n {2}Needs you: Say go/)
    assert.doesNotMatch(text, / ─{3,}/, "not the inbox's rules")
    assert.match(ok(dir, ["ls", "--width", "95"]), /^TO DO \(1\) ─+$/m, "--width still picks the layout for that width")
  } finally {
    done()
  }
})

test("board: a card shows the title, the description over up to 3 lines, and the ask", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const long = "word ".repeat(60).trim()
    ok(dir, ["add", "waiting", "Deploy v1.4: approve", "--desc", "Ships the new invoice page to production. Needs #12 and #14 merged first.", "--ask", "Say go"])
    ok(dir, ["add", "todo", "Long one", "--desc", long])
    // ls opens every Waiting card under its row (compact at 60 columns) …
    const text = ok(dir, ["ls", "--width", "60"])
    assert.match(text, / 1 ! Deploy v1\.4: approve +just now\n {5}Ships the new invoice page to production\. Needs #12 and\n {5}#14 merged first\.\n {5}Needs you: Say go\n/)
    assert.match(text, /^ 2   Long one +just now$/m, "the others are one row")
    // … and the wide layout shows every card whole.
    const wide = ok(dir, ["ls", "--width", "120"])
    const longLines = wide.split("2 Long one")[1].split("\n").slice(1, 5)
    assert.equal(longLines.filter((l) => l.startsWith("  word")).length, 3, "3 lines of description at most")
    assert.match(longLines[2], /…$/)
    assert.doesNotMatch(wide.split("2 Long one")[0], /…/, "nothing cut when it fits")
  } finally {
    done()
  }
})

test("board: a blocked agent shows under Waiting, even when the board doesn't say so", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["job-start", "search-ui", "--title", "Search filters: build"])
    ok(dir, ["job-start", "review", "--title", "Review PR #31"])
    const herdr = fakeHerdr(base, {
      agents: [
        agent("search-ui", "blocked"),
        agent("review", "working"),
        agent("stray", "blocked"),
        agent("elsewhere", "blocked", "w2"),
        agent("idle-one", "idle"),
      ],
    })
    const text = ok(dir, ["ls", "--width", "60"], { herdr })
    const waiting = text.split("DOING")[0]
    assert.match(text, /WAITING ON YOU \(2\)/)
    assert.match(waiting, /Search filters: build +blocked {2}just now\n\s+blocked: answer it in tab search-ui/)
    assert.match(waiting, /• ! stray +blocked\n\s+blocked: answer it in tab stray/, "a blocked named agent not on the board")
    assert.doesNotMatch(text, /elsewhere|idle-one/, "other workspaces and idle agents stay out")
    assert.match(text, /DOING \(1\) ─+\n 2   Review PR #31 +working {2}just now\n/)
    // The wide layout: cards, the status under the title.
    assert.match(ok(dir, ["ls", "--width", "120"], { herdr }), /2 Review PR #31 +just now[^\n]*\n\s+working/)

    const view = buildView({ items: items(dir) }, null)
    assert.equal(view.counts.waiting, 0, "without Herdr there is no live status")
    assert.equal(view.counts.doing, 2)
  } finally {
    done()
  }
})

test("board: job-start and job-report move a job's item; needs_user becomes the ask", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const report = join(base, "r.json")
    const write = (r) => writeFileSync(report, JSON.stringify(r))
    ok(dir, ["add", "todo", "Build range control"])
    ok(dir, ["job-start", "range", "--id", "1", "--report", report, "--desc", "on #12"])
    assert.deepEqual(items(dir).map((i) => [i.id, i.column, i.job, i.report]), [[1, "doing", "range", report]])

    write({ status: "running", summary: "half way" })
    const running = board(dir, ["job-report", "range"])
    assert.equal(running.status, 1)
    assert.match(running.stderr, /not final/)
    assert.equal(items(dir)[0].column, "doing")

    write({ status: "done", summary: "built", needs_user: ["Review and merge PR #21", "Deploy: ./deploy.sh"] })
    assert.match(ok(dir, ["job-report", "range"]), /1 → waiting on you: Build range control\n {2}ask: Review and merge PR #21\n {2}ask: Deploy/)
    assert.deepEqual([items(dir)[0].column, items(dir)[0].ask], ["waiting", "Review and merge PR #21\nDeploy: ./deploy.sh"])
    assert.match(ok(dir, ["ls", "--width", "60"]), /Needs you: Review and merge PR #21\n {5}Needs you: Deploy: \.\/deploy\.sh\n/)

    // A follow-up run of the same job gets its own item; the open question stays in Waiting.
    ok(dir, ["job-start", "range", "--title", "Range control: fixes", "--report", report])
    assert.deepEqual(items(dir).map((i) => [i.id, i.column]), [[1, "waiting"], [2, "doing"]])
    write({ status: "done", summary: "fixed", needs_user: [] })
    ok(dir, ["job-report", "range"])
    assert.deepEqual(items(dir).map((i) => [i.id, i.column]), [[1, "waiting"], [2, "done"]])

    ok(dir, ["job-start", "qa", "--title", "QA the range control"])
    write({ status: "failed", summary: "the dev server would not start", needs_user: "Log in to the cloud console" })
    ok(dir, ["job-report", "qa", report])
    assert.deepEqual([items(dir)[2].column, items(dir)[2].ask], ["waiting", "failed: the dev server would not start\nLog in to the cloud console"])

    // A report for a job that is not on the board yet adds it.
    write({ status: "blocked", summary: "needs approval for a deploy" })
    ok(dir, ["job-report", "other", report])
    assert.deepEqual([items(dir)[3].title, items(dir)[3].column, items(dir)[3].ask], ["other", "waiting", "blocked: needs approval for a deploy"])

    // Only a regular file is read as a report.
    const fifo = join(base, "fifo")
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const r = board(dir, ["job-report", "qa", fifo])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /can't read the report/)
    }

    assert.deepEqual(reportOutcome({ status: "DONE", needs_user: [{ what: "merge #5" }] }), ["waiting", "merge #5"])
    assert.equal(reportOutcome({ status: "weird" }), null)
    assert.equal(board(dir, ["job-start", "Bad Slug"]).status, 2)
  } finally {
    done()
  }
})

test("board: the sidebar token text, reported to Herdr after each change", () => {
  const view = (waiting, doing, todo) => ({ counts: { waiting, doing, todo } })
  assert.equal(tokenText(view(3, 1, 0)), "1 doing · 3 need you")
  assert.equal(tokenText(view(1, 2, 4)), "2 doing · 1 needs you · 4 to do")
  assert.equal(tokenText(view(0, 0, 0)), "")

  const { base, done } = temp()
  try {
    const dir = repo(base)
    const herdr = fakeHerdr(base, { agents: [agent("search-ui", "blocked")] })
    ok(dir, ["add", "waiting", "Pick 7 options"], { herdr })
    ok(dir, ["job-start", "search-ui"], { herdr })
    ok(dir, ["job-start", "build"], { herdr })
    const reports = herdrLog(herdr).filter((a) => a[0] === "workspace")
    assert.deepEqual(reports.at(-1), ["workspace", "report-metadata", "w9", "--source", "job-board", "--token", "board=1 doing · 2 need you"])
    assert.equal(ok(dir, ["token"], { herdr }).trim(), "1 doing · 2 need you")
    // Nothing open and no blocked agent: the token is cleared, so the sidebar row hides.
    writeFileSync(herdr, JSON.stringify({ ...JSON.parse(readFileSync(herdr, "utf8")), agents: [] }))
    for (const id of ["1", "2", "3"]) ok(dir, ["done", id], { herdr })
    const cleared = herdrLog(herdr).filter((a) => a[0] === "workspace")
    assert.deepEqual(cleared.at(-1), ["workspace", "report-metadata", "w9", "--source", "job-board", "--clear-token", "board"])
    // Outside Herdr nothing is reported.
    ok(dir, ["add", "todo", "x"])
    assert.equal(herdrLog(herdr).filter((a) => a[0] === "workspace").length, cleared.length)
  } finally {
    done()
  }
})

test("board open: one split per tab, reused, restarted when it was quit, switched from another copy", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const herdr = fakeHerdr(base, { panes: [{ pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", cwd: dir }] })
    assert.match(ok(dir, ["open"], { herdr }), /board opened in pane w9:p101, right of w9:p1/)
    const log = herdrLog(herdr)
    const split = log.find((a) => a[1] === "split")
    assert.deepEqual(split.slice(0, 7), ["pane", "split", "--pane", "w9:p1", "--direction", "right", "--ratio"])
    assert.equal(split[7], "0.7", "the board gets 30% of the width")
    assert.ok(split.includes("--no-focus"))
    assert.deepEqual(log.find((a) => a[1] === "rename"), ["pane", "rename", "w9:p101", "board"])
    const run = log.find((a) => a[1] === "run")
    assert.match(run[3], /^node '.*board-pane\.mjs' --board '.*\/state\/board\.json' --origin 'w9:p1' --version '\d+\.\d+\.\d+'$/)
    assert.deepEqual(JSON.parse(readFileSync(fileOf(dir), "utf8")).panes, { "w9:t1": { pane: "w9:p101", origin: "w9:p1", at: "2026-10-13T10:30:00.000Z" } })

    assert.match(ok(dir, ["open"], { herdr }), /already open in pane w9:p101/)
    const after = herdrLog(herdr)
    assert.equal(after.filter((a) => a[1] === "split").length, 1, "no second pane")
    assert.equal(after.filter((a) => a[1] === "run").length, 1, "the running board is left alone")

    // The user quit the board (q): the pane is a shell again, so the board is started in it.
    const state = JSON.parse(readFileSync(herdr, "utf8"))
    delete state.panes.find((p) => p.pane_id === "w9:p101").running
    writeFileSync(herdr, JSON.stringify(state))
    assert.match(ok(dir, ["open"], { herdr }), /board restarted in pane w9:p101/)
    assert.equal(herdrLog(herdr).filter((a) => a[1] === "split").length, 1)
    assert.equal(herdrLog(herdr).filter((a) => a[1] === "run").length, 2)

    // Something else runs there now (the user started vim): nothing is typed into it.
    const busy = JSON.parse(readFileSync(herdr, "utf8"))
    busy.panes.find((p) => p.pane_id === "w9:p101").running = "vim notes.md"
    writeFileSync(herdr, JSON.stringify(busy))
    assert.match(ok(dir, ["open"], { herdr }), /something else runs in it now/)
    assert.equal(herdrLog(herdr).filter((a) => a[1] === "run").length, 2)

    // Another copy of the board runs there (an older install): it gets "q", then this one starts.
    const other = JSON.parse(readFileSync(herdr, "utf8"))
    other.panes.find((p) => p.pane_id === "w9:p101").running = "node '/old/install/board-pane.mjs' --board x"
    writeFileSync(herdr, JSON.stringify(other))
    assert.match(ok(dir, ["open"], { herdr }), /board switched to this copy in pane w9:p101/)
    const switched = herdrLog(herdr)
    assert.deepEqual(switched.filter((a) => a[1] === "send-text").at(-1), ["pane", "send-text", "w9:p101", "q"])
    assert.match(switched.filter((a) => a[1] === "run").at(-1)[3], new RegExp(`^node '${BOARD.replace(/board\.mjs$/, "board-pane\\.mjs")}'`))
    assert.equal(switched.filter((a) => a[1] === "split").length, 1)

    // The board sends its answers elsewhere (opened from another pane): restarted for this one.
    const elsewhere = JSON.parse(readFileSync(herdr, "utf8"))
    const version = JSON.parse(readFileSync(join(SCRIPTS, "package.json"), "utf8")).version
    elsewhere.panes.find((p) => p.pane_id === "w9:p101").running = `node '${PANE}' --board x --origin 'w9:p7' --version '${version}'`
    writeFileSync(herdr, JSON.stringify(elsewhere))
    assert.match(ok(dir, ["open"], { herdr }), /board restarted in pane w9:p101; its answers now go to w9:p1/)
    assert.match(herdrLog(herdr).filter((a) => a[1] === "run").at(-1)[3], /--origin 'w9:p1' --version '[^']+'$/)

    // An older version from the same folder (an update rewrites it in place): restarted with this
    // one, from a version that says so and from one before 0.4.0 that doesn't.
    for (const [running, said] of [[`--origin 'w9:p1' --version '0.3.9'`, "0.3.9"], [`--origin 'w9:p1'`, "a version before 0.4.0"]]) {
      const older = JSON.parse(readFileSync(herdr, "utf8"))
      older.panes.find((p) => p.pane_id === "w9:p101").running = `node '${PANE}' --board x ${running}`
      writeFileSync(herdr, JSON.stringify(older))
      assert.match(ok(dir, ["open"], { herdr }), new RegExp(`board updated to ${version.replace(/\./g, "\\.")} in pane w9:p101 \\(it ran ${said}\\)`))
      assert.match(herdrLog(herdr).filter((a) => a[1] === "run").at(-1)[3], new RegExp(`--version '${version}'$`))
    }

    // Called from the board's own pane (the key binding with the board focused, or a plugin
    // action run from a shell, which Herdr runs for the focused pane): nothing is split or run.
    const before = herdrLog(herdr).length
    const self = board(dir, ["open"], { herdr, extra: { HERDR_PANE_ID: "w9:p101" } })
    assert.equal(self.status, 0, self.stderr)
    assert.match(self.stdout, /pane w9:p101 is the board itself: nothing to open/)
    assert.deepEqual(herdrLog(herdr).slice(before).filter((a) => ["split", "run", "send-text", "rename"].includes(a[1])), [])
    assert.deepEqual(JSON.parse(readFileSync(fileOf(dir), "utf8")).panes, { "w9:t1": { pane: "w9:p101", origin: "w9:p1", at: "2026-10-13T10:30:00.000Z" } }, "the remembered pane stays")

    assert.match(board(dir, ["open"]).stderr, /needs Herdr/)
  } finally {
    done()
  }
})

test("board: no control characters reach a terminal, from the pane or the CLI", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const nasty = "evil \u001b]52;c;aGk=\u0007 \u001b[2J\u009b31m\u009d0;x\u0007\r title \u202eabc"
    const outputs = []
    const keep = (r) => {
      outputs.push(r.stdout, r.stderr)
      return r
    }
    keep(board(dir, ["add", "todo", "日本語のタイトルがとても長いのでここで切れるはずです", "--desc", "説明もかなり長いので切れるはずです、たぶん"]))
    keep(board(dir, ["add", "waiting", nasty, "--desc", nasty, "--ask", `line one ${nasty}\nline two`, "--option", `Go\u001b[2J`]))
    keep(board(dir, ["edit", "2", "--title", nasty]))
    keep(board(dir, ["move", "2", "waiting"]))
    keep(board(dir, ["job-start", "evil", "--title", nasty]))
    const report = join(base, "r.json")
    writeFileSync(report, JSON.stringify({ status: `don\u001b[2Je`, summary: nasty, needs_user: [nasty, { what: nasty }] }))
    keep(board(dir, ["job-report", "evil", report]))
    writeFileSync(report, JSON.stringify({ status: "done", summary: nasty, needs_user: [nasty] }))
    keep(board(dir, ["job-report", "evil", report]))
    keep(board(dir, ["move", `x\u001b[2J`, "done"]))
    keep(board(dir, ["ls", "--width", "60"]))
    keep(board(dir, ["json"]))
    for (const width of [120, 60]) keep(spawnSync(process.execPath, [PANE, "--once", "--width", String(width), "--height", "30"], { cwd: dir, env: envFor(), encoding: "utf8" }))
    const all = outputs.join("")
    assert.doesNotMatch(all, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, "no C0 (but newline and tab), DEL or C1 character in any output")
    assert.doesNotMatch(all, /[\u202a-\u202e\u2066-\u2069]/, "no bidirectional control")
    // Stored clean, too: a later reader (another tool, an older board) is safe.
    const stored = readFileSync(fileOf(dir), "utf8")
    assert.doesNotMatch(JSON.parse(stored).items.map((i) => [i.title, i.desc, i.ask, ...(i.options || []).map((o) => o.label)].join("")).join(""), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/)
    assert.equal(items(dir)[1].options[0].label, "Go[2J")

    // A board written by hand, with a C1 control: `json` escapes it.
    writeFileSync(fileOf(dir), JSON.stringify({ version: 1, next_id: 2, items: [{ id: 1, title: "csi \u009b here", column: "todo", since: "2026-10-13T10:00:00Z" }] }))
    const json = board(dir, ["json", "--project", "all"]).stdout
    assert.ok(!json.includes("\u009b") && json.includes("\\u009b"), "C1 written as an escape")
    assert.equal(JSON.parse(json).items[0].title, "csi \u009b here", "and the JSON still reads back the same")

    // Wide characters stay inside the width.
    for (const width of [120, 60]) {
      ok(dir, ["add", "todo", "日本語のタイトルがとても長いのでここで切れるはずです"])
      const r = spawnSync(process.execPath, [PANE, "--once", "--width", String(width), "--height", "30"], { cwd: dir, env: envFor(), encoding: "utf8" })
      for (const line of r.stdout.replace(/\n$/, "").split("\n")) {
        const cells = [...line].reduce((w, ch) => w + (/[\u3000-\u30ff\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0)
        assert.ok(cells <= width, `${cells} > ${width}: ${line}`)
      }
    }
  } finally {
    done()
  }
})

test("board: a hand-edited board with odd items says so, not a TypeError", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    for (const content of ['{"items":[null]}', '{"items":[1]}', '{"items":"x"}', "[]", "null", "not json"]) {
      writeFileSync(fileOf(dir), content)
      const r = board(dir, ["ls"])
      assert.equal(r.status, 1, content)
      assert.match(r.stderr, /is not (a job board|valid JSON)/, content)
      assert.doesNotMatch(r.stderr, /TypeError|Cannot read/, content)
    }
  } finally {
    done()
  }
})

test("board: the lock is taken back from a dead process, never from a live one", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    const lock = `${fileOf(dir)}.lock`
    const host = spawnSync("hostname", { encoding: "utf8" }).stdout.trim() || "localhost"
    // A lock left by a process that is gone: taken back at once.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout
    mkdirSync(lock)
    writeFileSync(join(lock, "owner"), `${dead} ${host} abc`)
    ok(dir, ["add", "todo", "after a dead owner"])
    assert.ok(!existsSync(lock), "released after the write")
    // A live owner (this test) keeps it, however long it takes: the writer gives up instead.
    mkdirSync(lock)
    writeFileSync(join(lock, "owner"), `${process.pid} ${host} abc`)
    const r = board(dir, ["add", "todo", "x"], { extra: { JOB_BOARD_LOCK_WAIT_MS: "300" } })
    assert.equal(r.status, 1)
    assert.match(r.stderr, new RegExp(`the board is locked by process ${process.pid}`))
    assert.ok(existsSync(join(lock, "owner")), "the live owner's lock is left alone")
    rmSync(lock, { recursive: true })
    // No owner written and old: stale.
    mkdirSync(lock)
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    ok(dir, ["add", "todo", "after an old lock"])
    assert.deepEqual(readdirSync(STATE).filter((f) => f.startsWith("board.json.")), [], "no lock, temp or stale file left")
    assert.equal((statSync(fileOf(dir)).mode & 0o777).toString(8), "600", "the board file is private to its owner")
  } finally {
    done()
  }
})

test("board: a Doing card shows its own workspace's agent before a namesake elsewhere", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["job-start", "search-ui", "--title", "Search filters: build"])
    const herdr = fakeHerdr(base, { agents: [agent("search-ui", "working"), agent("search-ui", "blocked", "w2")] })
    const text = ok(dir, ["ls", "--width", "60"], { herdr })
    assert.match(text, /DOING \(1\)[\s\S]*1   Search filters: build +working {2}just now\n/)
    assert.match(text, /WAITING ON YOU \(0\)/)
  } finally {
    done()
  }
})

test("board: a job that runs in another workspace (its project's) shows its agent there, and moves to Waiting when it is blocked (0.10.1)", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["job-start", "search-ui", "--title", "Search filters: build"])
    let herdr = fakeHerdr(base, { agents: [agent("search-ui", "working", "w2")] })
    let text = ok(dir, ["ls", "--width", "60"], { herdr })
    assert.match(text, /DOING \(1\)[\s\S]*1   Search filters: build +working {2}just now\n/)
    assert.doesNotMatch(text, /no agent/)
    herdr = fakeHerdr(base, { agents: [agent("search-ui", "blocked", "w2")] })
    text = ok(dir, ["ls", "--width", "60"], { herdr })
    assert.match(text.split("DOING")[0], /WAITING ON YOU \(1\)[\s\S]*Search filters: build +blocked/)
    // Gone from every workspace: no agent.
    herdr = fakeHerdr(base, { agents: [agent("other", "working", "w2")] })
    assert.match(ok(dir, ["ls", "--width", "60"], { herdr }), /1   Search filters: build +no agent {2}just now\n/)
  } finally {
    done()
  }
})
