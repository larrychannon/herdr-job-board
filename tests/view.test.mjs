// Run: node --test (from the repo root)
// Colours, the card details panel, links (OSC 8), copying (OSC 52) and the mouse toggle.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { animates, animationTimer, asText, barTick, buildView, copyLinks, copyPayload, copyPlace, detailLines, handleInput, markSent, nextCopy, parseInput, renderBoard, reportCacheStats, reportFacts, screenDiff, TICK_MS, WORKING_FRAMES } from "../board.mjs"
import { findUrls, MAX_COPY, osc52, osc8 } from "../links.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = join(ROOT, "board-pane.mjs")
const FIXTURES = join(ROOT, "tests", "fixtures")
const FAKE_HERDR = join(FIXTURES, "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const NOW = "2026-10-13T10:30:00Z"
const ESC = "\x1b"

/** A repo with a board in a temp dir, a fake Herdr, and helpers to run the CLI and the pane. */
function setup({ agents = [], tabs = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-view-")))
  // A fixed folder name: it shows in the board's title line, and so in the snapshots.
  const base = join(root, "my-app")
  mkdirSync(base)
  spawnSync("git", ["-C", base, "init", "-q"])
  const herdr = join(root, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ agents, tabs }))
  const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", JOB_BOARD_FILE: "", JOB_BOARD_HOME: join(root, "store"), HOME: root, JOB_BOARD_NOW: NOW, TZ: "UTC" }
  delete env.NO_COLOR
  const board = (now, ...args) => {
    const r = spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, HERDR_ENV: "0", JOB_BOARD_NOW: now }, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    return r
  }
  const pane = (args = [], keys = "") =>
    spawnSync(process.execPath, [PANE, "--once", "--width", "88", "--height", "40", "--origin", "w9:p1", ...args, "--keys", keys], { cwd: base, env, encoding: "utf8" })
  const log = () => JSON.parse(readFileSync(herdr, "utf8")).log ?? []
  return { base, env, board, pane, log, file: join(root, "store", "board.json"), done: () => rmSync(root, { recursive: true, force: true }) }
}

/** The board used for colours and details: every column, a link, buttons, an old question, a job with a report. */
function seed(t) {
  const report = join(t.base, "report.json")
  writeFileSync(
    report,
    JSON.stringify({
      status: "done",
      summary: `Filter panel built. Diff: https://github.com/example/app/pull/21 ${ESC}[2J‮`,
      needs_user: ["Review and merge https://github.com/example/app/pull/21"],
      ids: { pr: "https://github.com/example/app/pull/21", branch: "feat/filters", commit: "abc1234" },
    }),
  )
  t.board("2026-10-11T09:00:00Z", "add", "waiting", "Old question: pick a name", "--ask", "Reply with a name")
  t.board("2026-10-13T10:00:00Z", "add", "waiting", "Billing fix (PR #12): review", "--desc", "Invoices round per line. Preview: http://localhost:3000/invoices", "--ask", "Try http://localhost:3000/invoices, then say merge", "--option", "Merge", "--option", "Not yet", "--suggest", "Merge")
  t.board("2026-10-13T10:05:00Z", "job-start", "search-ui", "--title", "Search filters: build", "--desc", "The filter panel from the approved mockup.", "--report", report)
  t.board("2026-10-13T10:06:00Z", "job-start", "docs-links", "--title", "Docs: fix links")
  t.board("2026-10-13T10:07:00Z", "add", "todo", "Export to CSV", "--desc", "Let people download any table as CSV.")
  t.board("2026-10-13T09:00:00Z", "add", "todo", "Nightly backup check")
  t.board("2026-10-13T09:30:00Z", "done", "6")
  return report
}

const agents = [
  { name: "search-ui", agent_status: "working", workspace_id: "w9", pane_id: "w9:p5", tab_id: "w9:t5", interactive_ready: true },
  { name: "coord", agent_status: "idle", workspace_id: "w9", pane_id: "w9:p1", tab_id: "w9:t1", interactive_ready: true },
]
const tabs = [
  { tab_id: "w9:t5", label: "search-ui", workspace_id: "w9" },
  { tab_id: "w9:t1", label: "main", workspace_id: "w9" },
]
const sequences = (text) => [...text.matchAll(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g)].map((m) => m[0])
const decode52 = (text) => [...text.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8"))

test("colours: the 16-colour palette, by section, status, ask and age; off without --color (snapshots)", () => {
  const t = setup({ agents, tabs })
  try {
    seed(t)
    // The wide layout, where every card shows whole; the inbox's colours have a test of their own.
    const on = t.pane(["--color", "--width", "120"]).stdout
    const off = t.pane(["--width", "120"]).stdout
    for (const [name, text] of [["board-view-color.txt", on], ["board-view-plain.txt", off]]) {
      const snap = join(FIXTURES, name)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, text)
      assert.equal(text, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }
    assert.deepEqual(sequences(off), [], "no colour: no escape sequence at all")
    const codes = new Set(sequences(on))
    for (const seq of codes) assert.match(seq, /^\x1b\[[0-9;]*m$/, "only SGR, and no hyperlinks without --links")
    assert.ok(![...codes].some((c) => /38;[25]|48;[25]/.test(c)), "no 256-colour or true colour")
    const has = (code, text) => assert.ok(on.includes(`${ESC}[${code}m${text}`), `${code} ${text}`)
    has("1;7;33", "WAITING ON YOU (2)") // selected: reversed amber
    has("1;34", "DOING (2)")
    has("1", "TO DO (1)")
    has("2;32", "DONE · 1 today ▸") // folded
    has("32", "working")
    has("90", "no agent")
    // The question is text: a dim label, then the words with no style of their own; every
    // button is filled (the suggested one bold), so only the buttons look like something to click.
    has("2", "Needs you:")
    has("2", "Question:")
    assert.ok(on.includes(`Question:${ESC}[0m Try `), "the question's words carry no colour")
    assert.doesNotMatch(on, /→/, "no arrow")
    has("1;30;47", "[ Merge ✓ ]") // the suggested button
    has("30;47", "[ Not yet ]")
    has("30;47", "[ Other… ]")
    has("31", "2 days") // a Waiting card older than a day
    // NO_COLOR in the pane's env: interactive colour is off (the --once default is off anyway).
    const piped = spawnSync(process.execPath, [PANE, "--once", "--width", "88", "--height", "40"], { cwd: t.base, env: { ...t.env, NO_COLOR: "1" }, encoding: "utf8" })
    assert.deepEqual(sequences(piped.stdout), [])
  } finally {
    t.done()
  }
})

test("findUrls: http(s) only, strictly; trailing punctuation, quotes and userinfo left out", () => {
  const urls = (text) => findUrls(text).map((u) => u.url)
  const cases = [
    ["see https://github.com/a/b/pull/12.", ["https://github.com/a/b/pull/12"]],
    ["(https://a.example/c_(x))", ["https://a.example/c_(x)"]],
    ['say "https://q.example/p" twice', ["https://q.example/p"]],
    ["'https://q.example/p'", ["https://q.example/p"]],
    ["HTTPS://A.EXAMPLE:8080/x?y=1&z=2#f, and", ["HTTPS://A.EXAMPLE:8080/x?y=1&z=2#f"]],
    ["http://localhost:3000/cost]", ["http://localhost:3000/cost"]],
    // Cut short ("…" right after it): not a link at all, so no "…" in a target or a copy.
    ["https://a.example/pull/1?q=aaa\u2026", []],
    ["cut https://a.example/x\u2026 here, whole https://b.example/y", ["https://b.example/y"]],
    ["https://a.example\u2026", []],
    // Cut just after a host's dot or hyphen, or a port's colon: the pattern stops before it, but
    // the URL was still cut short.
    ["https://a.example.\u2026", []],
    ["https://a.example:\u2026", []],
    ["https://a-\u2026", []],
    ["https://a.example.:\u2026 and https://b.example.", ["https://b.example"]],
    ["<https://a.example/x>", ["https://a.example/x"]],
    ["two: https://a.example and http://b.example/y!", ["https://a.example", "http://b.example/y"]],
    ["https://good.example@evil.example/x", ["https://good.example"]],
    ["javascript:alert(1) data:text/html;base64,PHNjcmlwdD4= file:///etc/passwd ftp://f.example", []],
    ["http:// https:/x https://-bad.example https://.example", []],
    ["xhttps://a.example", []],
    [`https://a.example/${ESC}[2J`, ["https://a.example/"]],
  ]
  for (const [text, expected] of cases) assert.deepEqual(urls(text), expected, text)
})

test("OSC 8: the visible text is the URL itself; only whole URLs become links", () => {
  assert.equal(osc8("https://a.example/c"), `${ESC}]8;;https://a.example/c${ESC}\\https://a.example/c${ESC}]8;;${ESC}\\`)
  for (const bad of ["javascript:alert(1)", "https://a.example/c d", " https://a.example", "https://a.example.", `https://a.example/${ESC}`]) {
    assert.throws(() => osc8(bad), /not a link/, bad)
  }
  const t = setup({ agents, tabs })
  try {
    seed(t)
    const text = t.pane(["--links", "--color", "--width", "120"]).stdout
    const links = [...text.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g)]
    assert.ok(links.length >= 2)
    for (const [, target, shown] of links) {
      assert.equal(shown, target, "visible text = target")
      assert.deepEqual(findUrls(target).map((u) => u.url), [target])
    }
    // A URL cut by the width is not a link.
    const narrow = setup()
    narrow.board(NOW, "add", "todo", "x", "--desc", "https://very-long-host-name.example.com/a/really/long/path/that/does/not/fit")
    const cut = spawnSync(process.execPath, [PANE, "--once", "--width", "40", "--height", "20", "--links"], { cwd: narrow.base, env: narrow.env, encoding: "utf8" }).stdout
    assert.doesNotMatch(cut, /\x1b\]8;;/)
    narrow.done()
  } finally {
    t.done()
  }
})

test("details: Enter opens the card in words, its job and report rewritten for people; Esc closes; it scrolls", () => {
  const t = setup({ agents, tabs })
  try {
    const report = seed(t)
    const longDesc = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a long description.`).join(" ")
    t.board("2026-10-13T10:08:00Z", "edit", "3", "--desc", longDesc)
    // Doing, first card (search-ui): Tab to Doing, Enter.
    const flat = (r) => r.stdout.replace(/\n +/g, " ")
    let r = t.pane([], "\t\r")
    const panel = r.stdout.split(/── card 3/)[1]
    assert.ok(panel, "the panel opened on card 3")
    assert.match(panel, /\nSearch filters: build\n {2}Doing for 25 min\n/)
    assert.match(panel, /What it is\n {2}Sentence 1 of a long description/)
    assert.match(r.stdout, /── ↓ \d+ more lines ─+\n/, "longer than the panel: the closing rule says how much more")
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /^Esc close · ↑↓ scroll · f more · c copy · t go to tab · q quit$/)
    // Scroll to the end: the job, the report in words, More… and the times.
    r = t.pane([], "\t\rG")
    assert.match(r.stdout, /From the job\n {2}Job search-ui is working · 25 min · its tab: search-ui \(press t\)/)
    assert.match(r.stdout, /What the job reported\n {2}Filter panel built\./)
    assert.match(r.stdout, /Needs you:\n {2}• Review and merge https:\/\/github\.com\/example\/app\/pull\/21\n/)
    assert.match(r.stdout, /Links:\n {2}PR #21 {2}https:\/\/github\.com\/example\/app\/pull\/21\n/)
    assert.match(r.stdout, /▸ More… \(f or Enter\) {2}branch\n/)
    assert.match(r.stdout, /Added 10:05 · last changed 10:08/)
    assert.match(r.stdout, /── end of card 3 ─+\n/)
    assert.match(r.stdout, /── card 3 · ↑ \d+ lines above/)
    assert.doesNotMatch(r.stdout, /\x1b|‮/, "report text cleaned")
    // Never the report's path, its field names or ISO times.
    assert.doesNotMatch(r.stdout, /report\.json|\bstatus\b|needs_user|\bids\b|2026-10-13/)
    // More…: branch and commit.
    r = t.pane([], "\t\rGf")
    assert.match(r.stdout, /▾ Less \(f or Enter\)\n/)
    assert.match(r.stdout, /Branch feat\/filters · commit abc1234/)
    // Esc closes it.
    r = t.pane([], "\t\r\x1b")
    assert.doesNotMatch(r.stdout, /── card/)
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /^Tab section/)
    // Missing and garbled reports.
    rmSync(report)
    assert.match(t.pane([], "\t\rG").stdout, /What the job reported\n {2}Nothing yet: the job hasn't written its report\./)
    for (const garbled of ["{ not json", "[1, 2]"]) {
      writeFileSync(report, garbled)
      assert.match(t.pane([], "\t\rG").stdout, /The report can't be read: it isn't a JSON object of at most 1 MB\./)
    }
    // A huge summary: the first ~300 characters in the panel, at most 4000 under More….
    writeFileSync(report, JSON.stringify({ status: "done", summary: "x ".repeat(5000) }))
    const big = t.pane(["--height", "400"], "\t\r").stdout
    assert.ok((big.match(/x/g) || []).length < 160, "first sentences only")
    const bigMore = t.pane(["--height", "400"], "\t\rf").stdout
    assert.ok((bigMore.match(/x/g) || []).length < 160 + 2001, "summary cut to 4000 characters")
    assert.match(bigMore, /Full summary/)
    // A Waiting card with buttons: Enter opens details too (until ← → chooses a button), and
    // they show as the card's buttons.
    r = t.pane([], "\x1b[B\r")
    assert.match(r.stdout, /── card 2/)
    assert.match(r.stdout, /What you need to do\n {2}Question: Try http:\/\/localhost:3000\/invoices, then say merge\n {2}\[ Merge ✓ \] {2}\[ Not yet \] {2}\[ Other… \]/)
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /←→ choose/)
  } finally {
    t.done()
  }
})

/**
 * A board like a real one: a Waiting card from a job with a full report, a Waiting card without
 * a job, a Doing card whose report isn't written yet, a Done card with a report, and enough To do
 * and Done cards to fill the columns under the panel.
 */
function seedDetails(t) {
  const mockup = join(t.base, "mockup-report.json")
  writeFileSync(
    mockup,
    JSON.stringify({
      job: "checkout-mockup",
      status: "done",
      summary:
        "Mockup of the new checkout is on the design canvas (page 'Checkout v2', title row 'Checkout, before and after'). It has 12 boards, before and after, e.g. Cart, Address and the payment step. Every 'before' is a cropped screenshot (build 52). Saved cards must not become editable until the preview bug is fixed.",
      needs_user: [
        { question: "The saved-card preview drops the billing address and keeps none. Make saved cards editable anyway?", suggested_answer: "No. Fix the preview first." },
        { question: "Wording for the irreversible Delete card button?", suggested_answer: "Verb + card ending in caps: 'DELETE CARD 4242'." },
      ],
      ids: { artifact_url: "https://canvas.example/boards/checkout-v2", canvas_page: "Checkout v2", pr: "https://github.com/example/app/pull/57", branch: "feat/checkout-mockup", commit: "abc1234" },
      verified: ["Opened every step read-only.", "Checked the preview rows.", "Nothing was submitted."],
      skipped: ["Payment 'before' screenshot: it needs a real order."],
      findings: ["BLOCKER: the saved-card preview drops the billing address."],
      next: "Build step 1 when the boards are approved.",
    }),
  )
  const shipped = join(t.base, "shipped-report.json")
  writeFileSync(
    shipped,
    JSON.stringify({
      status: "done",
      summary: "CSV export is on the Orders page. Merged as https://github.com/example/app/pull/48 after review.",
      ids: { pr: "https://github.com/example/app/pull/48", dev_server: "http://localhost:3101/orders (pane w9:p3)" },
      verified: Array.from({ length: 12 }, (_, i) => `Check ${i + 1}`),
      skipped: ["Phone width", "Dark theme", "Safari"],
    }),
  )
  t.board("2026-10-13T03:00:00Z", "job-start", "checkout-mockup", "--title", "Checkout redesign mockup: approve", "--desc", "12 before/after boards on the design canvas (page 'Checkout v2'). 6 small choices, each with a suggested answer.", "--report", mockup)
  t.board("2026-10-13T03:00:00Z", "job-report", "checkout-mockup")
  t.board("2026-10-13T03:01:00Z", "edit", "1", "--ask", "Open the canvas, then OK all suggestions or comment", "--option", "OK all suggestions", "--option", "I'll comment", "--suggest", "OK all suggestions")
  t.board("2026-10-13T02:43:00Z", "add", "waiting", "Coupons AND gift cards discount an order twice: fix?", "--desc", "Live bug: a coupon plus a gift card takes the discount twice. Don't sell gift cards with coupons until fixed.", "--ask", "Pick one", "--option", "Fix in #31", "--option", "Fix + hide coupons now", "--option", "Not now", "--suggest", "Fix in #31")
  t.board("2026-10-13T03:17:00Z", "edit", "2", "--desc", "Live bug: a coupon plus a gift card takes the discount twice (e.g. order 1042 paid 0.00 incl. shipping); refunds then go negative. Both stay wrong until fixed. Don't sell gift cards with coupons until fixed.")
  t.board("2026-10-13T10:18:00Z", "job-start", "orders-ui", "--title", "Order history UI: build", "--desc", "The order list and filters from the approved mockup.", "--report", join(t.base, "orders-report.json"))
  t.board("2026-10-13T08:00:00Z", "job-start", "csv-export", "--title", "CSV export on the Orders page (PR #48): try it, then merge", "--report", shipped)
  t.board("2026-10-13T09:10:00Z", "job-report", "csv-export")
  for (const [i, title] of ["Export to PDF", "Nightly backup check", "Rotate the API keys"].entries()) t.board(`2026-10-13T07:0${i}:00Z`, "add", "todo", `TODO-MARK ${title}`, "--desc", "From the roadmap.")
  for (let i = 1; i <= 6; i++) {
    const r = t.board(`2026-10-13T0${i}:30:00Z`, "add", "doing", `DONE-MARK shipped thing ${i}`)
    t.board(`2026-10-13T0${i}:40:00Z`, "done", /^added (\d+)/.exec(r.stdout)[1])
  }
}

const detailAgents = [
  ...agents,
  { name: "orders-ui", agent_status: "working", workspace_id: "w9", pane_id: "w9:p7", tab_id: "w9:t7", interactive_ready: true },
  { name: "checkout-mockup", agent_status: "done", workspace_id: "w9", pane_id: "w9:p6", tab_id: "w9:t6", interactive_ready: true },
]
const detailTabs = [...tabs, { tab_id: "w9:t7", label: "orders-ui", workspace_id: "w9" }, { tab_id: "w9:t6", label: "checkout-mockup", workspace_id: "w9" }]
// Keys that open each card's details: Waiting 1 and 2, Doing (orders-ui), Done (CSV export; d
// opens Done first).
const OPEN = { 1: "\r", 2: "\x1b[B\r", 3: "\t\r", 4: "d\t\t\t\r" }
const plainOf = (text) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "")

test("details panel snapshots: Waiting from a job, Waiting without one, Doing and Done; 120 and 88 columns; colour on and off", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    for (const [name, flags] of [["details-plain.txt", []], ["details-color.txt", ["--color", "--links"]]]) {
      let all = ""
      for (const width of [120, 88]) {
        for (const [card, keys] of Object.entries(OPEN)) {
          const r = t.pane(["--width", String(width), "--height", "40", ...flags], keys)
          assert.equal(r.status, 0, r.stderr)
          all += `===== card ${card} · ${width} columns =====\n${r.stdout}`
        }
      }
      const snap = join(FIXTURES, name)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, all)
      assert.equal(all, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }
  } finally {
    t.done()
  }
})

test("details panel: opaque from its top rule to the key line, closed by a rule; nothing of the columns inside it (120×40, 88×40, 60×30 stacked)", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const board = t.pane(["--width", "120", "--height", "40"], "d").stdout
    assert.match(board, /DONE-MARK shipped thing 6/, "without the panel, Done (open) shows in the lower half")
    for (const [width, height] of [[120, 40], [88, 40], [60, 30]]) {
      for (const [card, keys] of Object.entries(OPEN)) {
        for (const flags of [[], ["--color", "--links"]]) {
          const screen = plainOf(t.pane(["--width", String(width), "--height", String(height), ...flags], keys).stdout).split("\n")
          assert.equal(screen.at(-1), "", "ends in a newline")
          screen.pop()
          assert.equal(screen.length, height)
          const top = screen.findIndex((l) => /^── card \d/.test(l))
          assert.equal(top, height / 2, `${card} at ${width}: the panel starts half way down`)
          const bottom = screen.length - 2
          assert.match(screen[bottom], /^── (end of card \d+|↓ \d+ more lines?) ─+$/, `${card} at ${width}: the closing rule, just above the key line`)
          assert.equal([...screen[bottom]].length, width, "the closing rule spans the pane")
          assert.equal([...screen[top]].length, width, "and so does the top one")
          assert.match(screen.at(-1), /^Esc /)
          for (const line of screen.slice(top, bottom + 1)) {
            assert.doesNotMatch(line, /TODO-MARK|DONE-MARK|DOING \(|TO DO \(|DONE \(|DONE · |WAITING ON YOU|↓ \d+ more$/, `${card} at ${width}: column text in the panel: ${line}`)
          }
        }
      }
    }
    // The same through renderBoard: the panel's region runs to the line above the key line.
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const view = buildView(state, null, { now: new Date(NOW) })
    const opened = renderBoard(view, { width: 88, height: 30, interactive: true, now: new Date(NOW), scroll: { selected: "waiting", anchors: {}, detail: { key: "#2", offset: 0 } } })
    assert.deepEqual([opened.regions.detail.top, opened.regions.detail.bottom], [16, 29])
    const rows = opened.text.split("\n")
    assert.equal(rows.length, 30)
    assert.match(rows[28], /^── (end of card 2|↓ \d+ more lines?) ─+$/)
  } finally {
    t.done()
  }
})

test("details: More… shows the rest of the report (f, Enter on it, or a click); buttons work from the panel", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const tall = (keys) => t.pane(["--width", "120", "--height", "120"], keys).stdout
    const closed = tall("\r")
    assert.match(closed, /▸ More… \(f or Enter\) {2}full summary, suggested answers, findings, checks, skips, next steps, branch\n/)
    assert.doesNotMatch(closed, /What was checked|suggested: No\. Fix the preview first\./, "collapsed by default")
    // The report in words: first sentences, needs as bullets, labelled links, counts.
    assert.match(closed, /What the job reported\n {2}Mockup of the new checkout is on the design canvas/)
    assert.match(closed, /e\.g\. Cart, Address and the payment step\.\n {2}Needs you:/, "two sentences, then the needs")
    assert.doesNotMatch(closed, /Every 'before'/)
    assert.match(closed, /Needs you:\n {2}• The saved-card preview drops the billing address and keeps none\. Make saved cards editable anyway\?\n {2}• Wording for/)
    assert.match(closed, /Links:\n {2}Design canvas {2}https:\/\/canvas\.example\/boards\/checkout-v2\n {2}PR #57 {9}https:\/\/github\.com\/example\/app\/pull\/57\n/)
    assert.match(closed, /3 things checked · 1 skipped · 1 finding\n/)
    assert.match(closed, /From the job\n {2}Job checkout-mockup finished · its tab: checkout-mockup \(press t\)/)
    assert.match(closed, /Waiting on you for 7 h 30 min/)
    assert.match(closed, /Added 03:00 · last changed 03:01/)
    for (const keys of ["\rf", "\r\r"]) {
      const open = tall(keys)
      assert.match(open, /▾ Less \(f or Enter\)\n/, JSON.stringify(keys))
      assert.match(open, /Full summary\n {2}Mockup of the new checkout/)
      assert.match(open, /Needs you, in full\n {2}• The saved-card preview[^•]*\n {4}suggested: No\. Fix the preview first\./)
      assert.match(open, /Findings\n {2}• BLOCKER: the saved-card preview drops the billing address\./)
      assert.match(open, /What was checked\n {2}• Opened every step read-only\.\n {2}• Checked the preview rows\.\n {2}• Nothing was submitted\./)
      assert.match(open, /What was skipped\n {2}• Payment 'before' screenshot: it needs a real order\./)
      assert.match(open, /What's next\n {2}Build step 1 when the boards are approved\./)
      assert.match(open, /Branch feat\/checkout-mockup · commit abc1234/)
    }
    assert.doesNotMatch(tall("\rff"), /▾ Less/, "f again hides it")
    assert.doesNotMatch(tall("\r\r\r"), /▾ Less/, "Enter again hides it")
    // A card with nothing more: no More…, and Enter closes the details as before.
    assert.doesNotMatch(tall("\x1b[B\r"), /More…/)
    assert.doesNotMatch(tall("\x1b[B\r\r"), /── card/)
    assert.doesNotMatch(tall("f"), /── card|More/, "f does nothing on the board")

    // Buttons in the panel: ← → choose, Enter presses (the board's own handling, no Herdr call here).
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const view = buildView(state, null, { now: new Date(NOW) })
    const draw = (scroll) => renderBoard(view, { width: 120, height: 60, interactive: true, now: new Date(NOW), scroll })
    let drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1, detail: { key: "#1", offset: 0 } })
    const step = (event) => {
      const r = handleInput(drawn.scroll, event, drawn)
      drawn = draw(r.scroll)
      return r.action
    }
    assert.equal(step({ type: "key", name: "right" }), null)
    assert.match(drawn.text, /── card 1[^\n]*\n(?:.*\n)*? {2}< OK all suggestions ✓ > {2}\[ I'll comment \] {2}\[ Other… \]/, "→ chooses the suggested button in the panel")
    assert.match(drawn.text, /▸ More… \(f\) {2}/, "with a button chosen, Enter is the button's")
    assert.deepEqual(step({ type: "key", name: "right" }), null)
    assert.deepEqual(step({ type: "key", name: "enter" }), { type: "send", id: 1, key: "#1", label: "I'll comment" })
    assert.ok(drawn.scroll.detail, "the panel stays open")
    assert.deepEqual(step({ type: "key", name: "other" }), { type: "other", id: 1, key: "#1" })
    // A click on a panel button presses it; on the More… line it toggles; elsewhere it does nothing.
    drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1, detail: { key: "#1", offset: 0 } })
    const panelButton = drawn.buttons.find((b) => b.panel && b.label === "OK all suggestions")
    assert.ok(panelButton && panelButton.y > drawn.regions.detail.top, "the panel's button can be clicked")
    assert.ok(!drawn.buttons.some((b) => !b.panel && b.y >= drawn.regions.detail.top), "the board's buttons under the panel can't")
    assert.deepEqual(handleInput(drawn.scroll, { type: "click", x: panelButton.x0, y: panelButton.y }, drawn).action, { type: "send", id: 1, key: "#1", label: "OK all suggestions" })
    const more = drawn.moreHits[0]
    assert.ok(more)
    assert.equal(handleInput(drawn.scroll, { type: "click", x: more.x0, y: more.y }, drawn).scroll.detail.more, true)
    const quiet = handleInput(drawn.scroll, { type: "click", x: 3, y: drawn.regions.detail.top + 1 }, drawn)
    assert.deepEqual([quiet.action, quiet.scroll.detail.more], [null, false])
    // Esc closes and un-chooses.
    drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: 1, detail: { key: "#1", offset: 0 } })
    const esc = handleInput(drawn.scroll, { type: "key", name: "escape" }, drawn).scroll
    assert.deepEqual([esc.detail, esc.button], [undefined, -1])
  } finally {
    t.done()
  }
})

test("a Waiting card whose job is blocked shows no buttons, so none can be chosen or sent: on the board, in the panel, end to end", () => {
  const blocked = detailAgents.map((a) => (a.name === "checkout-mockup" ? { ...a, agent_status: "blocked" } : a))
  const t = setup({ agents: blocked, tabs: detailTabs })
  try {
    seedDetails(t)
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const view = buildView(state, blocked, { now: new Date(NOW), workspace: "w9" })
    assert.equal(view.waiting[0].live, "blocked")
    const draw = (scroll) => renderBoard(view, { width: 120, height: 60, interactive: true, now: new Date(NOW), workspace: "w9", agents: blocked, tabs: {}, scroll })
    for (const detail of [undefined, { key: "#1", offset: 0 }]) {
      let drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1, detail })
      assert.equal(drawn.sections.waiting.cards.find((c) => c.key === "#1").buttons, 0, "no button counts")
      assert.ok(!drawn.buttons.some((b) => b.key === "#1"), "none on screen")
      assert.doesNotMatch(drawn.text, /[[<] OK all suggestions/, "no button drawn")
      const actions = []
      for (const name of ["right", "enter", "left", "right", "enter", "other", "enter"]) {
        const r = handleInput(drawn.scroll, { type: "key", name }, drawn)
        if (r.action) actions.push(r.action)
        drawn = draw(r.scroll)
        assert.ok(!(drawn.scroll.card === "#1" && drawn.scroll.button >= 0), `${detail ? "panel" : "board"}: ${name} chose a hidden button`)
      }
      assert.deepEqual(actions.filter((a) => a.type === "send" || a.type === "other"), [], `${detail ? "panel" : "board"}: nothing sent`)
    }
    // In the panel: what to do instead, and no ←→ on the key line.
    const panel = t.pane(["--width", "120", "--height", "60"], "\r").stdout
    assert.match(panel, /What you need to do\n {2}Needs you: Open the canvas, then OK all suggestions or comment\n\n/, "the ask, and no buttons under it")
    assert.match(panel, /Job checkout-mockup is blocked: it needs you in its tab/)
    assert.doesNotMatch(panel.trimEnd().split("\n").at(-1), /←→/)
    // End to end through the pane and the fake Herdr: → Enter and o, on the board and in the panel.
    for (const keys of ["\x1b[C\r", "\r\x1b[C\r", "\r\x1b[C\x1b[C\r", "\ro", "o"]) t.pane(["--width", "120", "--height", "60"], keys)
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && (a[1] === "prompt" || (a[1] === "focus" && a[2] === "w9:p1"))), [])
  } finally {
    t.done()
  }
})

test("details open with no button chosen: a button chosen on the card, then a double click, gives More… on Enter, not a send", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const view = buildView(JSON.parse(readFileSync(t.file, "utf8")), null, { now: new Date(NOW) })
    const draw = (scroll) => renderBoard(view, { width: 120, height: 60, interactive: true, now: new Date(NOW), scroll })
    let drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1 })
    let r = handleInput(drawn.scroll, { type: "key", name: "right" }, drawn)
    drawn = draw(r.scroll)
    assert.equal(drawn.scroll.button, 0, "→ chose the suggested button on the card")
    const title = drawn.cardHits.find((c) => c.key === "#1")
    for (const at of [1000, 1100]) {
      r = handleInput(drawn.scroll, { type: "click", x: title.x0, y: title.y, at }, drawn)
      drawn = draw(r.scroll)
    }
    assert.equal(drawn.scroll.detail?.key, "#1", "the double click opened the details")
    assert.equal(drawn.scroll.button, -1, "with no button chosen")
    assert.match(drawn.text, /── card 1[^\n]*\n(?:.*\n)*? {2}\[ OK all suggestions ✓ \]/)
    r = handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn)
    assert.equal(r.action, null, "Enter is not a send")
    assert.equal(r.scroll.detail.more, true, "it opens More…")
    // Opening with Enter after Esc un-chose the button: the same.
    drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1 })
    r = handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn)
    assert.deepEqual([r.action, r.scroll.button, r.scroll.detail.key], [null, -1, "#1"])
  } finally {
    t.done()
  }
})

test("a press in the panel: argv only, to the origin pane, once; again asks first; o focuses the origin pane", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const prompts = () => t.log().filter((a) => a[0] === "agent" && a[1] === "prompt")
    const first = t.pane(["--width", "120", "--height", "60"], "\r\x1b[C\r")
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(prompts(), [["agent", "prompt", "w9:p1", "Board card 1 (my · Checkout redesign mockup: approve): OK all suggestions"]])
    assert.equal(JSON.parse(readFileSync(t.file, "utf8")).items[0].sent.label, "OK all suggestions")
    const again = t.pane(["--width", "120", "--height", "60"], "\r\x1b[C\r").stdout
    assert.match(again.split(/── card 1/)[1], /send again\? "OK all suggestions" was sent already/, "the note shows in the panel")
    assert.equal(prompts().length, 1, "no second send without a second press")
    t.pane(["--width", "120", "--height", "60"], "\ro")
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && a[1] === "focus").at(-1), ["agent", "focus", "w9:p1"])
  } finally {
    t.done()
  }
})

test("details: a report over 1 MB is not read; OSC 52 in a report does nothing; a URL cut short is no link; More… is built once", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const big = join(t.base, "big-report.json")
    writeFileSync(big, JSON.stringify({ status: "done", summary: `BIGMARK ${"y".repeat(1.5 * 1024 * 1024)}` }))
    t.board(NOW, "edit", "2", "--report", big)
    const unread = t.pane(["--width", "120", "--height", "60"], "\x1b[B\r").stdout
    assert.match(unread, /The report can't be read: it isn't a JSON object of at most 1 MB\./)
    assert.doesNotMatch(unread, /BIGMARK|big-report/)
    // OSC 52 (a clipboard write) and a URL cut at the 4000-character cap.
    const osc52 = `${ESC}]52;c;${Buffer.from("rm -rf ~").toString("base64")}\x07`
    const cut = join(t.base, "cut-report.json")
    writeFileSync(cut, JSON.stringify({ status: "done", summary: `Done ${osc52} here. ${"x ".repeat(1990)}https://a.example/${"p".repeat(200)}`, needs_user: [`Copy ${osc52}`] }))
    t.board(NOW, "edit", "2", "--report", cut)
    for (const keys of ["\x1b[B\r", "\x1b[B\rf", "\x1b[B\rfG"]) {
      const text = t.pane(["--width", "120", "--height", "200", "--color", "--links"], keys).stdout
      assert.doesNotMatch(text, /\x1b\]52/, "no clipboard write without c")
      assert.doesNotMatch(text, /\x1b\]8;;[^\x1b]*…/, "no link target ends in a cut")
    }
    const copied = decode52(t.pane(["--width", "120", "--height", "60"], "\x1b[B\rc").stdout)
    assert.equal(copied.length, 1)
    assert.doesNotMatch(copied[0], /rm -rf|…|a\.example/, "the copy is the card's text: the cut URL is no link")
    // More… is built once per report and width: a repaint reuses its lines.
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const view = buildView(state, null, { now: new Date(NOW) })
    const entry = { ...view.waiting.find((e) => e.id === 1), column: "waiting" }
    const block = (r) => r.lines.find((l) => l.some((seg) => seg.t === "What was checked"))
    const one = detailLines(entry, 120, { now: new Date(NOW), more: true })
    assert.ok(block(one))
    assert.equal(block(detailLines(entry, 120, { now: new Date(NOW), more: true })), block(one), "the same lines, not built again")
    assert.notEqual(block(detailLines(entry, 100, { now: new Date(NOW), more: true })), block(one), "another width builds them again")
  } finally {
    t.done()
  }
})

test("details: a hostile report is still cleaned, its links strict, its keys only words", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const evil = join(t.base, "evil-report.json")
    const hidden = "\u200b\u202e\u2066\ufeff"
    writeFileSync(
      evil,
      JSON.stringify({
        status: `done${ESC}[31m`,
        summary: `Fine${hidden} work.${ESC}]0;pwned${ESC}\\ More ${ESC}[2J text. ${"z".repeat(9000)}`,
        needs_user: [{ question: `Approve${ESC}[8m this?\u0007`, suggested_answer: `Yes${ESC}]8;;http://evil.example${ESC}\\click${ESC}]8;;${ESC}\\` }, [[["deep"]]], 42],
        ids: {
          [`pr${ESC}[1m`]: `javascript:alert(1) https://user:pw@evil.example/x https://ok.example/p${hidden}q`,
          [`dev${ESC}[5m_server_url`]: "http://localhost:3101/x\u0007y",
          nested: { url: "https://nested.example/x" },
        },
        verified: [`ok${ESC}[0m`, { check: "an object check" }, ["no"]],
        skipped: `one skipped${ESC}c`,
      }),
    )
    t.board(NOW, "edit", "2", "--report", evil)
    for (const keys of ["\x1b[B\r", "\x1b[B\rf", "\x1b[B\rfG"]) {
      const r = t.pane(["--width", "120", "--height", "200", "--color", "--links"], keys)
      assert.equal(r.status, 0, r.stderr)
      const text = r.stdout
      for (const seq of sequences(text)) assert.match(seq, /^\x1b\[[0-9;]*m$|^\x1b\]8;;https?:\/\/[^\x1b]*\x1b\\$|^\x1b\]8;;\x1b\\$/, "only the renderer's SGR and strict OSC 8")
      assert.doesNotMatch(text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, ""), /\x1b/, "no other escape at all")
      assert.doesNotMatch(text, /[\u200b\u202e\u2066\ufeff\u0007]/u)
      // Escape sequences lose their ESC and do nothing; the report path, javascript:, a
      // user:password@ part and URLs inside nested objects never show.
      assert.doesNotMatch(text, /evil-report\.json|javascript:|user:pw|nested\.example/)
      for (const [, target, shown] of text.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g)) {
        assert.equal(shown, target)
        assert.deepEqual(findUrls(target).map((u) => u.url), [target])
      }
    }
    const open = plainOf(t.pane(["--width", "120", "--height", "200"], "\x1b[B\rf").stdout)
    assert.match(open, /Fine work\./)
    assert.match(open, /• Approve\[8m this\?/)
    assert.match(open, /suggested: Yes(?:\]8;;)?/)
    assert.match(open, /Links:\n {2}Pr 1m +https:\/\/user\n {2}Pr 1m +https:\/\/ok\.example\/pq\n {2}Dev 5m server {2}http:\/\/localhost:3101\/xy\n/, "labels from the ids' names, words only; URLs strict")
    assert.match(open, /Not final yet/, "a status that is not exactly done is not taken as done")
    assert.match(open, /• an object check/)
    assert.match(open, /• \(not text\)/)
    assert.match(open, /• one skipped/)
    assert.ok((open.match(/z/g) || []).length < 4000 + 300, "the summary is cut (4000 in full, 300 in brief)")
  } finally {
    t.done()
  }
})

test("details helpers: first sentences, short local times, link labels", async () => {
  const { firstSentences, shortTime } = await import("../board.mjs")
  assert.deepEqual(firstSentences("One. Two, e.g. this one. Three."), { text: "One. Two, e.g. this one.", cut: true })
  assert.deepEqual(firstSentences("Only one sentence"), { text: "Only one sentence", cut: false })
  assert.deepEqual(firstSentences(`${"a".repeat(250)}. B${"b".repeat(100)}.`), { text: `${"a".repeat(250)}.`, cut: true }, "the second only when both fit")
  const long = firstSentences(`${"word ".repeat(100)}end.`)
  assert.ok(long.cut && long.text.endsWith("…") && [...long.text].length <= 300 && !/ …$/.test(long.text))
  assert.deepEqual(firstSentences("Built v1.2 today. Next (PR #4) is review."), { text: "Built v1.2 today. Next (PR #4) is review.", cut: false })
  // Local times: in UTC here (Node reads TZ again when it changes).
  const tz = process.env.TZ
  process.env.TZ = "UTC"
  try {
    const now = new Date("2026-10-13T10:30:00Z")
    assert.equal(shortTime("2026-10-13T03:17:00Z", now), "03:17")
    assert.equal(shortTime("2026-10-12T23:05:00Z", now), "Mon 23:05")
    assert.equal(shortTime("2026-09-01T08:00:00Z", now), "1 Sep 08:00")
    assert.equal(shortTime("2025-09-01T08:00:00Z", now), "1 Sep 2025")
    assert.equal(shortTime("", now), "")
    assert.equal(shortTime("nonsense", now), "")
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
  const t = setup()
  try {
    const path = join(t.base, "links.json")
    writeFileSync(
      path,
      JSON.stringify({
        status: "done",
        summary: "See https://github.com/o/other/pull/3 and http://localhost:3000/a.",
        ids: { web_pr: "https://github.com/o/web/pull/13", shop_pr: "https://gitlab.com/o/shop/-/merge_requests/111", issue: "https://github.com/o/a/issues/4", commit_url: "https://github.com/o/a/commit/0123456789abcdef", design: "https://canvas.example/c/1", pr_number: 112 },
      }),
    )
    assert.deepEqual(reportFacts(path).links, [
      { label: "PR #112", url: "" },
      { label: "PR #13 · web", url: "https://github.com/o/web/pull/13" },
      { label: "PR #111 · shop", url: "https://gitlab.com/o/shop/-/merge_requests/111" },
      { label: "Issue #4", url: "https://github.com/o/a/issues/4" },
      { label: "Commit 0123456", url: "https://github.com/o/a/commit/0123456789abcdef" },
      { label: "Design canvas", url: "https://canvas.example/c/1" },
      { label: "PR #3 · other", url: "https://github.com/o/other/pull/3" },
      { label: "localhost:3000", url: "http://localhost:3000/a" },
    ])
    // job-report reads a need's question too.
    const q = join(t.base, "q.json")
    writeFileSync(q, JSON.stringify({ status: "done", needs_user: [{ question: "Merge it?", suggested_answer: "Yes" }, "Then deploy"] }))
    t.board(NOW, "job-start", "qa", "--report", q)
    t.board(NOW, "job-report", "qa")
    assert.equal(JSON.parse(readFileSync(t.file, "utf8")).items[0].ask, "Merge it?\nThen deploy")
  } finally {
    t.done()
  }
})

test("copy: OSC 52 only when c is pressed, with the selected card's first link or its text", () => {
  const t = setup({ agents, tabs })
  try {
    seed(t)
    assert.deepEqual(decode52(t.pane().stdout), [], "nothing without c")
    assert.deepEqual(decode52(t.pane([], "\x1b[B\x1b[A\t\t").stdout), [], "nor for moving around")
    // Card 1 (old question) has no link: its text. Card 2 has a link: the link.
    let r = t.pane([], "c")
    assert.deepEqual(decode52(r.stdout), ["#1 Old question: pick a name\n\n→ Reply with a name"])
    assert.match(r.stdout, /copied card 1 · /)
    r = t.pane([], "\x1b[Bc")
    assert.deepEqual(decode52(r.stdout), ["http://localhost:3000/invoices"])
    assert.match(r.stdout, /copied http:\/\/localhost:3000\/invoices/)
    // In the details panel: that card. The report's PR link counts when the card has none.
    r = t.pane([], "\t\rc")
    assert.deepEqual(decode52(r.stdout), ["https://github.com/example/app/pull/21"])
    // Cut to MAX_COPY characters.
    assert.equal(Buffer.from(osc52("y".repeat(MAX_COPY + 500)).slice(7, -1), "base64").toString().length, MAX_COPY)
  } finally {
    t.done()
  }
})

test("copy: c again copies the card's next link, round to the first; a new card or the details start over", () => {
  const t = setup({ agents, tabs })
  try {
    seedDetails(t)
    const canvas = "https://canvas.example/boards/checkout-v2"
    const pr = "https://github.com/example/app/pull/57"
    const last = (r) => r.stdout.trimEnd().split("\n").at(-1)
    // Card 1 has two links (the report's Design canvas, then PR #57): c, c, c copies 1, 2, 1.
    let r = t.pane(["--width", "120"], "ccc")
    assert.deepEqual(decode52(r.stdout), [canvas, pr, canvas])
    assert.match(last(r), /^copied 1\/2: Design canvas https:\/\/canvas\.example\/boards\/checkout-v2 · /)
    assert.match(last(t.pane(["--width", "120"], "cc")), /^copied 2\/2: PR #57 https:\/\/github\.com\/example\/app\/pull\/57 · /)
    // Another card and back, or the details opened or closed: the first link again.
    assert.deepEqual(decode52(t.pane([], "c\x1b[B\x1b[Ac").stdout), [canvas, canvas])
    assert.deepEqual(decode52(t.pane([], "c\rc").stdout), [canvas, canvas], "opening the details")
    // (Esc then ↑, which stays on the top card: an Esc right before c would read as Alt+c.)
    assert.deepEqual(decode52(t.pane([], "\rcc\x1b\x1b[Ac").stdout), [canvas, pr, canvas], "the same in the details; closing them starts over")
    assert.deepEqual(decode52(t.pane([], "\rc\x1b\x1b[A\rc").stdout), [canvas, canvas], "closed and opened again between presses")
    // The long key line says so on such a card, where it fits; the short ones stay short.
    assert.equal(last(t.pane(["--width", "120"])), "Tab section · ↑↓ card · Enter details · c copy (again: next link) · d done · m mouse: board · q quit")
    assert.equal(last(t.pane(["--width", "88"])), "Tab section · ↑↓ card · Enter details · c copy · d done · m mouse: board · q quit")
    assert.equal(last(t.pane(["--width", "120"], "\x1b[B")), "Tab section · ↑↓ card · Enter details · c copy · d done · m mouse: board · q quit", "a card without links: as before")
  } finally {
    t.done()
  }
})

test("copy: one link and no link copy as before, each press the same", () => {
  const t = setup({ agents, tabs })
  try {
    seed(t)
    let r = t.pane([], "cc")
    assert.deepEqual(decode52(r.stdout), ["#1 Old question: pick a name\n\n→ Reply with a name", "#1 Old question: pick a name\n\n→ Reply with a name"])
    r = t.pane([], "\x1b[Bcc")
    assert.deepEqual(decode52(r.stdout), ["http://localhost:3000/invoices", "http://localhost:3000/invoices"], "the desc and ask's one link, once")
    assert.match(r.stdout, /copied http:\/\/localhost:3000\/invoices · /, "no 1/1")
    // The cycle: the place and the card's links must hold; a changed list starts over.
    const card = { id: 9, title: "a https://a.example/1", desc: "b https://b.example/2" }
    let step = nextCopy(null, card, copyPlace({ card: "9" }))
    assert.equal(step.payload.text, "https://a.example/1")
    step = nextCopy(step.cycle, card, copyPlace({ card: "9" }))
    assert.equal(step.payload.text, "https://b.example/2")
    assert.equal(nextCopy(step.cycle, card, copyPlace({ card: "9" })).payload.text, "https://a.example/1", "round to the first")
    assert.equal(nextCopy(step.cycle, { ...card, ask: "https://c.example/3" }, copyPlace({ card: "9" })).payload.text, "https://a.example/1", "links changed")
    assert.equal(nextCopy(step.cycle, card, copyPlace({ card: "9", detail: { key: "9" } })).payload.text, "https://a.example/1", "details opened")
    assert.deepEqual(copyLinks(card).map((l) => l.url), ["https://a.example/1", "https://b.example/2"])
    assert.equal(copyPayload(card, 3).text, "https://b.example/2")
  } finally {
    t.done()
  }
})

test("mouse: a click selects a card, a double click opens it; t goes to the job's tab", () => {
  const t = setup({ agents, tabs })
  try {
    seed(t)
    const screen = t.pane().stdout.split("\n")
    const y = screen.findIndex((l) => l.includes("Export to CSV"))
    const x = [...screen[y].slice(0, screen[y].indexOf("Export to CSV"))].length + 3
    const click = `\x1b[<0;${x};${y + 1}M`
    let r = t.pane([], click)
    assert.match(r.stdout, /▸ TO DO \(1\)/, "the click selected To do")
    assert.match(r.stdout, /▸ ?\d+ {3}Export to CSV/, "and the card (the inbox at 88: its row marked)")
    assert.doesNotMatch(r.stdout, /── card/)
    r = t.pane([], click + click)
    assert.match(r.stdout, /── card 5 /, "a double click opens it")
    // t: Herdr's agent focus for the job, as argv.
    t.pane([], "\tt")
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && a[1] === "focus").at(-1), ["agent", "focus", "search-ui"])
    r = t.pane([], "t")
    assert.match(r.stdout, /this card has no job, so no tab/)
    // m flips the footer's mouse mode (the pane also switches mouse reporting; see the pty test).
    assert.match(t.pane([], "m").stdout.trimEnd().split("\n").at(-1), /mouse: select · drag to select text/)
  } finally {
    t.done()
  }
})

test("mouse capture off (m): one column at any width, so a drag selects one card; the open card whole; m brings the columns back (snapshots 160x45, 200x60)", () => {
  const t = setup({ agents, tabs })
  try {
    seed(t)
    const long = `Invoices round per line now, not per total. ${"Every line of this description has to be selectable in one drag. ".repeat(7)}The end of it.`
    t.board("2026-10-13T10:20:00Z", "add", "waiting", "A card whose title runs on well past the width of one row at one hundred and sixty columns, so it would be cut short with an ellipsis when it is drawn as one row of the inbox", "--desc", long, "--ask", "Read all of it, then say go", "--option", "Go")
    const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l"
    let all = ""
    for (const [width, height] of [[160, 45], [200, 60]]) {
      const size = ["--width", String(width), "--height", String(height)]
      const wide = t.pane(size).stdout
      assert.match(wide, /DOING \(2\) +TO DO \(1\)/, `${width}x${height}: the wide layout, columns side by side`)
      // m, then ↓ ↓: the long card (Waiting is oldest first) is the open one.
      const r = t.pane(size, "m\x1b[B\x1b[B")
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.startsWith(MOUSE_OFF), "m turned mouse reporting off")
      const text = r.stdout.slice(MOUSE_OFF.length)
      const lines = text.trimEnd().split("\n")
      // One column: every section header starts its own line, and no line holds two cards' text.
      for (const head of ["WAITING ON YOU", "DOING", "TO DO"]) assert.match(text, new RegExp(`^▸? ?${head} \\(\\d+\\) ─+$`, "m"), `${width}x${height}: ${head} across the width`)
      assert.ok(!lines.some((l) => /DOING.*TO DO|Export to CSV.*Nightly|Billing fix.*Old question/.test(l)), "no two columns on a line")
      // The selected card is open whole: the title wraps, every word of the description is there.
      const flat = lines.map((l) => l.trim()).join(" ")
      assert.ok(flat.includes(long), `${width}x${height}: the whole description`)
      assert.ok(flat.includes("drawn as one row of the inbox"), "the whole title")
      assert.ok(!lines.slice(0, lines.length - 1).some((l) => l.replace("Other…", "").includes("…")), "nothing cut with …")
      assert.match(lines.at(-1), /m gives the mouse and the columns back/, "the key line says how to get back")
      all += `===== m (mouse capture off) · ${width}x${height} =====\n${text}`
      // m again: the columns are back.
      assert.match(t.pane(size, "mm").stdout, /DOING \(2\) +TO DO \(1\)/)
    }
    const snap = join(FIXTURES, "select-plain.txt")
    if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, all)
    assert.equal(all, readFileSync(snap, "utf8"), "snapshot select-plain.txt (UPDATE_SNAPSHOTS=1 to rewrite)")
  } finally {
    t.done()
  }
})

test("the live pane in a terminal: mouse capture off and on with m, OSC 52 only on c, all restored on exit", { skip: !/util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "") && "needs util-linux script" }, async () => {
  const t = setup()
  try {
    t.board(NOW, "add", "waiting", "Release notes: approve", "--desc", "Draft at https://docs.example/notes", "--ask", "Read it")
    const child = spawn("script", ["-qefc", `stty cols 88 rows 24; exec node ${JSON.stringify(PANE)} --board ${JSON.stringify(t.file)}`, "/dev/null"], { cwd: t.base, env: { ...t.env, HERDR_ENV: "0" } })
    let out = ""
    child.stdout.on("data", (d) => (out += d.toString("latin1")))
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))
    await pause(1200)
    for (const key of ["m", "c", "m", "q"]) {
      child.stdin.write(key)
      await pause(500)
    }
    await new Promise((r) => (child.exitCode === null ? child.on("exit", r) : r()))
    const marks = []
    for (const [re, name] of [
      [/\x1b\[\?1000h\x1b\[\?1006h/g, "on"],
      [/\x1b\[\?1000l\x1b\[\?1006l/g, "off"],
      [/\x1b\]52;c;[A-Za-z0-9+/=]*\x07/g, "copy"],
      [/\x1b\[\?1049l/g, "leave"],
    ]) {
      for (const m of out.matchAll(re)) marks.push([m.index, name])
    }
    assert.deepEqual(marks.sort((a, b) => a[0] - b[0]).map((m) => m[1]), ["on", "off", "copy", "on", "off", "leave"])
    assert.deepEqual(decode52(out), ["https://docs.example/notes"])
    assert.match(out, /mouse: select/)
  } finally {
    t.done()
  }
})

test("renderBoard: hyperlinks only with links on; the details panel covers the cards under it", () => {
  const state = {
    items: [
      { id: 1, title: "See https://a.example/x", column: "waiting", since: NOW, updated: NOW, desc: "", ask: "" },
      ...Array.from({ length: 6 }, (_, i) => ({ id: i + 2, title: `Later ${i + 2}`, column: "todo", since: NOW, updated: NOW, desc: "", ask: "" })),
    ],
  }
  const view = buildView(state, null, { now: new Date(NOW) })
  const plain = renderBoard(view, { width: 88, height: 30, interactive: true, now: new Date(NOW) })
  assert.doesNotMatch(plain.text, /\x1b/)
  const linked = renderBoard(view, { width: 88, height: 30, interactive: true, links: true, now: new Date(NOW) })
  assert.match(linked.text, /\x1b\]8;;https:\/\/a\.example\/x\x1b\\https:\/\/a\.example\/x\x1b\]8;;\x1b\\/)
  const opened = renderBoard(view, { width: 88, height: 30, interactive: true, now: new Date(NOW), scroll: { ...plain.scroll, detail: { key: "#1", offset: 0 } } })
  assert.ok(opened.regions.detail)
  assert.ok(opened.cardHits.every((c) => c.y < opened.regions.detail.top), "no card can be clicked under the panel")
  // A click inside the panel does nothing; outside, it closes the panel.
  assert.ok(handleInput(opened.scroll, { type: "click", x: 5, y: opened.regions.detail.top + 1 }, opened).scroll.detail)
  assert.equal(handleInput(opened.scroll, { type: "click", x: 5, y: 3 }, opened).scroll.detail, undefined)
})

test("a report nested 10,000 arrays deep, or such a title, never crashes: it reads \"(not text)\"", () => {
  const t = setup({ agents, tabs })
  try {
    const report = seed(t)
    const deep = `${"[".repeat(10_000)}"x"${"]".repeat(10_000)}`
    writeFileSync(report, `{"status":"done","summary":${deep},"needs_user":[${deep}],"ids":{"pr":${deep},"branch":${deep}}}`)
    for (const keys of ["\t\r", "\t\rG", "\tc", "\t\rc"]) {
      const r = t.pane([], keys)
      assert.equal(r.status, 0, `${JSON.stringify(keys)}: ${r.stderr}`)
      assert.doesNotMatch(r.stdout + r.stderr, /RangeError|Maximum call stack/)
    }
    const shown = t.pane(["--height", "80"], "\t\r").stdout
    assert.match(shown, /\(not text\)/)
    assert.match(shown, /From the job\n {2}Job search-ui is working/, "the rest still shows")
    // job-report reads the same report: needs_user that isn't text becomes "(not text)".
    t.board(NOW, "job-report", "search-ui", report)
    const card = JSON.parse(readFileSync(t.file, "utf8")).items.find((i) => i.job === "search-ui")
    assert.deepEqual([card.column, card.ask], ["waiting", "(not text)"])
    // A hand-edited board with such a title and a job that is an object.
    const board = JSON.parse(readFileSync(t.file, "utf8"))
    writeFileSync(t.file, JSON.stringify(board).replace('"title":"Export to CSV"', `"title":${deep}`).replace('"job":"docs-links"', '"job":{"a":1}'))
    const ls = spawnSync(process.execPath, [BOARD, "ls", "--width", "88"], { cwd: t.base, env: { ...t.env, HERDR_ENV: "0" }, encoding: "utf8" })
    assert.equal(ls.status, 0, ls.stderr)
    assert.match(ls.stdout, /\(not text\)/)
    assert.equal(t.pane([], "\t\t\r").status, 0)
    assert.equal(asText([[["x"]]]), "(not text)")
    assert.equal(asText(7), "7")
    assert.equal(asText(null), "")
  } finally {
    t.done()
  }
})

test("format characters (zero-width and the like) are stripped when stored and never part of a link", () => {
  const hidden = "\u200b\u200c\u200d\u2060\ufeff\u00ad\u202e"
  assert.deepEqual(findUrls(`https://a.example/pa\u200bth`).map((u) => u.url), ["https://a.example/pa"])
  assert.deepEqual(findUrls(`https://a.example/x\ufeffy and https://b.example/\u2060z`).map((u) => u.url), ["https://a.example/x", "https://b.example/"])
  const t = setup()
  try {
    t.board(NOW, "add", "waiting", `Re${hidden}view`, "--desc", `See https://a.example/pa${hidden}th`, "--ask", `Say${hidden} go`, "--option", `G${hidden}o`)
    const [item] = JSON.parse(readFileSync(t.file, "utf8")).items
    assert.equal(item.title, "Review")
    assert.equal(item.desc, "See https://a.example/path")
    assert.equal(item.ask, "Say go")
    assert.equal(item.options[0].label, "Go")
    // A hand-written board: the pane doesn't show them either.
    writeFileSync(t.file, JSON.stringify({ version: 1, next_id: 2, items: [{ id: 1, title: `x${hidden}y https://c.example/p${hidden}q`, column: "todo", since: NOW, updated: NOW }] }))
    const r = t.pane(["--links"])
    assert.doesNotMatch(r.stdout, /[\u200b-\u200d\u2060\ufeff\u00ad\u202e]/u)
  } finally {
    t.done()
  }
})

test("Alt+c (ESC c in one read) is not c: no copy; Esc on its own is still Esc", () => {
  assert.deepEqual(parseInput("\x1bc"), [])
  assert.deepEqual(parseInput("\x1bc\x1bm\x1bt\x1bq"), [], "no Alt chord acts as its key")
  assert.deepEqual(parseInput("\x1b").map((e) => e.name), ["escape"])
  assert.deepEqual(parseInput("\x1b\x1b").map((e) => e.name), ["escape", "escape"])
  assert.deepEqual(parseInput("\x1b\x1b[A").map((e) => e.name), ["escape", "up"])
  assert.deepEqual(parseInput("\x1béxc").map((e) => e.name), ["copy"], "a multi-byte Alt chord is skipped whole")
  const t = setup({ agents, tabs })
  try {
    seed(t)
    assert.deepEqual(decode52(t.pane([], "\x1b[B\x1bc").stdout), [])
    assert.deepEqual(decode52(t.pane([], "\x1b[Bc").stdout), ["http://localhost:3000/invoices"])
  } finally {
    t.done()
  }
})

test("the report is read once while it doesn't change (cached by mtime and size)", () => {
  const t = setup()
  try {
    const path = join(t.base, "cached.json")
    writeFileSync(path, JSON.stringify({ status: "done", summary: "first" }))
    const before = { ...reportCacheStats }
    assert.equal(reportFacts(path).summary, "first")
    assert.equal(reportFacts(path).summary, "first")
    assert.equal(reportFacts(path).summary, "first")
    assert.equal(reportCacheStats.reads - before.reads, 1, "one read")
    assert.equal(reportCacheStats.hits - before.hits, 2, "two hits")
    writeFileSync(path, JSON.stringify({ status: "done", summary: "second, longer" }))
    assert.equal(reportFacts(path).summary, "second, longer", "a changed file is read again")
    assert.equal(reportCacheStats.reads - before.reads, 2)
    rmSync(path)
    assert.deepEqual(reportFacts(path), { unavailable: true, missing: true }, "a removed file is unavailable, not cached")
  } finally {
    t.done()
  }
})

// --- the working bar and Done folded (0.3.3) ---------------------------------------------------

/** seed() plus two more Doing jobs: Doing has working (with a final report), idle, working and no agent. */
const motionAgents = [
  { name: "search-ui", agent_status: "working", workspace_id: "w9", pane_id: "w9:p5", tab_id: "w9:t5" },
  { name: "docs-links", agent_status: "idle", workspace_id: "w9", pane_id: "w9:p6", tab_id: "w9:t6" },
  { name: "api-client", agent_status: "working", workspace_id: "w9", pane_id: "w9:p7", tab_id: "w9:t7" },
]
function seedMotion(t) {
  seed(t)
  t.board("2026-10-13T10:10:00Z", "job-start", "api-client", "--title", "API client: regenerate", "--desc", "From the new OpenAPI file.")
  t.board("2026-10-13T10:12:00Z", "job-start", "release-notes", "--title", "Release notes: draft")
}
const BAR = /\[[ =]{4}\]/g
const barsOf = (text) => text.match(BAR) ?? []

test("board snapshots: Done folded (default) and open, Doing with working and idle cards; 120 and 88 columns; colour on and off; the bar's frame injected", () => {
  const t = setup({ agents: motionAgents, tabs })
  try {
    seedMotion(t)
    for (const [name, flags] of [["board-motion-plain.txt", []], ["board-motion-color.txt", ["--color"]]]) {
      let all = ""
      for (const width of [120, 88]) {
        for (const [label, keys, frame] of [["Done folded · frame 0", "", 0], ["Done open (d) · frame 3", "d", 3]]) {
          const r = t.pane(["--width", String(width), "--height", "40", "--frame", String(frame), ...flags], keys)
          assert.equal(r.status, 0, r.stderr)
          all += `===== ${label} · ${width} columns =====\n${r.stdout}`
        }
      }
      const snap = join(FIXTURES, name)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, all)
      assert.equal(all, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }
    // At 100 in the wide layout with Done open, Doing is 31 cells: "working, report done" fits,
    // with the bar it wouldn't, so that card keeps its words and goes without. The inbox (88)
    // has the row's width for it.
    for (const [width, keys, bars, layout] of [[120, "", 2], [120, "d", 2], [88, "", 2], [88, "d", 2], [100, "d", 1, "wide"]]) {
      if (layout) continue // --once has no layout flag: this one is checked with renderBoard below
      const at = (frame) => t.pane(["--width", String(width), "--height", "40", ...(frame == null ? [] : ["--frame", String(frame)])], keys).stdout
      assert.deepEqual(barsOf(at(null)), [], "no frame: nothing moves (ls, --once)")
      // Only working cards carry the bar; every frame is the same screen but for it.
      const first = at(0)
      for (let f = 0; f < WORKING_FRAMES.length; f++) {
        const text = at(f)
        assert.deepEqual(barsOf(text), Array(bars).fill(WORKING_FRAMES[f]), `${width}${keys}: frame ${f} on the working cards`)
        assert.equal(text.replace(BAR, "[bar]"), first.replace(BAR, "[bar]"), `${width}${keys}: frame ${f} moves nothing else`)
      }
      assert.match(first, / {2}working \[=   \]/)
      if (bars === 2) assert.match(first, / {2}working, report done \[=   \]/, "after the report too")
      else assert.match(first, / {2}working, report done(?! \[)/)
      assert.match(first, / {2}idle(?! \[)/, "idle stands still")
      assert.match(first, / {2}no agent(?! \[)/, "no agent stands still")
    }
    {
      const state = JSON.parse(readFileSync(t.file, "utf8"))
      const view = buildView(state, motionAgents, { now: new Date(NOW), workspace: "w9" })
      const text = renderBoard(view, { width: 88, height: 40, interactive: true, now: new Date(NOW), frame: 0, layout: "wide", scroll: { selected: "waiting", anchors: {}, doneOpen: true } }).text
      assert.deepEqual(barsOf(text), [WORKING_FRAMES[0]], "wide at 88 with Done open: one bar")
      assert.match(text, / {2}working, report done(?! \[)/, "the words, without the bar")
    }
    // Colour: the bar is the working green; NO_COLOR or no --color, plain text.
    const on = t.pane(["--width", "88", "--height", "40", "--frame", "0", "--color"]).stdout
    assert.ok(on.includes(`${ESC}[32m [=   ]${ESC}[0m`), "green, like working")
    assert.deepEqual(sequences(t.pane(["--width", "88", "--height", "40", "--frame", "0"]).stdout), [])
  } finally {
    t.done()
  }
})

test("the working bar: only on screen counts (scrolled away or under the details, none); the timer runs only while one shows", () => {
  const t = setup({ agents: motionAgents, tabs })
  try {
    seedMotion(t)
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const draw = (agents, scroll = {}, opts = {}) =>
      renderBoard(buildView(state, agents, { now: new Date(NOW), workspace: "w9" }), { width: 88, height: 40, interactive: true, now: new Date(NOW), frame: 2, layout: "wide", scroll: { selected: "waiting", anchors: {}, ...scroll }, ...opts })
    // `animated` counts exactly the bars on screen (in the wide layout at 88, where the panel
    // covers one of the two working cards).
    const counted = (drawn) => {
      assert.equal(drawn.animated, barsOf(drawn.text).length, "animated = bars drawn")
      return drawn.animated
    }
    assert.equal(counted(draw(motionAgents)), 2, "two working cards on screen")
    assert.equal(counted(draw(motionAgents, {}, { frame: undefined })), 0, "no frame: still")
    const idle = motionAgents.map((a) => ({ ...a, agent_status: "idle" }))
    assert.equal(counted(draw(idle)), 0, "none working")
    assert.equal(counted(draw(null)), 0, "Herdr unreadable: no live status at all")
    // The details panel covers the lower half: bars under it don't count.
    assert.equal(counted(draw(motionAgents, { detail: { key: "#1", offset: 0 } })), 1, "one working card above the panel, one under it")
    assert.equal(counted(draw(motionAgents, { detail: { key: "#1", offset: 0 } }, { height: 24 })), 0, "both under it")
    assert.ok(counted(draw(motionAgents, {}, { height: 24 })) >= 1, "while without it one shows")
    // Scrolled so the working cards are above the view: none on screen. (Doing: 3 search-ui, 4
    // docs-links, 7 api-client, 8 release-notes; a short pane shows one Doing card at a time.)
    const short = (anchor) => draw(motionAgents, { anchors: { doing: { key: anchor, index: 0 } } }, { height: 16 })
    assert.equal(counted(short("#3")), 1)
    assert.equal(counted(short("#4")), 0, "the idle card in view, the working ones scrolled away")

    // The timer: started once while a bar shows, stopped when none does, never two at once.
    const calls = []
    const timer = animationTimer(() => {}, { start: (fn, ms) => (calls.push(["start", ms]), calls.length), stop: (h) => calls.push(["stop", h]) })
    for (const drawn of [draw(motionAgents), draw(motionAgents), draw(idle), draw(idle), draw(motionAgents), draw(motionAgents, { detail: { key: "#1", offset: 0 } }, { height: 24 })]) timer.sync(drawn.animated > 0)
    assert.deepEqual(calls, [["start", TICK_MS], ["stop", 1], ["start", TICK_MS], ["stop", 3]])
    assert.equal(timer.running, false)
    assert.ok(TICK_MS >= 125 && TICK_MS <= 250, "4 to 8 frames a second")

    // On or off by the environment: JOB_BOARD_ANIMATION=0 (off, false, no) and TERM=dumb keep it still.
    assert.equal(animates({}), true)
    assert.equal(animates({ NO_COLOR: "1" }), true, "NO_COLOR: it still moves, uncoloured")
    for (const value of ["0", "off", "false", "no", " OFF "]) assert.equal(animates({ JOB_BOARD_ANIMATION: value }), false, value)
    assert.equal(animates({ JOB_BOARD_ANIMATION: "1" }), true)
    assert.equal(animates({ TERM: "dumb" }), false)
  } finally {
    t.done()
  }
})

test("barTick: a tick rewrites only the bars, in place, and the screen then is the board drawn at that frame", () => {
  const t = setup({ agents: motionAgents, tabs })
  try {
    seedMotion(t)
    const state = JSON.parse(readFileSync(t.file, "utf8"))
    const view = buildView(state, motionAgents, { now: new Date(NOW), workspace: "w9" })
    for (const [width, scroll] of [[88, {}], [120, {}], [60, {}], [88, { doneOpen: true }], [120, { doneOpen: true }]]) {
      for (const color of [false, true]) {
        const draw = (frame) => renderBoard(view, { width, height: 40, color, interactive: true, now: new Date(NOW), frame, scroll: { selected: "waiting", anchors: {}, ...scroll } })
        const base = draw(0)
        assert.ok(base.bars.length > 0)
        for (let f = 1; f < WORKING_FRAMES.length + 2; f++) {
          const patch = barTick(base, f, color)
          // Only cursor moves and the bar, painted as the board paints it.
          const cell = color ? `${ESC}\\[32m \\[[ =]{4}\\]${ESC}\\[0m` : " \\[[ =]{4}\\]"
          assert.match(patch, new RegExp(`^(?:${ESC}\\[\\d+;\\d+H${cell})+$`))
          // Applied to the plain screen, it gives the board drawn at frame f.
          if (!color) {
            const screen = base.text.split("\n").map((l) => [...l])
            for (const m of patch.matchAll(/\x1b\[(\d+);(\d+)H([^\x1b]+)/g)) screen[m[1] - 1].splice(m[2] - 1, m[3].length, ...m[3])
            assert.equal(screen.map((l) => l.join("")).join("\n"), draw(f).text, `${width} ${JSON.stringify(scroll)}: frame ${f}`)
          } else {
            assert.ok(draw(f).text.includes(`${ESC}[32m ${WORKING_FRAMES[f % WORKING_FRAMES.length]}${ESC}[0m`), "the same paint as the board's")
          }
        }
      }
    }
    assert.equal(barTick({ bars: [] }, 3, true), "", "no bars, nothing to write")
    assert.equal(barTick(null, 3, true), "")
  } finally {
    t.done()
  }
})

test("screenDiff: only changed lines are rewritten; a new size rewrites all and clears below", () => {
  const w = (l) => [...l].length
  assert.equal(screenDiff(["a", "b", "c"], ["a", "b", "c"], 10, w), "")
  assert.equal(screenDiff(["a", "b", "c"], ["a", "B", "c"], 10, w), `${ESC}[2;1HB${ESC}[K`)
  assert.equal(screenDiff(["a", "b"], ["a", "b", "c"], 10, w), `${ESC}[1;1Ha${ESC}[K${ESC}[2;1Hb${ESC}[K${ESC}[3;1Hc${ESC}[K${ESC}[J`)
  assert.equal(screenDiff([], ["xx"], 2, w), `${ESC}[1;1Hxx${ESC}[J`, "a full line is not cleared to its end")
  assert.equal(screenDiff(["a"], [], 10, w), `${ESC}[H${ESC}[J`)
  assert.equal(screenDiff(["a", null, "c"], ["a", "b", "c"], 10, w), `${ESC}[2;1Hb${ESC}[K`, "a line a tick wrote is rewritten by the next paint")
})

test("the live pane: the bar moves about 6 times a second rewriting only its line, and stops once nothing is working; JOB_BOARD_ANIMATION=0 keeps it still", { skip: !/util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "") && "needs util-linux script" }, async () => {
  const t = setup({ agents: [{ name: "api-client", agent_status: "working", workspace_id: "w9", pane_id: "w9:p7", tab_id: "w9:t7" }] })
  const herdrFile = t.env.FAKE_HERDR_STATE
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const children = []
  const run = (extraEnv = {}) => {
    // Its own process group, so a failed assertion can't leave the pane running.
    const child = spawn("script", ["-qefc", `stty cols 121 rows 24; exec node ${JSON.stringify(PANE)} --board ${JSON.stringify(t.file)} --interval 1`, "/dev/null"], { cwd: t.base, env: { ...t.env, ...extraEnv }, detached: true })
    children.push(child)
    const run = { out: "", child }
    child.stdout.on("data", (d) => (run.out += d.toString("latin1")))
    run.quit = async () => {
      child.stdin.write("q")
      await new Promise((r) => (child.exitCode === null ? child.on("exit", r) : r()))
    }
    return run
  }
  // The fake Herdr rewrites its file on every call: change it under its lock.
  const setStatus = (status) => {
    for (;;) {
      try {
        mkdirSync(`${herdrFile}.lock`)
        break
      } catch {}
    }
    try {
      const state = JSON.parse(readFileSync(herdrFile, "utf8"))
      state.agents[0].agent_status = status
      writeFileSync(herdrFile, JSON.stringify(state))
    } finally {
      rmSync(`${herdrFile}.lock`, { recursive: true, force: true })
    }
  }
  try {
    t.board(NOW, "job-start", "api-client", "--title", "API client: regenerate")
    const live = run({ NO_COLOR: "1" })
    await pause(1500)
    // After the first full draw (it ends clearing the rest of the screen), each tick rewrites only
    // the bar, in place, just after "working".
    const first = live.out.indexOf(`${ESC}[J`)
    assert.ok(first > 0, "the first draw")
    const plain = live.out.slice(first + 3).replace(/\x1b\[\?2026[hl]/g, "")
    const ticks = [...plain.matchAll(/\x1b\[(\d+);(\d+)H (\[[ =]{4}\])/g)]
    assert.ok(ticks.length >= 5, `about 6 ticks a second (saw ${ticks.length} in 1.5 s)`)
    assert.deepEqual([...new Set(ticks.map((m) => `${m[1]};${m[2]}`))], [`${ticks[0][1]};10`], "always the same place: after '  working'")
    // Nothing else is written, but for a refresh rewriting that same line whole.
    const rest = plain.replace(/\x1b\[\d+;\d+H \[[ =]{4}\]/g, "")
    assert.equal(rest.replace(new RegExp(`\\x1b\\[${ticks[0][1]};1H {2}working \\[[ =]{4}\\]\\x1b\\[K`, "g"), ""), "", "and nothing else is written")
    // The bars seen are the frames in order, from wherever it started.
    const seen = ticks.map((m) => m[3])
    const n = WORKING_FRAMES.length
    assert.ok(WORKING_FRAMES.some((_, k) => seen.every((bar, i) => bar === WORKING_FRAMES[(k + i) % n])), `frames in order: ${seen.join(" ")}`)
    // The agent goes idle: within a refresh the card says so, and then nothing is written at all.
    setStatus("idle")
    await pause(1600)
    assert.match(live.out.slice(-400), / {2}idle\x1b\[K/)
    const mark = live.out.length
    await pause(1200)
    assert.equal(live.out.slice(mark), "", "no timer, no writes, once nothing is working")
    await live.quit()

    // JOB_BOARD_ANIMATION=0: still, from the start.
    setStatus("working")
    const still = run({ JOB_BOARD_ANIMATION: "0", NO_COLOR: "1" })
    await pause(900)
    const before = still.out.length
    assert.match(still.out, / {2}working\x1b\[K/)
    assert.deepEqual(barsOf(still.out), [])
    await pause(700)
    assert.equal(still.out.length, before, "nothing moves")
    await still.quit()
  } finally {
    for (const child of children) {
      try {
        if (child.exitCode === null) process.kill(-child.pid, "SIGKILL")
      } catch {}
    }
    t.done()
  }
})

test("copy: a card whose job is blocked copies without its hidden buttons", () => {
  const t = setup({ agents: [{ name: "namer", agent_status: "blocked", workspace_id: "w9", pane_id: "w9:p4", tab_id: "w9:t4" }], tabs })
  try {
    t.board(NOW, "add", "waiting", "Pick a name", "--job", "namer", "--ask", "Choose one", "--option", "Alpha", "--option", "Beta", "--suggest", "Alpha")
    assert.deepEqual(decode52(t.pane([], "c").stdout), ["#1 Pick a name\n\n→ Choose one"])
    const card = { id: 1, title: "Pick a name", ask: "Choose one", column: "waiting", options: [{ label: "Alpha", suggested: true }, { label: "Beta" }] }
    assert.equal(copyPayload({ ...card, live: "" }).text, "#1 Pick a name\n\n→ Choose one\n\nbuttons: Alpha · Beta", "buttons on screen are copied")
    assert.equal(copyPayload({ ...card, live: "blocked" }).text, "#1 Pick a name\n\n→ Choose one", "hidden ones never")
    assert.equal(copyPayload({ ...card, column: "doing", live: "" }).text, "#1 Pick a name\n\n→ Choose one", "nor on a card out of Waiting")
  } finally {
    t.done()
  }
})

// --- the question reads as text, the buttons as buttons (0.3.4) -------------------------------

/** A board like the one that misled the user: a long question over 3 buttons and Other…, sent once. */
function seedQuestion(t) {
  t.board("2026-10-13T03:14:00Z", "add", "waiting", "Release v1.4: all reviewed, approve?", "--desc", "All PRs reviewed OK: #12 invoice rounding, #14 docs move, #15 search filters, #17 export to CSV (+ optional #16 dark mode).", "--ask", "Approve the whole release (merges, tag v1.4, deploy to production, then the data backfill)? Include #16 or keep it for later?", "--option", "Approve, include #16", "--option", "Approve, #16 later", "--option", "Not yet", "--suggest", "Approve, include #16")
  markSent(t.file, 1, "Approve, include #16", new Date("2026-10-13T10:08:00Z"))
  t.board("2026-10-13T10:00:00Z", "add", "waiting", "Pick a name", "--ask", "Which name?", "--option", "Alpha", "--option", "Beta")
  t.board("2026-10-13T10:10:00Z", "add", "waiting", "Docs move (PR #14): merge", "--ask", "Say merge (after #12)")
}
// A click on the first line that has `text` (after the line that has `after`), from a plain screen.
const clickOn = (screen, text, after = "") => {
  const lines = screen.split("\n")
  const from = after ? lines.findIndex((l) => l.includes(after)) : 0
  const y = lines.findIndex((l, i) => i > from - (after ? 0 : 1) && l.includes(text))
  assert.ok(y >= 0, `"${text}" on screen`)
  return `\x1b[<0;${[...lines[y].slice(0, lines[y].indexOf(text))].length + 3};${y + 1}M`
}
const BUTTON_CODES = ["30;47", "1;30;47", "1;97;44"]

test("question snapshots: the ask as text with its buttons right under it, then what was sent; nothing chosen, → chosen, a click on the question, in the details; 120 and 88 columns; colour on and off", () => {
  const t = setup({ agents, tabs })
  try {
    seedQuestion(t)
    for (const [name, flags] of [["question-plain.txt", []], ["question-color.txt", ["--color"]]]) {
      let all = ""
      for (const width of [120, 88]) {
        const size = ["--width", String(width), "--height", "40"]
        const plain = t.pane(size).stdout
        for (const [label, keys] of [
          ["nothing chosen", ""],
          ["→ chooses the suggested button", "\x1b[C"],
          ["a click on the question", clickOn(plain, "Question: Approve")],
          ["details, a click on the question", "\r" + clickOn(t.pane(size, "\r").stdout, "Question: Approve", "── card 1")],
        ]) {
          const r = t.pane([...size, ...flags], keys)
          assert.equal(r.status, 0, r.stderr)
          all += `===== ${label} · ${width} columns =====\n${r.stdout}`
        }
      }
      const snap = join(FIXTURES, name)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, all)
      assert.equal(all, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }
    // The card reads top to bottom: the question, its buttons right under it, then what was sent.
    // (The inbox at 88 shows the selected card's: card 1 first, then card 3 two rows down.)
    for (const width of [120, 88]) {
      const screen = t.pane(["--width", String(width), "--height", "40"]).stdout
      const indent = width < 120 ? " {5}" : " {2}"
      assert.match(screen, new RegExp(`Question: Approve the whole release[^\\n]*\\n(?: +[^\\n]*\\n)?${indent}\\[ Approve, include #16 ✓ \\] {2}\\[ Approve, #16 later \\]`), `${width}: buttons straight under the question`)
      assert.match(screen, new RegExp(`\\[ Other… \\][^\\n]*\\n${indent}sent: Approve, include #16 · 10:08`), `${width}: sent after the buttons`)
      assert.match(width < 120 ? t.pane(["--width", "88", "--height", "40"], "\x1b[B\x1b[B").stdout : screen, /Needs you: Say merge \(after #12\)/, `${width}: a question with no buttons`)
      assert.doesNotMatch(screen, /→ /, `${width}: no arrow`)
    }
    // No button in the question's style, and the question in none of the buttons': with colour,
    // the label is dim, the words carry no style, and every button (chosen or not) is filled.
    const on = t.pane(["--width", "120", "--height", "40", "--color"], "\x1b[C").stdout
    assert.ok(on.includes(`${ESC}[2mQuestion:${ESC}[0m Approve the whole release`), "dim label, plain words")
    const buttonCodes = [...on.matchAll(/\x1b\[([0-9;]*)m[[<] /g)].map((m) => m[1])
    assert.ok(buttonCodes.length >= 7, "every button found")
    for (const code of buttonCodes) assert.ok(BUTTON_CODES.includes(code), `button drawn in ${code}`)
    assert.ok(buttonCodes.includes("1;97;44"), "the chosen one, filled blue")
    const askCodes = [...on.matchAll(/\x1b\[([0-9;]*)m(?:Question:|Needs you:)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(askCodes)], ["2"])
    assert.ok(!BUTTON_CODES.includes("2"))
  } finally {
    t.done()
  }
})

test("a click on the question chooses the suggested button (or the first) and says Enter to send; it never sends, on the board or in the details", () => {
  const t = setup({ agents, tabs })
  try {
    seedQuestion(t)
    const view = buildView(JSON.parse(readFileSync(t.file, "utf8")), null, { now: new Date(NOW) })
    // Wide, where every card shows its question (at 120, and at 88 too); the inbox below.
    for (const [width, layout] of [[120], [88, "wide"]]) {
      const draw = (scroll) => renderBoard(view, { width, height: 60, interactive: true, now: new Date(NOW), layout, scroll })
      const lastLine = (d) => d.text.split("\n").at(-1)
      const click = (d, hit, at = 0) => handleInput(d.scroll, { type: "click", x: hit.x0 + 1, y: hit.y, at }, d)
      let drawn = draw({ selected: "todo", anchors: {} })
      assert.doesNotMatch(lastLine(drawn), /Enter to send/, `${width}: no hint before a button is chosen`)
      // Questions and buttons never share a cell: a click is one or the other.
      for (const a of drawn.askHits) assert.ok(!drawn.buttons.some((b) => b.y === a.y && b.x0 <= a.x1 && a.x0 <= b.x1), `${width}: a question cell is also a button's`)
      // Card 1: the suggested button is the first.
      let r = click(drawn, drawn.askHits.find((a) => a.key === "#1"))
      assert.equal(r.action, null, `${width}: nothing sent`)
      assert.deepEqual([r.scroll.selected, r.scroll.card, r.scroll.button], ["waiting", "#1", 0])
      drawn = draw(r.scroll)
      assert.match(drawn.text, /< Approve, include #16 ✓ >/)
      assert.match(lastLine(drawn), /^Enter to send · ←→ choose · Esc cancel/, `${width}: the hint`)
      // Clicking it again changes nothing and still sends nothing.
      r = click(drawn, drawn.askHits.find((a) => a.key === "#1"), 5000)
      assert.deepEqual([r.action, r.scroll.button], [null, 0])
      // Enter then sends the chosen one; Esc un-chooses it instead.
      assert.deepEqual(handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn).action, { type: "send", id: 1, key: "#1", label: "Approve, include #16" })
      assert.equal(handleInput(drawn.scroll, { type: "key", name: "escape" }, drawn).scroll.button, -1)
      // Card 2 has no --suggest: its first button.
      r = click(drawn, drawn.askHits.find((a) => a.key === "#2"))
      assert.deepEqual([r.action, r.scroll.card, r.scroll.button], [null, "#2", 0])
      // Card 3 has no buttons: the click only selects it.
      r = click(draw(r.scroll), drawn.askHits.find((a) => a.key === "#3"))
      assert.deepEqual([r.action, r.scroll.card, r.scroll.button], [null, "#3", -1])
      assert.doesNotMatch(lastLine(draw(r.scroll)), /Enter to send/)
      // A double click on the question opens the details, with no button chosen.
      drawn = draw({ selected: "todo", anchors: {} })
      const q = drawn.askHits.find((a) => a.key === "#1")
      r = click(drawn, q, 1000)
      drawn = draw(r.scroll)
      r = click(drawn, drawn.askHits.find((a) => a.key === "#1"), 1100)
      assert.deepEqual([r.action, r.scroll.detail?.key, r.scroll.button], [null, "#1", -1])
      // In the details: the same, on the panel's question.
      drawn = draw(r.scroll)
      assert.doesNotMatch(lastLine(drawn), /Enter to send/)
      const inPanel = drawn.askHits.find((a) => a.panel && a.key === "#1")
      assert.ok(inPanel && inPanel.y >= drawn.regions.detail.top, `${width}: the panel's question can be clicked`)
      assert.ok(!drawn.askHits.some((a) => !a.panel && a.y >= drawn.regions.detail.top), `${width}: the board's under the panel can't`)
      r = click(drawn, inPanel)
      assert.deepEqual([r.action, r.scroll.detail?.key, r.scroll.button], [null, "#1", 0], `${width}: chosen in the panel, not sent`)
      drawn = draw(r.scroll)
      assert.match(drawn.text, /── card 1[^\n]*\n(?:.*\n)*? {2}< Approve, include #16 ✓ >/)
      assert.match(lastLine(drawn), /^Enter to send · Esc close/)
      assert.deepEqual(handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn).action, { type: "send", id: 1, key: "#1", label: "Approve, include #16" })
      // Other… chosen: Enter opens the chat, and the hint says so.
      drawn = draw({ ...drawn.scroll, button: 3 })
      assert.match(lastLine(drawn), /^Enter to answer in the chat/)
    }
    // The inbox: only the selected card shows its question; a click on it chooses, never sends.
    {
      const draw = (scroll) => renderBoard(view, { width: 88, height: 40, interactive: true, now: new Date(NOW), scroll })
      const click = (d, hit) => handleInput(d.scroll, { type: "click", x: hit.x0 + 1, y: hit.y, at: 0 }, d)
      let drawn = draw()
      assert.equal(drawn.layout, "inbox")
      assert.deepEqual([...new Set(drawn.askHits.map((a) => a.key))], ["#1"], "one question on screen: the selected card's")
      let r = click(drawn, drawn.askHits[0])
      assert.deepEqual([r.action, r.scroll.card, r.scroll.button], [null, "#1", 0], "chosen, not sent")
      drawn = draw(r.scroll)
      assert.match(drawn.text.split("\n").at(-1), /^Enter to send/)
      assert.deepEqual(handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn).action, { type: "send", id: 1, key: "#1", label: "Approve, include #16" })
      // ↓ opens the next card: card 2's first button (no --suggest) by a click on its question.
      drawn = draw(handleInput(draw().scroll, { type: "key", name: "down" }, draw()).scroll)
      r = click(drawn, drawn.askHits.find((a) => a.key === "#2"))
      assert.deepEqual([r.action, r.scroll.card, r.scroll.button], [null, "#2", 0])
      // In the details: the panel's question, the same.
      drawn = draw({ ...draw().scroll, detail: { key: "#1", offset: 0 } })
      r = click(drawn, drawn.askHits.find((a) => a.panel))
      assert.deepEqual([r.action, r.scroll.detail?.key, r.scroll.button], [null, "#1", 0])
    }
    // End to end through the pane and the fake Herdr: clicks on the question send nothing.
    const size = ["--width", "120", "--height", "40"]
    const click = clickOn(t.pane(size).stdout, "Question: Approve")
    const r = t.pane(size, click + click.replace(/M$/, "m"))
    assert.match(r.stdout, /< Approve, include #16 ✓ >/)
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /^Enter to send/)
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && (a[1] === "prompt" || a[1] === "focus")), [], "no prompt, no focus")
    // Enter after it: card 1 was answered already, so it asks first, as any press does.
    assert.match(t.pane(size, `${click}\r`).stdout.replace(/\n {2}/g, " "), /send again\? "Approve, include #16" was sent already/)
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && a[1] === "prompt"), [])
    // Card 2 wasn't: Enter sends exactly its first button's label.
    t.pane(size, `${clickOn(t.pane(size).stdout, "Question: Which name?")}\r`)
    assert.deepEqual(t.log().filter((a) => a[0] === "agent" && a[1] === "prompt"), [["agent", "prompt", "w9:p1", "Board card 2 (my · Pick a name): Alpha"]])
  } finally {
    t.done()
  }
})

// --- a card cut short shows no button it can't show (0.3.4 review) ------------------------------

/** A tall question card, and Doing and To do cards that leave it too little room in a short pane. */
function seedShort(t) {
  t.board("2026-10-13T03:14:00Z", "add", "waiting", "Release v1.4: all reviewed, approve?", "--desc", "All PRs reviewed OK: #12 invoice rounding, #14 docs move, #15 search filters, #17 export to CSV (+ optional #16 dark mode). Plan: merge in order (each catches up with main), tag v1.4, deploy, then run the backfill.", "--ask", "Approve the whole release (merges, tag v1.4, deploy to production, then the data backfill)? Include #16 or keep it for later?", "--option", "Approve, include #16", "--option", "Approve, #16 later", "--option", "Not yet", "--suggest", "Approve, include #16")
  t.board("2026-10-13T10:05:00Z", "add", "doing", "Search filters: build", "--desc", "The filter panel from the approved mockup, saved per user.")
  t.board("2026-10-13T10:20:00Z", "add", "doing", "Docs site: fix links", "--desc", "Check every link on the new docs site and fix the 404s.")
  t.board("2026-10-13T10:29:00Z", "add", "todo", "Export to CSV", "--desc", "Let people download any table as CSV; three asked for it.")
  t.board("2026-10-13T10:29:00Z", "add", "todo", "Dark mode", "--desc", "Follow the system theme; the colour tokens are in place.")
  t.board("2026-10-13T10:29:00Z", "add", "todo", "Upgrade the test runner", "--desc", "The current version reaches end of life next month.")
}
// The sizes where the card's question shows but its buttons don't (the review's sweep): the wide
// layout in a short pane (pinned with --layout: the pane draws compact under 24 rows), and
// compact with the selected row open (Space), the card cut under its question.
const SHORT = [
  { width: 120, height: 20, layout: "wide", keys: "", scroll: { selected: "todo" } },
  { width: 88, height: 20, layout: "wide", keys: "", scroll: { selected: "todo" } },
  { width: 60, height: 14, keys: " ", scroll: { selected: "waiting", open: true } },
  { width: 95, height: 14, keys: " ", scroll: { selected: "waiting", open: true } },
]

test("short panes (wide 120x20 and 88x20, compact 60x14 and 95x14 opened with Space): a card cut off above its buttons says so; a click on the question, ← → and Enter never choose or press a button off screen", () => {
  const t = setup({ agents, tabs })
  try {
    seedShort(t)
    const view = buildView(JSON.parse(readFileSync(t.file, "utf8")), null, { now: new Date(NOW) })
    for (const { width, height, layout, scroll: start } of SHORT) {
      const size = `${width}x${height}`
      const draw = (scroll) => renderBoard(view, { width, height, layout, interactive: true, now: new Date(NOW), scroll })
      const lastLine = (d) => d.text.split("\n").at(-1)
      const mine = (d, panel = false) => d.buttons.filter((b) => b.key === "#1" && !b.panel === !panel)
      let drawn = draw({ ...start, anchors: {} })
      // The precondition: the question on screen, none of its buttons, and a line that says the card goes on.
      assert.ok(drawn.askHits.some((a) => a.key === "#1"), `${size}: question on screen`)
      assert.deepEqual(mine(drawn), [], `${size}: buttons off screen`)
      assert.match(drawn.text, /↓ card cut off: open it for the rest/, `${size}: the cut is marked`)
      assert.doesNotMatch(drawn.text, /\[ Approve, include #16/, `${size}`)
      // A click on the question: the card is selected, nothing chosen, nothing sent, no hint.
      const q = drawn.askHits.find((a) => a.key === "#1")
      let r = handleInput(drawn.scroll, { type: "click", x: q.x0 + 1, y: q.y, at: 0 }, drawn)
      assert.deepEqual([r.action, r.scroll.selected, r.scroll.card, r.scroll.button], [null, "waiting", "#1", -1], `${size}: click`)
      drawn = draw(r.scroll)
      assert.doesNotMatch(lastLine(drawn), /Enter(?: to|:) send/, `${size}`)
      // ← → choose nothing that isn't on screen.
      for (const name of ["right", "right", "left"]) {
        r = handleInput(drawn.scroll, { type: "key", name }, drawn)
        assert.deepEqual([r.action, r.scroll.button], [null, -1], `${size}: ${name}`)
        drawn = draw(r.scroll)
      }
      // A button chosen while it showed (a taller pane, say) and now off screen: no hint, and
      // Enter opens the details, with nothing chosen, instead of pressing it.
      drawn = draw({ ...drawn.scroll, button: 0 })
      assert.doesNotMatch(lastLine(drawn), /Enter(?: to|:) send/, `${size}: stale choice`)
      r = handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn)
      assert.deepEqual([r.action, r.scroll.detail?.key, r.scroll.button], [null, "#1", -1], `${size}: Enter opens the details`)
      // In the details: the buttons are below the panel's fold. Enter with one chosen off
      // screen scrolls to it; → and a click on the question choose and scroll to it.
      drawn = draw(r.scroll)
      assert.deepEqual(mine(drawn, true), [], `${size}: panel buttons below the fold`)
      drawn = draw({ ...drawn.scroll, card: "#1", button: 0 })
      assert.doesNotMatch(lastLine(drawn), /Enter(?: to|:) send/, `${size}: chosen but off the panel`)
      r = handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn)
      assert.equal(r.action, null, `${size}: Enter didn't press an unseen button`)
      drawn = draw(r.scroll)
      assert.ok(mine(drawn, true).some((b) => b.index === 0), `${size}: Enter scrolled to it`)
      assert.match(lastLine(drawn), /^Enter(?: to|:) send · /, `${size}`)
      assert.deepEqual(handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn).action, { type: "send", id: 1, key: "#1", label: "Approve, include #16" }, `${size}: now Enter sends what is shown`)
      for (const how of ["right", "question"]) {
        drawn = draw({ ...start, selected: "waiting", anchors: {}, card: "#1", button: -1, detail: { key: "#1", offset: 0 } })
        assert.deepEqual(mine(drawn, true), [], `${size}`)
        if (how === "right") r = handleInput(drawn.scroll, { type: "key", name: "right" }, drawn)
        else {
          const pq = drawn.askHits.find((a) => a.panel && a.key === "#1")
          if (!pq) continue // the panel's question is below the fold too: nothing to click
          r = handleInput(drawn.scroll, { type: "click", x: pq.x0 + 1, y: pq.y }, drawn)
        }
        assert.deepEqual([r.action, r.scroll.button], [null, 0], `${size}: ${how}`)
        drawn = draw(r.scroll)
        const chosen = mine(drawn, true).find((b) => b.index === 0)
        assert.ok(chosen && chosen.y >= drawn.regions.detail.top, `${size}: ${how} scrolled the panel to the chosen button`)
        assert.match(drawn.text, /< Approve, include #16 ✓ >/)
        assert.match(lastLine(drawn), /^Enter(?: to|:) send · /)
      }
    }
    // Some of a card's buttons on screen (a line under them, "sent: …", is cut with the second
    // row of buttons): ← → move among those only, and Enter presses only those.
    const answered = JSON.parse(readFileSync(t.file, "utf8"))
    answered.items.find((i) => i.id === 1).sent = { label: "Not yet", at: "2026-10-13T09:00:00Z" }
    const partView = buildView(answered, null, { now: new Date(NOW) })
    let partial = null
    for (const width of [120, 88, 60]) {
      for (let height = 14; height <= 40 && !partial; height++) {
        const d = renderBoard(partView, { width, height, interactive: true, now: new Date(NOW), scroll: { selected: "waiting", anchors: {} } })
        const seen = new Set(d.buttons.filter((b) => b.key === "#1").map((b) => b.index))
        if (seen.size > 0 && seen.size < 4) partial = { width, height, seen }
      }
    }
    assert.ok(partial, "a size with some of the buttons on screen")
    {
      const draw = (scroll) => renderBoard(partView, { width: partial.width, height: partial.height, interactive: true, now: new Date(NOW), scroll })
      let drawn = draw({ selected: "waiting", anchors: {}, card: "#1", button: -1 })
      for (let i = 0; i < 6; i++) {
        const r = handleInput(drawn.scroll, { type: "key", name: "right" }, drawn)
        assert.ok(partial.seen.has(r.scroll.button), `${partial.width}x${partial.height}: → chose ${r.scroll.button}, on screen are ${[...partial.seen]}`)
        drawn = draw(r.scroll)
        const enter = handleInput(drawn.scroll, { type: "key", name: "enter" }, drawn).action
        assert.equal(enter?.type, "send")
      }
    }
    // Snapshots: as drawn, and the details after → (scrolled to the chosen button); colour on and off.
    for (const [name, flags] of [["short-plain.txt", []], ["short-color.txt", ["--color"]]]) {
      let all = ""
      for (const { width, height, layout, keys: pre } of SHORT) {
        for (const [label, keys] of [["as drawn", ""], ["details, → chooses and scrolls to it", "\r\x1b[C"]]) {
          const r = t.pane(["--width", String(width), "--height", String(height), ...(layout ? ["--layout", layout] : []), ...flags], pre + keys)
          assert.equal(r.status, 0, r.stderr)
          all += `===== ${label} · ${width}x${height}${layout ? ` ${layout}` : pre ? " (Space)" : ""} =====\n${r.stdout}`
        }
      }
      const snap = join(FIXTURES, name)
      if (process.env.UPDATE_SNAPSHOTS) writeFileSync(snap, all)
      assert.equal(all, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
    }
    // End to end at each size through the pane and the fake Herdr: question click + Enter, → Enter,
    // → → Enter, a double click then Enter: no prompt, no focus.
    for (const { width, height, layout, keys: pre } of SHORT) {
      const size = ["--width", String(width), "--height", String(height), ...(layout ? ["--layout", layout] : [])]
      const screen = t.pane(size, pre).stdout
      assert.match(screen, /↓ card cut off: open it for the rest/)
      const click = clickOn(screen, "Question: Approve")
      for (const keys of [`${click}\r`, "\x1b[C\r", "\x1b[C\x1b[C\r", `${click}${click}\r`]) {
        const r = t.pane(size, pre + keys)
        assert.equal(r.status, 0, r.stderr)
      }
      assert.deepEqual(t.log().filter((a) => a[0] === "agent" && (a[1] === "prompt" || a[1] === "focus")), [], `${width}x${height}: nothing sent`)
      assert.match(t.pane(size, `${pre}${click}\r`).stdout, /── card 1 /, `${width}x${height}: Enter opened the details`)
    }
  } finally {
    t.done()
  }
})

test("the details' key line fits at 80 and 88 columns with a button chosen (short form when the long one doesn't fit)", () => {
  const t = setup({ agents, tabs })
  try {
    seedQuestion(t)
    const view = buildView(JSON.parse(readFileSync(t.file, "utf8")), null, { now: new Date(NOW) })
    for (const width of [80, 88, 100, 120]) {
      for (const button of [0, 3]) {
        const drawn = renderBoard(view, { width, height: 40, interactive: true, now: new Date(NOW), scroll: { selected: "waiting", anchors: {}, card: "#1", button, detail: { key: "#1", offset: 0 } } })
        const keys = drawn.text.split("\n").at(-1)
        assert.match(keys, button ? /^Enter to answer in the chat · / : /^Enter to send · /, `${width}`)
        assert.doesNotMatch(keys, /…/, `${width}: not cut`)
        assert.match(keys, /Esc/)
        assert.ok(keys.length <= width)
      }
    }
  } finally {
    t.done()
  }
})
