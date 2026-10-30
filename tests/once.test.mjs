// Run: node --test (from the repo root)
// Each sub-task drawn once (0.7.3), under its parent only in its parent's section (0.7.5): its
// own row (or card) straight under the parent's, further in than the parent's title, its id after
// the ↳; one in another section keeps its own row there, with "for #231 …", and the parent's
// "Waiting on:" names it with its state. Wide, inbox and compact; ↑ ↓ through them, Shift+↑ ↓
// among a parent's sub-tasks.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, handleInput, placeItem, renderBoard } from "../board.mjs"

const NOW = new Date("2026-10-22T18:30:00Z")
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text) => text.replace(ANSI, "")
const key = (name) => ({ type: "key", name })
const at = (min) => new Date(NOW - min * 60_000).toISOString()

/**
 * The case from the board: 231 waits on 279 (Doing, ordered above it) and 274 (To do); 280 is
 * another Doing card; 282, a second sub-task of 231 in Doing, comes after 280 in Doing's order.
 */
function board() {
  const card = (id, column, title, order, extra = {}) => ({ id, title, desc: `Card ${id}.`, column, order, since: at(id - 200), created: at(id - 200), ...extra })
  return {
    version: 2,
    next_id: 283,
    panes: {},
    items: [
      card(279, "doing", "Node health fixes: built — in independent review", 1, { parent: 231, job: "pr-review3" }),
      card(231, "doing", "Node health: goes live after its two fixes and with the phone alerts", 2),
      card(280, "doing", "Blank error page after a timeout: fix reviewed — being updated", 3),
      card(282, "doing", "Badge tweaks", 4, { parent: 231 }),
      card(274, "todo", "Phone alerts move: merged — goes live with Node health", 1, { parent: 231 }),
    ],
  }
}
const agents = [{ name: "pr-review3", agent_status: "working", workspace_id: "w9" }]
const draw = (state, opts = {}) =>
  renderBoard(buildView(state, agents, { now: NOW, workspace: "w9" }), { width: 60, height: 40, interactive: true, now: NOW, ...opts, scroll: { selected: "doing", todoOpen: true, doneOpen: true, ...opts.scroll } })
const section = (text, head, next) => {
  const lines = plain(text).split("\n")
  const from = lines.findIndex((l) => l.includes(head))
  const to = next ? lines.findIndex((l, i) => i > from && l.includes(next)) : lines.length
  return lines.slice(from + 1, to)
}

test("compact: a sub-task in its parent's section is one row, straight under the parent and further in; the other section's one keeps its row there, 'for #231 …'", () => {
  const d = draw(board(), { layout: "compact" })
  const doing = section(d.text, "DOING", "QUEUE")
  const rows = doing.map((l) => l.replace(/\s+$/, ""))
  // Parent first, then its sub-tasks in Doing's order (279 before 282), each with its state, then
  // the next top card (280).
  assert.match(rows[0], /^.231   Node health: goes live[^\n]* waiting on 3 +\d/)
  assert.match(rows[1], /^ {9}↳ 279  Node health fixes[^\n]* working +\d/)
  assert.match(rows[2], /^ {9}↳ 282  Badge tweaks +\[doing\] +\d/)
  assert.match(rows[3], /^ 280   Blank error page/)
  assert.equal(rows.length, 4)
  // Each drawn once; the ↳ sits two cells right of where the parent's title starts.
  const text = plain(d.text)
  assert.equal(text.match(/↳ 279|279 /g).length, 1)
  assert.equal(text.match(/↳ 282|282 /g).length, 1)
  assert.equal(text.match(/↳ 274|274 /g).length, 1)
  assert.equal(rows[1].indexOf("↳"), rows[0].indexOf("Node") + 2)
  // 274 keeps its own row in To do, counted there, with whose it is on a line of its own.
  assert.deepEqual(section(d.text, "TO DO", "DONE").map((l) => l.replace(/\s+$/, "")), [" 274   Phone alerts move: merged — goes live wit… 1 h 14 min", "       for #231 Node health"])
  assert.match(text, /\nTO DO \(1\) ▾ ─/)
  assert.match(text, /\n▸ DOING \(4\) ─/)
  for (const line of text.split("\n")) assert.ok([...line].length <= 60, `fits 60: ${line}`)
})

test("wide: a sub-task's card follows its parent's, indented with its id after the ↳; the other section's one is its own card there", () => {
  const d = renderBoard(buildView(board(), agents, { now: NOW, workspace: "w9" }), { width: 120, now: NOW, layout: "wide", scroll: { todoOpen: true, doneOpen: true } })
  const text = plain(d.text)
  assert.match(text, /\n231 Node health: goes live after its {5}/)
  assert.match(text, /\n {6}↳ 279  Node health fixes: built\n {13}— in independent review\n {13}working\n/)
  assert.match(text, /\n {6}↳ 282  Badge tweaks/)
  // Its "Waiting on:" names all three with their states, one a line in a column this narrow.
  assert.match(text, /\n {4}Waiting on: {29}[^\n]*\n {6}Node health fixes \[working\] [^\n]*\n {6}Badge tweaks \[doing\]\n {6}Phone alerts move \[to do\]\n/)
  assert.match(text, /\n {13}\[doing\]\n/)
  // 274's card in To do: its title, then "for #231 …" under it, at its title's column.
  const lines = text.split("\n")
  const row = lines.findIndex((l) => l.includes("274 Phone alerts move: merged — goes"))
  const col = lines[row].indexOf("274 ") + 4
  assert.equal(lines[row + 1].indexOf("live with Node health   1 h 14 min"), col)
  assert.equal(lines[row + 2].indexOf("for #231 Node health"), col)
  assert.match(text, /TO DO \(1\)/)
  assert.equal(text.match(/↳ 274| 274 /gm).length, 1, "274 drawn once")
  assert.ok(text.indexOf("↳ 279") < text.indexOf("↳ 282") && text.indexOf("↳ 282") < text.indexOf("280 Blank"))
  assert.equal(text.match(/↳ 279|^279 /gm).length, 1, "279 drawn once")
  assert.doesNotMatch(text.slice(0, text.indexOf("280 Blank")), /\n\s+for /, "no 'for …' inside its parent's family")
})

test("inbox: the same order; the selected sub-task opens under its own row, indented with it", () => {
  const d = draw(board(), { width: 90, layout: "inbox", scroll: { card: "#279" } })
  const doing = section(d.text, "DOING", "TO DO").filter((l) => l.trim())
  assert.match(doing[0], /^ 231   Node health/)
  assert.match(doing[1], /^▸ {8}↳ 279  Node health fixes/)
  assert.match(doing[2], /^ {16}Card 279\./, "its body starts under its title")
  assert.match(doing.find((l) => /↳ 282/.test(l)), /^ {9}↳ 282  Badge tweaks/)
})

test("keys: ↓ goes parent, its sub-tasks, the next card; Shift+↑ ↓ on a sub-task moves it among its parent's sub-tasks only", () => {
  const state = board()
  let d = draw(state, { layout: "compact", scroll: { card: "#231" } })
  const order = [d.scroll.card]
  for (let i = 0; i < 3; i++) {
    d = draw(state, { layout: "compact", scroll: handleInput(d.scroll, key("down"), d).scroll })
    order.push(d.scroll.card)
  }
  assert.deepEqual(order, ["#231", "#279", "#282", "#280"])
  // 282 up: among 279 and 282 only, so it goes above 279 (not above 280 or 231).
  d = draw(state, { layout: "compact", scroll: { card: "#282" } })
  const up = handleInput(d.scroll, key("moveUp"), d).action
  assert.deepEqual(up.among.sort(), [279, 282])
  placeItem(state, state.items.find((i) => i.id === 282), "up", (i) => up.among.includes(i.id))
  d = draw(state, { layout: "compact", scroll: { card: "#282" } })
  const rows = section(d.text, "DOING", "TO DO")
  assert.match(rows[1], /↳ 282  Badge tweaks/)
  assert.match(rows[2], /↳ 279  Node health fixes/)
  assert.match(rows[3], /^ 280 /)
  // Down again at the bottom of the sub-tasks: nowhere to go among them.
  d = draw(state, { layout: "compact", scroll: { card: "#279" } })
  const down = handleInput(d.scroll, key("moveDown"), d).action
  assert.equal(placeItem(state, state.items.find((i) => i.id === 279), "down", (i) => down.among.includes(i.id)), false)
  // A top card moves among the top cards: 280 up goes above 231, its sub-tasks follow 231.
  d = draw(state, { layout: "compact", scroll: { card: "#280" } })
  const top = handleInput(d.scroll, key("moveUp"), d).action
  assert.deepEqual(top.among.sort(), [231, 280])
  placeItem(state, state.items.find((i) => i.id === 280), "up", (i) => top.among.includes(i.id))
  const after = section(draw(state, { layout: "compact" }).text, "DOING", "TO DO")
  assert.match(after[0], /^.280 /)
  assert.match(after[1], /^ 231 /)
  assert.match(after[2], /↳ 282/)
})

test("a sub-task whose parent the project filter hides is a top card again; one in another section never moves", () => {
  const state = board()
  state.items.find((i) => i.id === 231).project = "other"
  for (const i of state.items) if (i.id !== 231) i.project = "mine"
  const d = draw(state, { layout: "compact", scroll: { project: "mine" } })
  const doing = section(d.text, "DOING", "TO DO")
  assert.match(doing.join("\n"), /^.279 +mine Node health fixes[^\n]*\n {12}for other #231 Node health\n/m)
  assert.doesNotMatch(plain(d.text), /\n {9}↳ \d/)
})
