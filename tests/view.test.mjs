// Run: node --test (from the repo root)
// Colours, the card details panel, links (OSC 8), copying (OSC 52) and the mouse toggle.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, handleInput, renderBoard } from "../board.mjs"
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

test("details: Enter opens a card's full text, its job and report, cleaned; Esc closes; it scrolls", () => {
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
    assert.match(panel, /#3 Search filters: build/)
    assert.match(panel, /Doing · 25 min/)
    assert.match(panel, /job search-ui · working · tab "search-ui"/)
    assert.match(panel, /Sentence 1 of a long description/)
    assert.match(r.stdout, /── card 3 · ↓ \d+ more/, "longer than the panel: it says how much more")
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /^Esc close · ↑↓ scroll · c copy · t go to tab · q quit$/)
    // Scroll to the end: the report and the times.
    r = t.pane([], "\t\rG")
    assert.match(flat(r), /report .*report\.json/)
    assert.match(r.stdout, /status done/)
    assert.match(flat(r), /Filter panel built\. Diff: https:\/\/github\.com\/example\/app\/pull\/21 \[2J/)
    assert.doesNotMatch(r.stdout, /\x1b|‮/, "report text cleaned")
    assert.match(r.stdout, /• Review and merge https:\/\/github\.com\/example\/app\/pull\/21/)
    assert.match(r.stdout, /PR https:\/\/github\.com\/example\/app\/pull\/21/)
    assert.match(r.stdout, /branch feat\/filters/)
    assert.match(r.stdout, /commit abc1234/)
    assert.match(flat(r), /created 2026-10-13 10:05 · in this column since 2026-10-13 10:05 · updated 2026-10-13 10:08/)
    assert.match(r.stdout, /── card 3 · ↑ \d+ lines above/)
    // Esc closes it.
    r = t.pane([], "\t\r\x1b")
    assert.doesNotMatch(r.stdout, /── card/)
    assert.match(r.stdout.trimEnd().split("\n").at(-1), /^Tab section/)
    // Missing and garbled reports.
    rmSync(report)
    assert.match(t.pane([], "\t\rG").stdout, /report unavailable/)
    writeFileSync(report, "{ not json")
    assert.match(t.pane([], "\t\rG").stdout, /report unavailable/)
    writeFileSync(report, "[1, 2]")
    assert.match(t.pane([], "\t\rG").stdout, /report unavailable/)
    // A huge summary is cut.
    writeFileSync(report, JSON.stringify({ status: "done", summary: "x".repeat(5000) }))
    const big = t.pane(["--height", "200"], "\t\r").stdout
    assert.ok((big.match(/x/g) || []).length < 2100, "summary cut to 2000 characters")
    // A Waiting card with buttons: Enter opens details too (until ← → chooses a button).
    r = t.pane([], "\x1b[B\r")
    assert.match(r.stdout, /── card 2/)
    assert.match(r.stdout, /buttons: Merge ✓ · Not yet/)
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
