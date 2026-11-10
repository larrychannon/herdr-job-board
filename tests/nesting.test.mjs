// Run: node --test (from the repo root)
// Nested cards in the pane: a parent, its sub-card, that one's check and the next sibling (10 ›
// 11 › 12, and 13), the open sub-card selected. Every number in the id column, each level's
// title two cells further in after the ↳, no line on the open card that only names the rows
// under it, and no project name before a description the row's tag already names.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, renderBoard, textWidth } from "../board.mjs"

const NOW = new Date("2026-11-05T10:30:00Z")
const at = (m) => new Date(NOW - m * 60_000).toISOString()
const P = "shop-app"
const DESC =
  "All four checkout fixes are built: (1) two orders placed at once no longer overwrite each other's address; (2) a leftover cart after a payment error is named in the error; (3) Pay stays available while the order is saving; (4) the shipping rule set is stored."
function state() {
  const items = [
    { id: 8, title: "Build servers: keep them updated", column: "doing", project: P, since: at(156) },
    { id: 10, title: "Shop: checkout rework: build", column: "doing", project: P, since: at(720) },
    // A status line on a card with no job of its own: its own (0.20.0: no line built from the cards under it).
    { id: 11, title: "Checkout: last follow-up fixes before the release", column: "doing", project: P, parent: 10, since: at(0), now: { text: "a line", at: at(0) }, desc: DESC },
    { id: 12, title: "Checkout follow-up fixes: check before the release", column: "doing", project: P, parent: 11, job: "checkout-fixes-check", since: at(0) },
    { id: 13, title: "Checkout: store its shipping rule set: fix", column: "doing", project: P, parent: 10, job: "checkout-shipping", since: at(157) },
    { id: 9, title: "Search page: slow on long result lists", column: "doing", project: P, since: at(4320) },
    { id: 20, title: "Another project's card", column: "todo", project: "ops", since: at(30) },
  ]
  return { version: 2, next_id: 21, front: "", panes: {}, coordinators: {}, reports: {}, imports: [], projects: { [P]: { tag: "shop" }, ops: { tag: "ops" } }, items }
}
const agents = [
  { name: "checkout-fixes-check", agent_status: "working", workspace_id: "w9" },
  { name: "checkout-shipping", agent_status: "idle", workspace_id: "w9" },
]
const draw = (width) =>
  renderBoard(buildView(state(), agents, { now: NOW, workspace: "w9" }), { width, height: 40, interactive: true, now: NOW, frame: 0, scroll: { selected: "doing", card: "#11", anchors: {} } })

for (const width of [100, 160]) {
  test(`${width} columns: numbers in one column, one step a level, nothing named twice on the open card`, () => {
    const d = draw(width)
    assert.equal(d.layout, width < 120 ? "inbox" : "wide")
    const lines = d.text.split("\n")
    for (const l of lines) assert.ok(textWidth(l) <= width, `fits ${width}: ${l}`)
    const row = (id) => lines.find((l) => new RegExp(`^[▸ ]? *${id}[ ▸]`).test(l))
    const family = [10, 11, 12, 13, 9].map(row)
    for (const [i, l] of family.entries()) assert.ok(l, `${[10, 11, 12, 13, 9][i]} drawn`)
    // The numbers end in one column.
    const ends = family.map((l) => l.search(/\d(?!\d)/))
    assert.equal(new Set(ends).size, 1, `ids line up: ${family.join("\n")}`)
    // Each level's ↳ two cells right of its parent's title (10's) or ↳ (11's); siblings alike.
    const title = family[0].indexOf("Shop: checkout")
    assert.equal(family[1].indexOf("↳"), title + 2)
    assert.equal(family[3].indexOf("↳"), title + 2, "13, a sibling of 11, on 11's step")
    assert.equal(family[2].indexOf("↳"), title + 4, "12, under 11, one step further")
    assert.equal(family[2].indexOf("Checkout follow-up"), family[1].indexOf("Checkout: last") + 2)
    assert.doesNotMatch(d.text, /· check \(12\)/, "under its own parent: its number")
    // The open card: its own line, no "Waiting on: Checkout follow-up fixes [working]".
    const open = lines.slice(lines.indexOf(family[1]) + 1, lines.indexOf(family[2])).join("\n")
    assert.match(open, /Now: a line/)
    assert.doesNotMatch(open, /Waiting on:/)
    assert.match(open, /All four checkout fixes are built/)
    // 10 names nothing either: both cards under it are drawn under it.
    assert.doesNotMatch(d.text, /Waiting on:/)
    // The row's tag names the project: no full name before the description.
    assert.doesNotMatch(d.text, /shop-app ·/)
    // The description wraps at the title's column, whole words, within the pane.
    const body = open.split("\n").filter((l) => l.trim() && !/^\s*\[doing\]$/.test(l) && !/^\s*Now:/.test(l))
    for (const l of body) assert.equal(l.search(/\S/), family[1].indexOf("Checkout: last"), `under its title: ${l}`)
  })
}

test("the details (Enter) give the card's own status line; no 'Waiting on:' list", () => {
  const panel = (key) => {
    const text = renderBoard(buildView(state(), agents, { now: NOW, workspace: "w9" }), { width: 100, height: 40, interactive: true, now: NOW, scroll: { selected: "doing", card: key, anchors: {}, detail: { key } } }).text
    return text.slice(text.indexOf(`── card ${key.slice(1)} `))
  }
  assert.match(panel("#11"), /Now: a line/)
  assert.doesNotMatch(panel("#11"), /Waiting on:/)
  assert.doesNotMatch(panel("#10"), /Waiting on:/)
})

test("a part moved back to To do: its parent, with no job of its own, shows in To do with it", () => {
  const s = state()
  s.items.find((i) => i.id === 12).column = "todo"
  const view = buildView(s, agents, { now: NOW, workspace: "w9" })
  assert.deepEqual(view.todo.map((e) => e.id).filter((id) => id !== 20).sort(), [11, 12])
  assert.equal(view.todo.find((e) => e.id === 11).shown, "todo")
  // 10 still has 13 in Doing.
  assert.ok(view.doing.some((e) => e.id === 10))
})

// 11 done while its check (12) still runs: 11 shows in Doing for it (0.20.0), drawn under 10 as
// before, and 12 under it, every number in line.
for (const width of [100, 160]) {
  test(`${width} columns: a Done card whose check still runs shows in Doing, its check under it, numbers in line`, () => {
    const s = state()
    s.items.find((i) => i.id === 11).column = "done"
    const lines = renderBoard(buildView(s, agents, { now: NOW, workspace: "w9" }), { width, height: 40, interactive: true, now: NOW, frame: 0, scroll: { selected: "doing", card: "#12", anchors: {} } }).text.split("\n")
    for (const l of lines) assert.ok(textWidth(l) <= width, `fits ${width}: ${l}`)
    assert.ok(!lines.some((l) => /· check \(12\)/.test(l)), "its number, not its sub-card name")
    const row = (id) => lines.find((l) => new RegExp(`^[▸ ]? *${id}[ ▸]`).test(l))
    const family = [10, 11, 12, 13, 9].map(row)
    for (const [i, l] of family.entries()) assert.ok(l, `${[10, 11, 12, 13, 9][i]} drawn`)
    const ends = family.map((l) => l.search(/\d(?!\d)/))
    assert.equal(new Set(ends).size, 1, `ids line up: ${family.join("\n")}`)
    assert.equal(family[2].indexOf("↳"), family[1].indexOf("↳") + 2, "12 one step under 11")
  })
}
