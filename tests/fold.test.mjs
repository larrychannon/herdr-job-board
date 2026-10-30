// Run: node --test (from the repo root)
// To do folds like Done: one line by default ("TO DO · 12 ▸"); t or a click on the line opens
// it, t or a click on its header folds it; folded, Tab skips it; the choice holds across redraws
// and a card moving into To do; ls shows it whole. t in a card's details still goes to its tab.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, handleInput, parseInput, render, renderBoard, textWidth } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PANE = join(ROOT, "board-pane.mjs")
const NOW = new Date("2026-10-30T10:30:00Z")
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text) => text.replace(ANSI, "")
const key = (name) => ({ type: "key", name })
const at = (min) => new Date(NOW - min * 60_000).toISOString()

function board({ waiting = 1, doing = 1, todo = 3, done = 1 } = {}) {
  const items = []
  let id = 1
  const card = (column, title, extra = {}) => items.push({ id: id, title, desc: `Card ${id++}.`, column, since: at(id), ...extra })
  for (let i = 0; i < waiting; i++) card("waiting", `Review the deploy ${i}: staging`, { ask: "Ship it?", options: [{ label: "Ship it", suggested: true }, { label: "Wait" }] })
  for (let i = 0; i < doing; i++) card("doing", `Build the fold ${i}: like Done`)
  for (let i = 0; i < todo; i++) card("todo", `Later task ${i}: someday`)
  for (let i = 0; i < done; i++) card("done", `Finished task ${i}: shipped`, { since: at(5) })
  return { version: 2, next_id: id, items, panes: {} }
}
const draw = (state, opts = {}) => renderBoard(buildView(state, [], { now: NOW, workspace: "w9" }), { width: 120, height: 30, interactive: true, now: NOW, ...opts })
/** Feed events one by one, redrawing after each, as the pane does. */
function feed(state, events, opts = {}) {
  let drawn = draw(state, opts)
  const actions = []
  for (const event of events) {
    const r = handleInput(drawn.scroll, event, drawn)
    if (r.action) actions.push(r.action)
    drawn = draw(state, { ...opts, scroll: r.scroll })
  }
  return { drawn, actions }
}
const linesOf = (drawn) => plain(drawn.text).split("\n")

for (const layout of ["wide", "inbox", "compact"]) {
  test(`${layout}: To do starts folded to one line, "TO DO · 3 ▸", above Done's; t opens it (▾), t folds it again`, () => {
    const s = board()
    const folded = draw(s, { layout })
    const lines = linesOf(folded)
    const todoAt = lines.findIndex((l) => l.trim() === "TO DO · 3 ▸")
    assert.ok(todoAt > 0, folded.text)
    assert.equal(lines[todoAt + 1].trim(), "DONE · 1 today ▸")
    assert.ok(!plain(folded.text).includes("Later task"), "no To do card while folded")
    assert.ok(folded.todoToggle && folded.todoToggle.y === todoAt + 1)

    const { drawn: opened } = feed(s, [key("tab")], { layout })
    assert.equal(opened.scroll.todoOpen, true)
    assert.match(plain(opened.text), /TO DO \(3\) ▾/)
    for (let i = 0; i < 3; i++) assert.ok(plain(opened.text).includes(`Later task ${i}`), opened.text)
    assert.ok(!plain(opened.text).includes("TO DO · 3 ▸"))
    assert.equal(linesOf(opened).filter((l) => l.trim() === "DONE · 1 today ▸").length, 1)

    const { drawn: again } = feed(s, [key("tab"), key("tab")], { layout })
    assert.equal(again.scroll.todoOpen, false)
    assert.equal(linesOf(again).filter((l) => l.trim() === "TO DO · 3 ▸").length, 1)
    // Every frame is exactly the pane's lines, none wider.
    for (const d of [folded, opened, again]) {
      assert.equal(d.text.split("\n").length, 30)
      for (const l of d.text.split("\n")) assert.ok(textWidth(plain(l)) <= 120, l)
    }
  })
}

test("t is parsed as the To do key (named tab), d as Done's", () => {
  assert.deepEqual(parseInput("td"), [key("tab"), key("done")])
})

test("a click on To do's folded line opens it; a click on its open header folds it; nothing else moves", () => {
  const s = board()
  for (const layout of ["wide", "inbox"]) {
    const folded = draw(s, { layout })
    const t = folded.todoToggle
    const r1 = handleInput(folded.scroll, { type: "click", x: t.x0 + 2, y: t.y }, folded)
    assert.equal(r1.scroll.todoOpen, true)
    assert.equal(r1.scroll.selected, folded.scroll.selected)
    assert.equal(r1.action, null)
    const opened = draw(s, { layout, scroll: r1.scroll })
    const head = opened.todoToggle
    assert.ok(linesOf(opened)[head.y - 1].includes("TO DO (3) ▾"), opened.text)
    const r2 = handleInput(opened.scroll, { type: "click", x: head.x0, y: head.y }, opened)
    assert.equal(r2.scroll.todoOpen, false)
    // Done's line next to it is its own target.
    const d = folded.doneToggle
    assert.notEqual(d.y, t.y)
    const r3 = handleInput(folded.scroll, { type: "click", x: d.x0, y: d.y }, folded)
    assert.equal(r3.scroll.doneOpen, true)
    assert.notEqual(r3.scroll.todoOpen, true)
  }
})

test("folded, Tab and ← → skip To do; opened, they stop on it; folding it while selected selects Doing", () => {
  const s = board()
  const tabs = (scroll, n) => {
    let drawn = draw(s, { scroll })
    const seen = []
    for (let i = 0; i < n; i++) {
      drawn = draw(s, { scroll: handleInput(drawn.scroll, key("next"), drawn).scroll })
      seen.push(drawn.scroll.selected)
    }
    return seen
  }
  assert.deepEqual(tabs({}, 3), ["doing", "waiting", "doing"])
  assert.deepEqual(tabs({ todoOpen: true }, 3), ["doing", "todo", "waiting"])
  assert.deepEqual(tabs({ todoOpen: true, doneOpen: true }, 4), ["doing", "todo", "done", "waiting"])
  assert.deepEqual(tabs({ doneOpen: true }, 3), ["doing", "done", "waiting"])
  // To do selected, then t: Doing is selected.
  const { drawn } = feed(s, [key("tab"), key("next"), key("next"), key("tab")])
  assert.equal(drawn.scroll.selected, "doing")
  // Done folds while selected and To do is folded: Doing, not the folded To do.
  const { drawn: done } = feed(s, [key("done"), key("next"), key("next"), key("done")])
  assert.equal(done.scroll.selected, "doing")
  // A scroll that names a folded section draws the nearest open one above it selected.
  assert.equal(draw(s, { scroll: { selected: "todo" } }).scroll.selected, "doing")
  assert.equal(draw(s, { scroll: { selected: "done", todoOpen: true } }).scroll.selected, "todo")
})

test("the choice holds across redraws and new cards; a card moved into To do while folded doesn't open it", () => {
  const s = board()
  const folded = draw(s)
  const moved = structuredClone(s)
  moved.items.find((i) => i.column === "doing").column = "todo"
  moved.items.push({ id: 99, title: "Brand new: later", desc: "New.", column: "todo", since: at(0) })
  const after = draw(moved, { scroll: folded.scroll })
  assert.notEqual(after.scroll.todoOpen, true)
  assert.ok(linesOf(after).some((l) => l.trim() === "TO DO · 5 ▸"), after.text)
  assert.ok(!plain(after.text).includes("Brand new"))
  // Opened, it stays open as cards come and go.
  const { drawn: opened } = feed(s, [key("tab")])
  const later = draw(moved, { scroll: opened.scroll })
  assert.equal(later.scroll.todoOpen, true)
  assert.ok(plain(later.text).includes("Brand new"))
})

test("wide: To do and Done folded with Doing empty: no columns, both lines, Waiting gets the room", () => {
  const s = board({ waiting: 3, doing: 0 })
  const drawn = draw(s, { layout: "wide" })
  const lines = linesOf(drawn)
  assert.equal(drawn.text.split("\n").length, 30)
  assert.match(plain(drawn.text), /DOING \(0\) · nothing running/)
  assert.equal(lines.filter((l) => l.trim() === "TO DO · 3 ▸").length, 1)
  assert.equal(lines.filter((l) => l.trim() === "DONE · 1 today ▸").length, 1)
  for (let i = 0; i < 3; i++) assert.ok(plain(drawn.text).includes(`Review the deploy ${i}`))
  // Without a height limit too.
  const tall = renderBoard(buildView(s, [], { now: NOW, workspace: "w9" }), { width: 120, now: NOW, layout: "wide" })
  assert.ok(plain(tall.text).includes("TO DO · 3 ▸"))
})

test("a view of one project counts To do's hidden cards on its folded line", () => {
  const s = board({ todo: 2 })
  s.projects = { app: { tag: "app", color: "cyan" }, web: { tag: "web", color: "green" } }
  for (const i of s.items) i.project = "app"
  s.items.push({ id: 50, title: "Other project: later", desc: "x", column: "todo", project: "web", since: at(1) })
  const drawn = draw(s, { scroll: { project: "app" } })
  assert.ok(linesOf(drawn).some((l) => l.trim() === "TO DO · 2 · +1 other ▸"), drawn.text)
})

test("t in a card's details goes to the job's tab; t on the board folds To do and goes nowhere", () => {
  const s = board()
  s.items.find((i) => i.column === "doing").job = "fold-job"
  const { drawn, actions } = feed(s, [key("next"), key("enter"), key("tab")])
  assert.ok(drawn.scroll.detail, "the details are open")
  assert.equal(actions.length, 1)
  assert.equal(actions[0].type, "tab")
  assert.notEqual(drawn.scroll.todoOpen, true)
  const board2 = feed(s, [key("next"), key("tab")])
  assert.equal(board2.actions.length, 0)
  assert.equal(board2.drawn.scroll.todoOpen, true)
})

test("ls shows To do whole, with no fold line", () => {
  const view = buildView(board(), [], { now: NOW, workspace: "w9" })
  const text = plain(render(view, { width: 120, now: NOW, scroll: { queueOpen: true, todoOpen: true, doneOpen: true } }))
  for (let i = 0; i < 3; i++) assert.ok(text.includes(`Later task ${i}`))
  assert.ok(!text.includes("▸"))
})

test("the key line and ? name t for To do; a phone's line stays '? keys · q quit'", () => {
  const s = board()
  assert.match(linesOf(draw(s, { layout: "wide" }))[1], /t to do · d done/)
  assert.match(linesOf(draw(s, { width: 90, height: 30 }))[1], /t to do · d done/)
  const help = feed(s, [key("help")], { width: 44, height: 40 }).drawn
  assert.match(plain(help.text).replace(/\n/g, " "), /t to do · d done/)
  assert.match(plain(help.text).replace(/\n/g, " "), /t in a card's details: go to the job's tab/)
  assert.equal(linesOf(draw(s, { width: 24, height: 20 }))[1].trim(), "? keys · q quit")
})

test("the pane (--once): To do folded by default; --keys t opens it", () => {
  const base = mkdtempSync(join(tmpdir(), "fold-"))
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "board.json")
  writeFileSync(file, JSON.stringify(board()))
  const env = { ...process.env, HOME: home, JOB_BOARD_HOME: join(base, "state"), JOB_BOARD_NOW: NOW.toISOString(), NO_COLOR: "1" }
  const once = (...extra) => spawnSync(process.execPath, [PANE, "--once", "--board", file, "--width", "120", "--height", "30", ...extra], { cwd: base, env, encoding: "utf8" })
  const folded = once()
  assert.equal(folded.status, 0, folded.stderr)
  assert.match(folded.stdout, /^TO DO · 3 ▸$/m)
  assert.doesNotMatch(folded.stdout, /Later task/)
  const opened = once("--keys", "t")
  assert.equal(opened.status, 0, opened.stderr)
  assert.match(opened.stdout, /TO DO \(3\) ▾/)
  assert.match(opened.stdout, /Later task 0/)
})
