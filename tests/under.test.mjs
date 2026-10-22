// Run: node --test (from the repo root)
// A sub-task under its parent only in its parent's section (0.7.5): the section a card shows in
// says what it needs from the user. One in another section keeps its own row (or card) there,
// with its state, buttons, order and count, and a "for #231 …" line; its parent's "Waiting on:"
// names it with its state as a coloured tag. Header counts are the cards drawn in each section;
// "N need you", the sidebar and the coordinator's reminder count every Waiting card.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, detailLines, handleInput, renderBoard, tokenText } from "../board.mjs"
import { reminder } from "../hooks/board-hook.mjs"

const NOW = new Date("2026-10-22T18:30:00Z")
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text) => text.replace(ANSI, "")
const key = (name) => ({ type: "key", name })
const at = (min) => new Date(NOW - min * 60_000).toISOString()
const card = (id, column, title, order, extra = {}) => ({ id, title, desc: `Card ${id}.`, column, order, since: at(id - 200), created: at(id - 200), ...extra })
const opts = (...labels) => labels.map((label, i) => ({ label, ...(i ? {} : { suggested: true }) }))

/**
 * The case from the board: 231 (Doing) waits on 279 (Doing) and 274 (To do); 261 (Waiting) on
 * 286 (Waiting). 290, a question for the user under 231, is in Waiting.
 */
function board({ question = true } = {}) {
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

/** A parent in To do with one sub-task in each open section: Waiting, Doing (a working job), To do. */
function todoParent() {
  return {
    version: 2,
    next_id: 304,
    panes: {},
    items: [
      card(300, "todo", "Release checklist: ship it", 1),
      card(301, "waiting", "Phone alerts move: approve the cut-over", 1, { parent: 300, ask: "Go?", options: opts("Go", "Later") }),
      card(302, "doing", "Badge and chart fixes", 1, { parent: 300, job: "badges" }),
      card(303, "todo", "Changelog wording", 2, { parent: 300 }),
    ],
  }
}
const agents = [
  { name: "pr-review3", agent_status: "working", workspace_id: "w9" },
  { name: "badges", agent_status: "working", workspace_id: "w9" },
]
const view = (state) => buildView(state, agents, { now: NOW, workspace: "w9" })
const draw = (state, opts = {}) =>
  renderBoard(view(state), { width: 60, height: 60, interactive: true, now: NOW, layout: "compact", ...opts, scroll: { selected: "doing", doneOpen: true, ...opts.scroll } })
const HEADS = { waiting: "WAITING ON YOU", doing: "DOING", todo: "TO DO", done: "DONE" }
// A section's lines in a one-column layout, from its header to the next one.
const section = (text, head, next) => {
  const lines = plain(text).split("\n")
  const from = lines.findIndex((l) => l.includes(head))
  const to = next ? lines.findIndex((l, i) => i > from && l.includes(next)) : lines.length
  return lines.slice(from, to)
}
// The ids a section's rows start with (a top card's id, or a sub-task's after its ↳).
const rowIds = (lines) => lines.slice(1).map((l) => l.match(/^[ ▸]\s*(\d+) |^[ ▸]\s+[!✓]?\s+↳ (\d+)  /)).filter(Boolean).map((m) => Number(m[1] || m[2]))

test("a sub-task in another section keeps its own row there, 'for #231 …' under it, counted there; one in its parent's section is drawn under it", () => {
  for (const layout of ["compact", "inbox", "wide"]) {
    for (const width of [60, 120]) {
      const text = plain(draw(board({ question: false }), { layout, width, interactive: false }).text)
      assert.equal(text.match(/↳ 274|(^|\s)274 /gm).length, 1, `274 once (${layout} ${width})`)
      assert.match(text, /for #231 Node/, `"for #231 …" (${layout} ${width})`)
      assert.doesNotMatch(text, /↳ for|for Node health:/, `no "↳ for …:" in a title (${layout} ${width})`)
      assert.match(text, /TO DO \(1\)/, `To do draws and counts it (${layout} ${width})`)
      assert.match(text, /DOING \(2\)/, `Doing counts its own (${layout} ${width})`)
      for (const line of text.split("\n")) assert.ok([...line].length <= width, `fits ${width}: ${line}`)
    }
  }
  const text = draw(board({ question: false })).text
  const doing = section(text, "DOING", "TO DO")
  assert.match(doing[1], /^.231   Node health/)
  assert.match(doing[2], /^ {9}↳ 279  Node health fixes[^\n]* working +\d/)
  assert.equal(doing.length, 3)
  const todo = section(text, "TO DO", "DONE")
  assert.match(todo[1], /^ 274   Phone alerts move: merged, not live yet +\d/)
  assert.match(todo[2], /^ {7}for #231 Node health$/)
  assert.equal(todo.length, 3)
})

test("each section's header counts exactly the cards drawn in it; 'need you' and the sidebar count every Waiting card", () => {
  for (const state of [board(), todoParent()]) {
    for (const layout of ["compact", "inbox"]) {
      const d = draw(state, { layout, width: 90, interactive: false })
      const text = plain(d.text)
      for (const [s, next] of [["waiting", "DOING"], ["doing", "TO DO"], ["todo", "DONE"]]) {
        const lines = section(text, HEADS[s], next)
        const count = Number(lines[0].match(/\((\d+)\)/)[1])
        assert.equal(rowIds(lines).length, count, `${HEADS[s]} (${count}) draws ${count} (${layout})`)
        // …and they are the cards whose state is that section's.
        assert.deepEqual([...rowIds(lines)].sort(), view(state)[s].map((e) => e.id).sort(), `${HEADS[s]}: its own cards (${layout})`)
      }
      const need = view(state).waiting.length
      assert.match(text, new RegExp(`^Job board · ${need} needs? you`))
    }
  }
  // The board's case: Waiting has 261, 286 under it and 290 (231's, in Doing).
  const text = plain(draw(board(), { interactive: false }).text)
  assert.deepEqual(rowIds(section(text, "WAITING ON YOU", "DOING")), [261, 286, 290])
  assert.deepEqual(rowIds(section(text, "DOING", "TO DO")), [231, 279])
  assert.deepEqual(rowIds(section(text, "TO DO", "DONE")), [274])
  assert.match(text, /^Job board · 3 need you/)
  assert.equal(tokenText(view(board())), "2 doing · 3 need you · 1 to do")
})

test("the parent's 'Waiting on:' tags each open sub-task with its state in its section's colour; plain text without colour", () => {
  const state = todoParent()
  // Open (the inbox's selected card), as on a card in the wide layout and in the details.
  const open = { layout: "inbox", scroll: { selected: "todo", card: "#300" } }
  const coloured = draw(state, { ...open, width: 120, color: true }).text
  const tags = { waiting: "\x1b[33m[waiting on you]\x1b[0m", doing: "\x1b[34m[working]\x1b[0m", todo: "\x1b[90m[to do]\x1b[0m" }
  // Each open one named with its tag; 303 (To do, with it) is drawn under it with the same tag.
  assert.ok(coloured.includes(`\x1b[1mWaiting on: \x1b[0mPhone alerts move ${tags.waiting}\x1b[2m · \x1b[0mBadge and chart fixes ${tags.doing}\x1b[2m · \x1b[0mChangelog wording ${tags.todo}`), coloured)
  assert.match(coloured, new RegExp(`↳ [^\\n]*303[^\\n]*Changelog wording[^\\n]*${tags.todo.replace(/[[\]]/g, "\\$&")}`))
  // The colours are four different ones: To do's is not Doing's.
  assert.equal(new Set(Object.values(tags).map((t) => t.match(/\[(\d+)m/)[1])).size, 3)
  const text = draw(state, { ...open, width: 120, color: false }).text
  assert.doesNotMatch(text, /\x1b/)
  assert.match(text, /\n {7}Waiting on: Phone alerts move \[waiting on you\] · Badge and chart fixes \[working\] · Changelog wording \[to do\]\n {7}Card 300\.\n {9}↳ 303  Changelog wording +\[to do\] /)
  // Closed, a row says how many where its state goes; its sub-tasks show in their own sections.
  assert.match(plain(draw(state, { width: 120 }).text), /\n 300   Release checklist: ship it +waiting on 3 +\d[^\n]*\n {9}↳ 303/)
  // A narrow pane: the label on its own line, one card a line; names cut, tags never.
  const narrow = section(draw(state, { ...open, width: 40 }).text, "TO DO", "DONE")
  assert.deepEqual(narrow.slice(2, 6), ["       Waiting on:", "         Phone alerts … [waiting on you]", "         Badge and chart fixes [working]", "         Changelog wording [to do]"])
  // The details name every open one, with its state.
  const parent = view(state).todo.find((e) => e.id === 300)
  const details = detailLines(parent, 100, { now: NOW }).lines.map((l) => l.map((s) => s.t).join("")).join("\n")
  assert.match(details, /\n  Waiting on:\n    Phone alerts move \[waiting on you\]\n    Badge and chart fixes \[working\]\n    Changelog wording \[to do\]\n/)
})

test("a Waiting sub-task under a To do parent is in Waiting, 'for #300 …', counted there and in 'need you'; the reminder lists it with its link", () => {
  const state = todoParent()
  const text = plain(draw(state, { interactive: false }).text)
  const waiting = section(text, "WAITING ON YOU", "DOING")
  assert.match(waiting[0], /^WAITING ON YOU \(1\) ─/)
  assert.match(waiting[1], /^ 301 ! Phone alerts move: approve the cut-over +\d/)
  assert.match(waiting[2], /^ {7}for #300 Release checklist$/)
  assert.match(waiting.join("\n"), /\[ Go ✓ \] +\[ Later \]/)
  const doing = section(text, "DOING", "TO DO")
  assert.match(doing[1], /^ 302   Badge and chart fixes +working +\d/)
  assert.match(doing[2], /^ {7}for #300 Release checklist$/)
  assert.deepEqual(rowIds(section(text, "TO DO", "DONE")), [300, 303])
  assert.match(text, /^Job board · 1 needs you/)
  assert.equal(tokenText(view(state)), "1 doing · 1 needs you · 2 to do")
  assert.match(reminder(state), /: #301 "Phone alerts move: approve the cut-over" \(for #300 "Release checklist: ship it"\)\. Close/)
})

test("a Waiting sub-task of a Doing parent is selectable in Waiting: ↓ reaches it, → chooses its buttons, Enter sends, a click presses", () => {
  const state = board()
  let d = draw(state, { scroll: { selected: "waiting", card: "#261" } })
  const seen = [d.scroll.card]
  for (let i = 0; i < 2; i++) {
    d = draw(state, { scroll: handleInput(d.scroll, key("down"), d).scroll })
    seen.push(d.scroll.card)
  }
  assert.deepEqual(seen, ["#261", "#286", "#290"])
  d = draw(state, { scroll: handleInput(d.scroll, key("peek"), d).scroll })
  assert.match(plain(d.text), /\[ Tonight ✓ \]/)
  d = draw(state, { scroll: handleInput(d.scroll, key("right"), d).scroll })
  assert.equal(d.scroll.button, 0)
  assert.deepEqual(handleInput(d.scroll, key("enter"), d).action, { type: "send", id: 290, key: "#290", label: "Tonight" })
  const button = d.buttons.find((b) => b.key === "#290" && b.index === 1)
  const click = handleInput(d.scroll, { type: "click", x: button.x0, y: button.y, at: 10_000 }, d)
  assert.deepEqual(click.action, { type: "send", id: 290, key: "#290", label: "Tomorrow" })
  assert.equal(click.scroll.selected, "waiting")
})

test("Shift+↑ ↓: a sub-task in another section than its parent's moves among that section's top cards; one under its parent among its siblings", () => {
  const state = board()
  state.items.push(card(275, "todo", "Second alert", 2, { parent: 231 }), card(276, "todo", "Plain to do", 3))
  let d = draw(state, { scroll: { selected: "todo", card: "#275" } })
  assert.deepEqual(handleInput(d.scroll, key("moveUp"), d).action.among.sort(), [274, 275, 276])
  d = draw(state, { scroll: { selected: "waiting", card: "#290" } })
  assert.deepEqual(handleInput(d.scroll, key("moveUp"), d).action.among.sort(), [261, 290])
  d = draw(state, { scroll: { selected: "waiting", card: "#286" } })
  assert.deepEqual(handleInput(d.scroll, key("moveUp"), d).action.among, [286])
})

test("its parent done, or another project's in a view of one project: its own row in its section, 'for #231 … (done)' or with the parent's project", () => {
  const state = board({ question: false })
  state.items.find((i) => i.id === 231).column = "done"
  const text = plain(draw(state).text)
  assert.match(section(text, "DOING", "TO DO").join("\n"), /^.279   Node health fixes: in independen… working[^\n]*\n {7}for #231 Node health \(done\)$/m)
  assert.match(section(text, "TO DO", "DONE").join("\n"), /^ 274   Phone alerts move: merged, not live yet[^\n]*\n {7}for #231 Node health \(done\)$/m)
  assert.match(text, /TO DO \(1\)/)

  const other = board({ question: false })
  for (const i of other.items) i.project = i.id === 231 ? "other" : "mine"
  const mine = plain(draw(other, { scroll: { project: "mine" } }).text)
  assert.match(section(mine, "TO DO", "DONE").join("\n"), /^ 274 +mine Phone alerts[^\n]*\n {12}for other #231 Node health$/m)
})

test("ready to resume is as before: its last open sub-task done, the parent says so on top of its section and names what is done", () => {
  const state = board()
  for (const i of state.items) if ([279, 274, 290].includes(i.id)) i.column = "done"
  Object.assign(state.items.find((i) => i.id === 231), { ready: at(1), ready_after: [274, 279, 290], order: -1 })
  state.items.push(card(232, "doing", "Another Doing card", 0))
  const text = plain(draw(state, { width: 90, scroll: { card: "#231", open: true } }).text)
  const doing = section(text, "DOING", "TO DO")
  assert.match(doing[1], /^▸231   Node health: goes live[^\n]* ready to resume +1 min$/)
  assert.match(doing[2], /^ {7}Phone alerts move, Node health fixes and Phone alerts are done$/)
  assert.doesNotMatch(doing.join("\n"), /Waiting on:|↳/)
})

test("the coordinator's reminder lists a Waiting sub-task after its parent when that waits too, else with 'for #231 …'", () => {
  const state = board()
  const text = reminder(state)
  // 286 straight after its parent 261; 290's parent (Doing) named with it; each once.
  assert.match(text, /: #261 "One 'Edit targets' dialog: continent groups and node tags"; ↳ #286 "Edit targets dialog: one Apply click, or an extra confirm\?"; #290 "Phone alerts: go live tonight\?" \(for #231 "Node health: goes live after its two fixes and with the phone alerts"\)\. /)
  // Its parent done: listed as before.
  state.items.find((i) => i.id === 231).column = "done"
  assert.match(reminder(state), /; #290 "Phone alerts: go live tonight\?"\. Close/)
})

test("a selected sub-task row highlights only its id after the ↳; the empty id column and the ▸ stay plain (inbox and compact)", () => {
  for (const layout of ["inbox", "compact"]) {
    for (const card of ["#279", "#286"]) {
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
