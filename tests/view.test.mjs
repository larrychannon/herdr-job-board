// Run: node --test (from the repo root)
// Colours, the card details panel, links (OSC 8), copying (OSC 52) and the mouse toggle.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { asText, buildView, handleInput, parseInput, renderBoard, reportCacheStats, reportFacts } from "../board.mjs"
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
  const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", JOB_BOARD_FILE: "", JOB_BOARD_NOW: NOW, TZ: "UTC" }
  delete env.NO_COLOR
  const board = (now, ...args) => {
    const r = spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, HERDR_ENV: "0", JOB_BOARD_NOW: now }, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    return r
  }
  const pane = (args = [], keys = "") =>
    spawnSync(process.execPath, [PANE, "--once", "--width", "88", "--height", "40", "--origin", "w9:p1", ...args, "--keys", keys], { cwd: base, env, encoding: "utf8" })
  const log = () => JSON.parse(readFileSync(herdr, "utf8")).log ?? []
  return { base, env, board, pane, log, file: join(base, ".git", "job-board.json"), done: () => rmSync(root, { recursive: true, force: true }) }
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
    const on = t.pane(["--color"]).stdout
    const off = t.pane().stdout
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
    has("2;32", "DONE (1)")
    has("32", "working")
    has("90", "no agent")
    has("33", "→ ")
    has("1;33", "[ Merge ✓ ]") // the suggested button
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
    const text = t.pane(["--links", "--color"]).stdout
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
      assert.match(t.pane([], "\t\rG").stdout, /The report can't be read: it isn't a JSON object\./)
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
    assert.match(r.stdout, /What you need to do\n {2}→ Try http:\/\/localhost:3000\/invoices, then say merge\n {2}\[ Merge ✓ \] {2}\[ Not yet \] {2}\[ Other… \]/)
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
// Keys that open each card's details: Waiting 1 and 2, Doing (orders-ui), Done (CSV export).
const OPEN = { 1: "\r", 2: "\x1b[B\r", 3: "\t\r", 4: "\t\t\t\r" }
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

test("details panel: opaque from its top rule to the key line, closed by a rule; nothing of the columns inside it", () => {
  const t = setup({ agents: detailAgents, tabs: detailTabs })
  try {
    seedDetails(t)
    const board = t.pane(["--width", "120", "--height", "40"]).stdout
    assert.match(board, /DONE-MARK shipped thing 6/, "without the panel, Done shows in the lower half")
    for (const width of [120, 88]) {
      for (const [card, keys] of Object.entries(OPEN)) {
        for (const flags of [[], ["--color", "--links"]]) {
          const screen = plainOf(t.pane(["--width", String(width), "--height", "40", ...flags], keys).stdout).split("\n")
          assert.equal(screen.at(-1), "", "ends in a newline")
          screen.pop()
          assert.equal(screen.length, 40)
          const top = screen.findIndex((l) => /^── card \d/.test(l))
          assert.equal(top, 20, `${card} at ${width}: the panel starts half way down`)
          const bottom = screen.length - 2
          assert.match(screen[bottom], /^── (end of card \d+|↓ \d+ more lines?) ─+$/, `${card} at ${width}: the closing rule, just above the key line`)
          assert.equal([...screen[bottom]].length, width, "the closing rule spans the pane")
          assert.equal([...screen[top]].length, width, "and so does the top one")
          assert.match(screen.at(-1), /^Esc /)
          for (const line of screen.slice(top, bottom + 1)) {
            assert.doesNotMatch(line, /TODO-MARK|DONE-MARK|DOING \(|TO DO \(|DONE \(|WAITING ON YOU|↓ \d+ more$/, `${card} at ${width}: column text in the panel: ${line}`)
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
    assert.match(r.stdout, /\d+▸Export to CSV/, "and the card")
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
  assert.deepEqual(parseInput("\x1bé c").map((e) => e.name), ["copy"], "a multi-byte Alt chord is skipped whole")
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
