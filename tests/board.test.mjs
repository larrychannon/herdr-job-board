// Run: node --test (from the repo root)
// board.mjs (the CLI, the only writer) and board-pane.mjs (the renderer). Herdr is faked by
// fixtures/fake-herdr.mjs; the real one is never called.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

function temp() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "job-board-")))
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
  const env = { ...process.env, TZ: "UTC", JOB_BOARD_NOW: now, NO_COLOR: "1", ...extra }
  for (const key of ["JOB_BOARD_FILE", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT"]) if (!(key in extra)) delete env[key]
  if (herdr) Object.assign(env, { HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", HERDR_PANE_ID: "w9:p1" })
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

const fileOf = (dir) => join(dir, ".git", "job-board.json")
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

    assert.equal(git(dir, "status", "--porcelain"), "", "the board lives in .git, not the work tree")
    assert.equal(board(dir, ["add", "later", "x"]).status, 2)
    assert.match(board(dir, ["move", "42", "done"]).stderr, /no item 42/)
    assert.equal(board(dir, ["move", "42", "done"]).status, 1)
    assert.equal(board(dir, ["add", "todo", "x", "--bogus", "y"]).status, 2)
    assert.equal(board(base, ["ls"]).status, 1, "outside a repo, without JOB_BOARD_FILE")
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
    assert.deepEqual(readdirSync(join(dir, ".git")).filter((f) => f.startsWith("job-board.json.")), [], "no lock or temp file left")
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
}

const agent = (name, status, workspace = "w9") => ({ name, agent_status: status, workspace_id: workspace, pane_id: `${workspace}:p${name.length}` })

test("board-pane: renders three columns at 120 and 88, stacked at 60 (snapshots)", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base, "my-app")
    seedDemo(dir)
    const herdr = fakeHerdr(base, { agents: [agent("search-ui", "working"), agent("docs-links", "working")] })
    const frame = (width, height) => {
      const r = spawnSync(process.execPath, [PANE, "--once", "--width", String(width), "--height", String(height)], { cwd: dir, env: envFor({ herdr }), encoding: "utf8" })
      assert.equal(r.status, 0, r.stderr)
      const lines = r.stdout.replace(/\n$/, "").split("\n")
      assert.ok(lines.every((l) => [...l].length <= width), `no line wider than ${width}`)
      assert.ok(lines.length <= height, `no more than ${height} lines`)
      return r.stdout
    }
    // 88 is the board's 30% of a full-screen Herdr tab.
    for (const width of [120, 88, 60]) {
      const text = frame(width, 40)
      const snap = join(FIXTURES, `board-${width}.txt`)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, text)
      assert.equal(text, readFileSync(snap, "utf8"), `snapshot ${snap} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }

    // Short of room, To do goes first: its descriptions, then its cards.
    const tall = frame(60, 52)
    assert.match(tall, /TO DO \(4\)\n\n 8 Export to CSV +1 min\n\n 9 Dark mode +1 min\n/, "To do keeps titles, no descriptions")
    assert.match(tall, /2 Search filters mockup: approve +1 h 30 min\n  Filter panel for the search page with saved filters\. 4\n  choices, e\.g\. whether saved filters are per user\.\n  → Reply ok or change/)
    const short = frame(60, 40)
    assert.match(short, /TO DO \(4\)\n\n\+4 more\n/)
    // Then the descriptions of Doing and Waiting, before any of their cards.
    const shorter = frame(60, 32)
    for (const title of ["Login page redesign: approve", "Deploy v1.4: go", "Docs site: fix broken links"]) assert.ok(shorter.includes(title), title)
    assert.doesNotMatch(shorter, /New sign-in screen/)
    assert.match(shorter, /→ Try the invoice page on :3000, then say merge/, "the ask stays")
    const tiny = frame(60, 20)
    assert.match(tiny, /WAITING ON YOU \(5\)[\s\S]*\+\d more/)
    assert.match(tiny.trimEnd().split("\n").at(-1), /^Done today: Nightly backup check$/)
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
    const text = ok(dir, ["ls", "--width", "60"])
    assert.match(text, /1 Deploy v1\.4: approve +just now\n  Ships the new invoice page to production\. Needs #12 and\n  #14 merged first\.\n  → Say go\n/)
    const longLines = text.split("2 Long one")[1].split("\n").slice(1, 5)
    assert.equal(longLines.filter((l) => l.startsWith("  word")).length, 3, "3 lines of description at most")
    assert.match(longLines[2], /…$/)
    assert.doesNotMatch(text.split("2 Long one")[0], /…/, "nothing cut when it fits")
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
    assert.match(waiting, /Search filters: build +just now\n\s+blocked: answer it in tab search-ui/)
    assert.match(waiting, /• stray\n\s+blocked: answer it in tab stray/, "a blocked named agent not on the board")
    assert.doesNotMatch(text, /elsewhere|idle-one/, "other workspaces and idle agents stay out")
    assert.match(text, /DOING \(1\)\n\n2 Review PR #31 +just now\n\s+working/)

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
    assert.match(ok(dir, ["ls", "--width", "60"]), /→ Review and merge PR #21\n {2}→ Deploy: \.\/deploy\.sh\n/)

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
    assert.match(run[3], /^node '.*board-pane\.mjs' --board '.*\.git\/job-board\.json'$/)
    assert.deepEqual(JSON.parse(readFileSync(fileOf(dir), "utf8")).panes, { "w9:t1": "w9:p101" })

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

    assert.match(board(dir, ["open"]).stderr, /needs Herdr/)
  } finally {
    done()
  }
})

test("board-pane: wide characters and escape sequences stay inside the width", () => {
  const { base, done } = temp()
  try {
    const dir = repo(base)
    ok(dir, ["add", "todo", "日本語のタイトルがとても長いのでここで切れるはずです", "--desc", "説明もかなり長いので切れるはずです、たぶん"])
    ok(dir, ["add", "waiting", "evil \u001b[2J\u001b]0;pwned\u0007 title", "--ask", "line one\nline two"])
    for (const width of [120, 60]) {
      const r = spawnSync(process.execPath, [PANE, "--once", "--width", String(width)], { cwd: dir, env: envFor(), encoding: "utf8" })
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /\u001b/, "no escape sequence from board text reaches the terminal")
      for (const line of r.stdout.replace(/\n$/, "").split("\n")) {
        const cells = [...line].reduce((w, ch) => w + (/[　-ヿ一-鿿]/.test(ch) ? 2 : 1), 0)
        assert.ok(cells <= width, `${cells} > ${width}: ${line}`)
      }
      assert.ok(r.stdout.includes("→ line one") && r.stdout.includes("→ line two"), "each line of the ask")
    }
  } finally {
    done()
  }
})
