// Run: node --test (from the repo root)
// Nested cards in the pane: a parent, its sub-card, that one's check and the next sibling (540 ›
// 557 › 589, and 562), the open sub-card selected. Every number in the id column, each level's
// title two cells further in after the ↳, no line on the open card that only names the rows
// under it, and no project name before a description the row's tag already names.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, renderBoard, textWidth } from "../board.mjs"

const NOW = new Date("2026-11-05T10:30:00Z")
const at = (m) => new Date(NOW - m * 60_000).toISOString()
const P = "sfc-integration"
const DESC =
  "All four GCP fixes are built: (1) two creates of the same node at once no longer delete each other's static IP; (2) a leftover static IP after a Google error is named in the error; (3) Activate stays available while the node is starting; (4) the firewall rule set is stored."
function state() {
  const items = [
    { id: 499, title: "SFC Proxmox hosts: keep them updated", column: "doing", project: P, since: at(156) },
    { id: 540, title: "SFC Manager: create nodes on GCP: build", column: "doing", project: P, since: at(720) },
    // A status line on a card with no job of its own: built from the cards under it ("#589 working").
    { id: 557, title: "GCP: last follow-up fixes before the GUI release", column: "doing", project: P, parent: 540, since: at(0), now: { text: "a line", at: at(0) }, desc: DESC },
    { id: 589, title: "GCP follow-up fixes: check before the GUI release", column: "doing", project: P, parent: 557, job: "gcp-fixes-check", since: at(0) },
    { id: 562, title: "GCP: store its firewall rule set: fix", column: "doing", project: P, parent: 540, job: "gcp-firewall", since: at(157) },
    { id: 251, title: "OneProvider: Oslo OSL-008/009 slowed by monthly traffic cap", column: "doing", project: P, since: at(4320) },
    { id: 600, title: "Another project's card", column: "todo", project: "ai-config", since: at(30) },
  ]
  return { version: 2, next_id: 601, front: "", panes: {}, coordinators: {}, reports: {}, imports: [], projects: { [P]: { tag: "sfc" }, "ai-config": { tag: "ai" } }, items }
}
const agents = [
  { name: "gcp-fixes-check", agent_status: "working", workspace_id: "w9" },
  { name: "gcp-firewall", agent_status: "idle", workspace_id: "w9" },
]
const draw = (width) =>
  renderBoard(buildView(state(), agents, { now: NOW, workspace: "w9" }), { width, height: 40, interactive: true, now: NOW, frame: 0, scroll: { selected: "doing", card: "#557", anchors: {} } })

for (const width of [100, 160]) {
  test(`${width} columns: numbers in one column, one step a level, nothing named twice on the open card`, () => {
    const d = draw(width)
    assert.equal(d.layout, width < 120 ? "inbox" : "wide")
    const lines = d.text.split("\n")
    for (const l of lines) assert.ok(textWidth(l) <= width, `fits ${width}: ${l}`)
    const row = (id) => lines.find((l) => new RegExp(`^.?${id}[ ▸]`).test(l))
    const family = [540, 557, 589, 562, 251].map(row)
    for (const [i, l] of family.entries()) assert.ok(l, `${[540, 557, 589, 562, 251][i]} drawn`)
    // The numbers end in one column.
    const ends = family.map((l) => l.search(/\d(?!\d)/))
    assert.equal(new Set(ends).size, 1, `ids line up: ${family.join("\n")}`)
    // Each level's ↳ two cells right of its parent's title (540's) or ↳ (557's); siblings alike.
    const title = family[0].indexOf("SFC Manager")
    assert.equal(family[1].indexOf("↳"), title + 2)
    assert.equal(family[3].indexOf("↳"), title + 2, "562, a sibling of 557, on 557's step")
    assert.equal(family[2].indexOf("↳"), title + 4, "589, under 557, one step further")
    assert.equal(family[2].indexOf("GCP follow-up"), family[1].indexOf("GCP: last") + 2)
    assert.doesNotMatch(d.text, /· check \(589\)/, "under its own parent: its number")
    // The open card: no "Now: #589 working", no "Waiting on: GCP follow-up fixes [working]".
    const open = lines.slice(lines.indexOf(family[1]) + 1, lines.indexOf(family[2])).join("\n")
    assert.doesNotMatch(open, /Now:|Waiting on:/)
    assert.match(open, /All four GCP fixes are built/)
    // 540 names nothing either: both cards under it are drawn under it.
    assert.doesNotMatch(d.text, /Waiting on:/)
    // The row's tag names the project: no full name before the description.
    assert.doesNotMatch(d.text, /sfc-integration ·/)
    // The description wraps at the title's column, whole words, within the pane.
    const body = open.split("\n").filter((l) => l.trim() && !/^\s*\[doing\]$/.test(l))
    for (const l of body) assert.equal(l.search(/\S/), family[1].indexOf("GCP: last"), `under its title: ${l}`)
  })
}

test("a parent's built status line stays when it names a card not drawn under it", () => {
  const s = state()
  s.items.find((i) => i.id === 589).column = "todo"
  const text = renderBoard(buildView(s, agents, { now: NOW, workspace: "w9" }), { width: 100, height: 40, interactive: true, now: NOW, scroll: { selected: "doing", card: "#557", anchors: {} } }).text
  assert.match(text, /Now: #589 to do/)
  assert.match(text, /Waiting on: GCP follow-up fixes \[to do\]/)
})
