// Run: node --test (from the repo root)
// A sub-task only under its parent (0.7.4): one in another section than its parent's is drawn as
// its own row (or card) under the parent, with that section where its state goes, and is neither
// drawn nor counted in that section; selectable there, with its buttons; a Waiting one still
// needs the user. Its parent done (or another project's): its own row in its section again. The
// coordinator's reminder lists it under its parent too.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, handleInput, renderBoard, tokenText } from "../board.mjs"
import { reminder } from "../hooks/board-hook.mjs"

const NOW = new Date("2026-10-22T18:30:00Z")
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text) => text.replace(ANSI, "")
const key = (name) => ({ type: "key", name })
const at = (min) => new Date(NOW - min * 60_000).toISOString()

/**
 * The case from the board: 231 (Doing) waits on 279 (Doing) and 274 (To do); 261 (Waiting) on
 * 286 (Waiting). 290, a question for the user under 231, is in Waiting.
 */
function board({ question = true } = {}) {
  const card = (id, column, title, order, extra = {}) => ({ id, title, desc: `Card ${id}.`, column, order, since: at(id - 200), created: at(id - 200), ...extra })
  const opts = (...labels) => labels.map((label, i) => ({ label, ...(i ? {} : { suggested: true }) }))
  return {
    version: 2,
    next_id: 291,
    panes: {},
    items: [
      card(231, "doing", "Node health: goes live after its two fixes and with the phone alerts", 1),
      card(279, "doing", "Node health fixes: in independent review", 2, { parent: 231, job: "pr-review3" }),
      card(274, "todo", "Phone alerts move: merged, not live yet", 1, { parent: 231 }),
      card(261, "waiting", "One 'Edit targets' dialog: continent groups and node tags", 1, { ask: "Merge it?", options: opts("One click, merge", "Later") }),
      card(286, "waiting", "Edit targets dialog: one Apply click, or an extra confirm?", 2, { parent: 261, ask: "Which?", options: opts("One click", "Extra confirm") }),
      ...(question ? [card(290, "waiting", "Phone alerts: go live tonight?", 3, { parent: 231, ask: "Tonight or tomorrow?", options: opts("Tonight", "Tomorrow") })] : []),
    ],
  }
}
const agents = [{ name: "pr-review3", agent_status: "working", workspace_id: "w9" }]
const view = (state) => buildView(state, agents, { now: NOW, workspace: "w9" })
const draw = (state, opts = {}) =>
  renderBoard(view(state), { width: 60, height: 60, interactive: true, now: NOW, layout: "compact", ...opts, scroll: { selected: "doing", doneOpen: true, ...opts.scroll } })
const section = (text, head, next) => {
  const lines = plain(text).split("\n")
  const from = lines.findIndex((l) => l.includes(head))
  const to = next ? lines.findIndex((l, i) => i > from && l.includes(next)) : lines.length
  return lines.slice(from, to)
}

test("a sub-task in another section is drawn once, under its parent, with its section as its state; not drawn or counted there", () => {
  for (const layout of ["compact", "inbox", "wide"]) {
    for (const width of [60, 120]) {
      const text = plain(draw(board({ question: false }), { layout, width, interactive: false }).text)
      assert.equal(text.match(/↳ 274|(^|\s)274 /gm).length, 1, `274 once (${layout} ${width})`)
      assert.doesNotMatch(text, /for Node health|for One 'Edit/, `no "for …" (${layout} ${width})`)
      assert.match(text, layout === "wide" && width < 100 ? /TO DO \(0\) · 1 und…/ : /TO DO \(0\) · 1 under its parent/, `To do neither draws nor counts it (${layout} ${width})`)
      assert.match(text, /DOING \(2\)/, `Doing counts its own (${layout} ${width})`)
      for (const line of text.split("\n")) assert.ok([...line].length <= width, `fits ${width}: ${line}`)
    }
  }
  const rows = section(draw(board({ question: false })).text, "DOING", "TO DO")
  assert.match(rows[1], /^.231   Node health/)
  assert.match(rows[2], /^ {9}↳ 279  Node health fixes[^\n]* working +\d/)
  assert.match(rows[3], /^ {9}↳ 274  Phone alerts move: merged… to do +\d/)
  assert.equal(rows.length, 4)
})

test("a Waiting sub-task under a Doing parent: '!', 'waiting on you' in amber, and the user's count still has it", () => {
  const state = board()
  const d = renderBoard(view(state), { width: 60, height: 60, interactive: false, now: NOW, color: true, layout: "compact", scroll: { doneOpen: true } })
  const text = plain(d.text)
  assert.match(text, /^Job board · 3 need you/)
  assert.match(text, /\nWAITING ON YOU \(2\) ─/, "Waiting counts its own two")
  assert.equal(text.match(/↳ 290|(^|\s)290 /gm).length, 1, "290 once")
  const doing = section(d.text, "DOING", "TO DO")
  // After its Doing sibling, then the To do one: the order of the sections.
  assert.match(doing[2], /^ {9}↳ 279/)
  assert.match(doing[3], /^ {5}! {3}↳ 290  Phone alerts: go… waiting on you  1 h 30 min$/)
  assert.ok(doing.findIndex((l) => /↳ 274/.test(l)) > 3)
  assert.match(d.text, /\x1b\[1;33mwaiting on you\x1b\[0m/)
  // ls opens a Waiting row: its question and buttons show under its parent.
  assert.match(doing.join("\n"), /\n {16}Question: Tonight or tomorrow\?\n {16}\[ Tonight ✓ \] +\[ Tomorrow \]/)
  // The sidebar counts as before.
  assert.equal(tokenText(view(state)), "2 doing · 3 need you · 1 to do")
})

test("selectable under its parent: ↓ reaches it, ← → choose its buttons, Enter sends; Enter opens its details, whose buttons work", () => {
  const state = board()
  let d = draw(state, { scroll: { card: "#231" } })
  const seen = [d.scroll.card]
  for (let i = 0; i < 3; i++) {
    d = draw(state, { scroll: handleInput(d.scroll, key("down"), d).scroll })
    seen.push(d.scroll.card)
  }
  assert.deepEqual(seen, ["#231", "#279", "#290", "#274"])
  // Back on 290, opened (Space), its buttons chosen with → and sent with Enter.
  d = draw(state, { scroll: handleInput(d.scroll, key("up"), d).scroll })
  assert.equal(d.scroll.card, "#290")
  d = draw(state, { scroll: handleInput(d.scroll, key("peek"), d).scroll })
  assert.match(plain(d.text), /\[ Tonight ✓ \]/)
  d = draw(state, { scroll: handleInput(d.scroll, key("right"), d).scroll })
  assert.equal(d.scroll.button, 0)
  assert.match(plain(d.text), /^Enter: send/m)
  const sent = handleInput(d.scroll, key("enter"), d).action
  assert.deepEqual(sent, { type: "send", id: 290, key: "#290", label: "Tonight" })
  // A click on a button presses it, and keeps the selection in Doing.
  const button = d.buttons.find((b) => b.key === "#290" && b.index === 1)
  const click = handleInput(d.scroll, { type: "click", x: button.x0, y: button.y, at: 10_000 }, d)
  assert.deepEqual(click.action, { type: "send", id: 290, key: "#290", label: "Tomorrow" })
  assert.equal(click.scroll.selected, "doing")
  // Enter with no button chosen: its details, where → chooses and Enter sends.
  d = draw(state, { scroll: { card: "#290", open: false } })
  d = draw(state, { scroll: handleInput(d.scroll, key("enter"), d).scroll })
  assert.equal(d.scroll.detail?.key, "#290")
  d = draw(state, { scroll: handleInput(d.scroll, key("right"), d).scroll })
  assert.equal(d.scroll.selected, "doing")
  assert.equal(d.scroll.button, 0)
  assert.deepEqual(handleInput(d.scroll, key("enter"), d).action, { type: "send", id: 290, key: "#290", label: "Tonight" })
})

test("Shift+↑ ↓ on a sub-task from another section orders it among its siblings of that section only", () => {
  const state = board()
  state.items.push({ ...state.items.find((i) => i.id === 274), id: 275, title: "Second alert", order: 2 })
  const d = draw(state, { scroll: { card: "#275" } })
  const up = handleInput(d.scroll, key("moveUp"), d).action
  assert.deepEqual(up.among.sort(), [274, 275])
  const d2 = draw(state, { scroll: { card: "#290" } })
  assert.deepEqual(handleInput(d2.scroll, key("moveUp"), d2).action.among, [290])
})

test("its parent done, or another project's in a view of one project: its own row in its section again, marked whose it is", () => {
  const state = board({ question: false })
  const parent = state.items.find((i) => i.id === 231)
  parent.column = "done"
  const text = plain(draw(state).text)
  assert.match(section(text, "DOING", "TO DO").join("\n"), /^.279   ↳ for Node health \(done\): Node h… working/m)
  assert.match(section(text, "TO DO", "DONE").join("\n"), /^ 274   ↳ for Node health \(done\): Phone alerts mo…/m)
  assert.match(text, /TO DO \(1\)/)

  const other = board({ question: false })
  for (const i of other.items) i.project = i.id === 231 ? "other" : "mine"
  const mine = plain(draw(other, { scroll: { project: "mine" } }).text)
  assert.match(section(mine, "TO DO", "DONE").join("\n"), /^ 274 +mine ↳ for Node health: Phone alerts/m)
})

test("the coordinator's reminder lists a Waiting sub-task under its parent", () => {
  const state = board()
  const text = reminder(state)
  // 286 straight after its parent 261; 290's parent (Doing) named with it; each once.
  assert.match(text, /: #261 "One 'Edit targets' dialog: continent groups and node tags"; ↳ #286 "Edit targets dialog: one Apply click, or an extra confirm\?"; #290 "Phone alerts: go live tonight\?" \(under #231 "Node health: goes live after its two fixes and with the phone alerts"\)\. /)
  // Its parent done: listed as before.
  state.items.find((i) => i.id === 231).column = "done"
  assert.match(reminder(state), /; #290 "Phone alerts: go live tonight\?"\. Close/)
})

test("a selected sub-task row highlights only its id after the ↳; the empty id column and the ▸ stay plain (inbox and compact)", () => {
  for (const layout of ["inbox", "compact"]) {
    for (const card of ["#274", "#286"]) {
      const d = draw(board(), { layout, color: true, scroll: { selected: card === "#286" ? "waiting" : "doing", card, open: false } })
      const row = d.text.split("\n").find((l) => l.includes(`\x1b[1;7m${card.slice(1)}\x1b[0m`))
      assert.ok(row, `${card} highlighted (${layout})`)
      assert.equal(row.match(/\x1b\[1;7m/g).length, 1, `one highlight only (${layout} ${card})`)
      assert.match(row, /^\x1b\[1m▸\x1b\[0m {4}[ !\x1b[0-9;m]*↳ \x1b\[0m\x1b\[1;7m\d+\x1b\[0m/, `▸ then a plain blank id column (${layout} ${card})`)
    }
  }
  // A top card still highlights its id in the id column.
  const top = draw(board(), { color: true, scroll: { card: "#231" } }).text.split("\n").find((l) => l.includes("Node health: goes"))
  assert.match(top, /^\x1b\[1m▸\x1b\[0m\x1b\[1;7m231\x1b\[0m/)
})

test("wide, two cards a row: a sub-task's card stays under its parent's, never beside it", () => {
  const text = plain(renderBoard(view(board()), { width: 120, now: NOW, layout: "wide", scroll: { doneOpen: true } }).text)
  const lines = text.split("\n")
  const parent = lines.findIndex((l) => /^261 One 'Edit/.test(l))
  const child = lines.findIndex((l) => /↳ 286/.test(l))
  assert.ok(child > parent)
  assert.match(lines[child], /^ {6}↳ 286  Edit targets dialog/)
  assert.equal(text.match(/↳ 286|^286 /gm).length, 1)
})
