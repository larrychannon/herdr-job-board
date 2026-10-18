// Run: node --test (from the repo root)
// A click is never a button press when the button wasn't under the pointer for the click before
// it: in the inbox, the first click of a double click opens a card and moves the rows, so the
// second can land on a button that wasn't there (0.4.0 review). Both mouse modes.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, handleInput, renderBoard } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const NOW = "2026-10-13T10:30:00Z"

/** Two Waiting cards with buttons (the first open in the inbox) and a To do card, as in the review. */
const items = [
  { id: 1, title: "Merge PR one?", desc: "First card description line", column: "waiting", ask: "Merge it now?", since: "2026-10-13T10:27:00Z", options: [{ label: "Yes" }, { label: "No" }] },
  { id: 2, title: "Deploy build two?", desc: "Second card description line", column: "waiting", ask: "Deploy it now?", since: "2026-10-13T10:27:00Z", options: [{ label: "Yes" }, { label: "No" }] },
  { id: 3, title: "Some todo", column: "todo", since: "2026-10-13T10:27:00Z" },
]
const view = buildView({ items }, null, { now: new Date(NOW) })
const draw = (scroll) => renderBoard(view, { width: 99, height: 30, interactive: true, now: new Date(NOW), scroll })
const rowOf = (drawn, text) => drawn.text.split("\n").findIndex((l) => l.includes(text)) + 1
const click = (scroll, x, y, at) => {
  const drawn = draw(scroll)
  return handleInput(drawn.scroll, { type: "click", x, y, at }, drawn)
}

test("a double click on a closed row opens its details; the button its first click moved under the pointer is never pressed", () => {
  const first = draw({ selected: "waiting", anchors: {} })
  assert.equal(first.layout, "inbox")
  const y = rowOf(first, "2 ! Deploy build two?")
  const x = 10
  const one = click(first.scroll, x, y, 1000)
  assert.equal(one.action, null)
  assert.equal(one.scroll.card, "#2", "the first click selects card 2 (and opens it)")
  // The precondition the review found: card 2's buttons are now where its row was.
  const moved = draw(one.scroll)
  assert.ok(moved.buttons.some((b) => b.key === "#2" && b.y === y && x >= b.x0 && x <= b.x1), "a button of card 2 is under the pointer now")
  // The second click of the double click: the details, not a press.
  const two = handleInput(moved.scroll, { type: "click", x, y, at: 1150 }, moved)
  assert.equal(two.action, null, "nothing sent")
  assert.equal(two.scroll.detail?.key, "#2", "the double click opens card 2's details")
  assert.equal(two.scroll.button, -1, "with no button chosen")
  // Slower than a double click but soon after, on the same cell: it only selects.
  const late = handleInput(moved.scroll, { type: "click", x, y, at: 1700 }, moved)
  assert.equal(late.action, null, "the target moved since the last click: no press")
  assert.equal(late.scroll.detail, undefined)
  // Once the user has had time to see the new screen, the button works as any button does.
  const later = handleInput(moved.scroll, { type: "click", x, y, at: 3000 }, moved)
  assert.deepEqual(later.action, { type: "send", id: 2, key: "#2", label: moved.buttons.find((b) => b.key === "#2" && b.y === y && x >= b.x0 && x <= b.x1).label })
})

test("a button pressed and clicked again at once (a double click on it) presses once and opens the details", () => {
  const start = draw({ selected: "waiting", anchors: {} })
  const yes = start.buttons.find((b) => b.key === "#1" && b.index === 0)
  const one = handleInput(start.scroll, { type: "click", x: yes.x0 + 1, y: yes.y, at: 5000 }, start)
  assert.deepEqual(one.action, { type: "send", id: 1, key: "#1", label: "Yes" })
  const again = draw(one.scroll)
  const two = handleInput(again.scroll, { type: "click", x: yes.x0 + 1, y: yes.y, at: 5200 }, again)
  assert.equal(two.action, null, "the second half of the double click sends nothing")
  assert.equal(two.scroll.detail?.key, "#1")
  // A button clicked a while after the last click on another card is pressed.
  const other = draw({ selected: "waiting", anchors: {}, lastClick: { key: "#3", at: 0, x: 1, y: 1, target: "card #3" } })
  const no = other.buttons.find((b) => b.key === "#1" && b.index === 1)
  assert.deepEqual(handleInput(other.scroll, { type: "click", x: no.x0, y: no.y, at: 100 }, other).action, { type: "send", id: 1, key: "#1", label: "No" })
})

/** A repo with this board, a fake Herdr with a coordinator, and the pane in --once mode. */
function pane() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-clicks-")))
  const repo = join(root, "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  spawnSync("git", ["-C", repo, "init", "-q"])
  writeFileSync(join(repo, ".git", "job-board.json"), JSON.stringify({ version: 1, next_id: 4, items, panes: {} }))
  const herdr = join(root, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ agents: [{ name: "coord", agent_status: "idle", workspace_id: "w9", pane_id: "w9:p1", interactive_ready: true }], panes: [] }))
  const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", JOB_BOARD_NOW: NOW, TZ: "UTC", NO_COLOR: "1" }
  delete env.JOB_BOARD_FILE
  const run = (keys) => spawnSync(process.execPath, [join(ROOT, "board-pane.mjs"), "--once", "--width", "99", "--height", "30", "--origin", "w9:p1", "--keys", keys], { cwd: repo, env, encoding: "utf8" })
  const sent = () => (JSON.parse(readFileSync(herdr, "utf8")).log ?? []).filter((a) => a[0] === "agent" && (a[1] === "prompt" || a[1] === "focus"))
  return { run, sent, done: () => rmSync(root, { recursive: true, force: true }) }
}

test("end to end, both mouse modes: a double click on card 2's row sends nothing; with mouse capture off clicks do nothing at all", () => {
  const t = pane()
  try {
    const screen = t.run("").stdout.split("\n")
    const y = screen.findIndex((l) => l.includes("2 ! Deploy build two?")) + 1
    const at = `\x1b[<0;10;${y}M`
    // mouse: board. The double click opens the details; no prompt reaches the coordinator.
    const r = t.run(at + at)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /── card 2 /, "card 2's details")
    assert.deepEqual(t.sent(), [], "no button was pressed")
    // mouse: select (m). The terminal shouldn't report clicks; any that come select nothing and press nothing.
    const off = t.run(`m${at}${at}${at}`)
    assert.equal(off.status, 0, off.stderr)
    assert.doesNotMatch(off.stdout, /── card 2 /)
    assert.match(off.stdout, /^(?:\x1b\[\?1000l\x1b\[\?1006l)?▸ ?1 ! Merge PR one\?/m, "the selection didn't move")
    assert.deepEqual(t.sent(), [])
    // m twice: the board has the mouse again, and a single click on a button on screen presses it.
    const yes = screen.findIndex((l) => l.includes("[ Yes ]")) + 1
    const x = [...screen[yes - 1].slice(0, screen[yes - 1].indexOf("[ Yes ]"))].length + 2
    t.run(`mm\x1b[<0;${x};${yes}M`)
    assert.deepEqual(t.sent(), [["agent", "prompt", "w9:p1", "Board card 1 (Merge PR one?): Yes"]])
  } finally {
    t.done()
  }
})
