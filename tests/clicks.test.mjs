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

// --- a button drawn where it is for less than MOVED_MS is never pressed (0.4.0 re-check) ------------

/** The re-check's boards: `nw` Waiting cards with `opts` buttons and `desc` description lines, then Doing, To do and Done. */
function recheckBoard(nw, desc, nTodo = 0, nDone = 0, nDoing = 0, opts = 2, agents = null) {
  const list = []
  let id = 1
  const at = (h) => new Date(Date.parse(NOW) - h * 3600_000).toISOString()
  for (let i = 0; i < nw; i++) {
    list.push({ id: id++, title: `Waiting card ${i} title`, desc: Array.from({ length: desc + (i % 2) }, (_, k) => `desc line ${k} of card ${i} `.repeat(3)).join("\n"), column: "waiting", ask: `Question ${i}?`, since: at(i * 0.1), options: Array.from({ length: opts }, (_, k) => ({ label: ["Yes", "No", "Later", "Skip"][k], suggested: k === 0 })) })
  }
  for (let i = 0; i < nDoing; i++) list.push({ id: id++, title: `doing ${i}`, column: "doing", job: `job-${i}`, since: at(0.2) })
  for (let i = 0; i < nTodo; i++) list.push({ id: id++, title: `todo ${i}`, desc: "todo desc", column: "todo", since: at(30 + i) })
  for (let i = 0; i < nDone; i++) list.push({ id: id++, title: `done ${i}`, column: "done", since: at(0.5) })
  return buildView({ items: list }, agents, { now: new Date(NOW), workspace: "w9" })
}
const drawer = (v, width, height) => (scroll) => renderBoard(v, { width, height, interactive: true, now: new Date(NOW), scroll: { anchors: {}, ...scroll } })
const settle = (d, s) => {
  let x = d(s)
  for (let i = 0; i < 4; i++) x = d(x.scroll)
  return x
}
const pressed = (a) => a && (a.type === "send" || a.type === "other")
const buttonAt = (d, x, y) => d.buttons.find((b) => b.y === y && x >= b.x0 && x <= b.x1)

test("a slow double click that drifts one cell (+1 column, +450 ms) after a row click presses nothing", () => {
  const first = draw({ selected: "waiting", anchors: {} })
  const y = rowOf(first, "2 ! Deploy build two?")
  const one = click(first.scroll, 10, y, 1000)
  const moved = draw(one.scroll)
  assert.ok(buttonAt(moved, 11, y), "a button of card 2 is one cell right of the first click now")
  for (const t of [1450, 1600, 1999]) assert.equal(handleInput(moved.scroll, { type: "click", x: 11, y, at: t }, moved).action, null, `+${t - 1000} ms: nothing sent`)
  assert.ok(pressed(handleInput(moved.scroll, { type: "click", x: 11, y, at: 2001 }, moved).action), "a second later it is a button like any other")
})

test("wide: a click that closes the details uncovers buttons; a click on them right after presses nothing", () => {
  const d = drawer(recheckBoard(3, 3, 0, 0, 0, 4), 130, 30)
  const open = settle(d, { selected: "waiting", detail: { key: "#1", offset: 0 } })
  const top = open.regions.detail.top
  const closed = handleInput(open.scroll, { type: "click", x: 11, y: top - 1, at: 0 }, open)
  assert.equal(closed.scroll.detail, undefined, "the click above the panel closed it")
  const after = d(closed.scroll)
  const uncovered = buttonAt(after, 11, top) || buttonAt(after, 51, top) || after.buttons.find((b) => b.y >= top)
  assert.ok(uncovered, "buttons the panel covered are on screen")
  for (const t of [80, 450, 999]) assert.equal(handleInput(after.scroll, { type: "click", x: uncovered.x0, y: uncovered.y, at: t }, after).action, null, `+${t} ms`)
  assert.ok(pressed(handleInput(after.scroll, { type: "click", x: uncovered.x0, y: uncovered.y, at: 1000 }, after).action))
})

test("the details: a double click on the question, or a triple click on a lower row, presses no button that moved under it", () => {
  // (a) compact 60x16, card 1's details: the click on the question scrolls the panel, and "< Yes ✓ >" lands under the pointer.
  const a = drawer(recheckBoard(2, 0), 60, 16)
  let d = settle(a, { selected: "waiting", detail: { key: "#1", offset: 0 } })
  const q = d.askHits.find((h) => h.panel)
  let r = handleInput(d.scroll, { type: "click", x: q.x0 + 1, y: q.y, at: 0 }, d)
  assert.equal(r.action, null)
  d = a(r.scroll)
  assert.ok(buttonAt(d, q.x0 + 1, q.y)?.panel, "a panel button is under the pointer now")
  for (const t of [80, 450]) assert.equal(handleInput(d.scroll, { type: "click", x: q.x0 + 1, y: q.y, at: t }, d).action, null, `+${t} ms: nothing sent`)
  // (b) wide 130x44, 12 cards: a double click on card 12's row opens its details, whose buttons land under the pointer.
  const b = drawer(recheckBoard(12, 0), 130, 44)
  d = settle(b, { selected: "waiting", card: "#11" })
  const y = 29
  const x = 10
  r = handleInput(d.scroll, { type: "click", x, y, at: 0 }, d)
  d = b(r.scroll)
  r = handleInput(d.scroll, { type: "click", x, y, at: 250 }, d)
  assert.ok(r.scroll.detail, "the double click opened the details")
  d = b(r.scroll)
  assert.ok(buttonAt(d, x, y), "a button is under the pointer now")
  assert.equal(handleInput(d.scroll, { type: "click", x, y, at: 650 }, d).action, null, "the third click sends nothing")
})

test("a refresh that moves the rows (the pane's paint time): a button drawn there less than MOVED_MS ago isn't pressed", () => {
  const v = recheckBoard(3, 1)
  const at = (t, scroll) => renderBoard(v, { width: 99, height: 30, interactive: true, now: new Date(NOW), at: t, scroll: { anchors: {}, ...scroll } })
  let d = at(0, { selected: "waiting", card: "#1" })
  const yes = d.buttons.find((b) => b.key === "#1" && b.index === 0)
  assert.ok(pressed(handleInput(d.scroll, { type: "click", x: yes.x0, y: yes.y, at: 5000 }, d).action), "on screen 5 s: pressed")
  // A job blocks: its agent shows first under Waiting, and the paint at 10 s moves card 1's buttons a row down.
  const v2 = recheckBoard(3, 1, 0, 0, 0, 2, [{ name: "stuck", agent_status: "blocked", workspace_id: "w9" }])
  d = renderBoard(v2, { width: 99, height: 30, interactive: true, now: new Date(NOW), at: 10_000, scroll: d.scroll })
  const still = d.buttons.find((b) => b.key === "#1" && b.index === 0)
  assert.ok(still.y > yes.y, "card 1's buttons moved down")
  assert.equal(handleInput(d.scroll, { type: "click", x: still.x0, y: still.y, at: 10_300 }, d).action, null, "card 1's Yes moved: not yet")
  assert.ok(pressed(handleInput(d.scroll, { type: "click", x: still.x0, y: still.y, at: 11_100 }, d).action), "and pressed once it stood still")
})

test("sweep: after any first click, a second click on the same cell or one cell away (80-999 ms) never presses a button that wasn't there", () => {
  let checks = 0
  let violations = []
  let legit = 0
  for (const spec of [[1, 1, 0, 0, 0, 2], [2, 0, 0, 0, 0, 2], [3, 3, 0, 0, 0, 4], [5, 1, 9, 2, 2, 1], [12, 0, 0, 0, 0, 2]]) {
    const v = recheckBoard(...spec)
    for (const [w, h] of [[60, 16], [99, 30], [130, 30], [130, 44]]) {
      const d = drawer(v, w, h)
      for (const st of [{ selected: "waiting", card: `#${Math.max(1, spec[0] - 1)}` }, {}, { selected: "waiting", card: "#2" }, { selected: "waiting", detail: { key: "#1", offset: 0 } }, { selected: "waiting", open: false }]) {
        const d0 = settle(d, { selected: "waiting", ...st })
        // Every button on a stable screen still presses with a single click.
        for (const b of d0.buttons) {
          legit++
          assert.equal(handleInput(d0.scroll, { type: "click", x: b.x0, y: b.y, at: 100_000 }, d0).action?.key, b.key, "a single click on a visible button presses it")
        }
        for (let y = 1; y <= h; y++) {
          for (let x = 1; x <= w; x += Math.max(1, Math.floor(w / 10))) {
            const c1 = handleInput(d0.scroll, { type: "click", x, y, at: 0 }, d0)
            const d1 = d(c1.scroll)
            for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const x2 = x + dx
              const y2 = y + dy
              const before = buttonAt(d0, x2, y2)
              const now = buttonAt(d1, x2, y2)
              const same = before && now && before.key === now.key && before.index === now.index && before.y === now.y && before.x0 === now.x0 && Boolean(before.panel) === Boolean(now.panel)
              if (!now || same) continue
              for (const t of [80, 250, 450, 700, 999]) {
                checks++
                const a = handleInput(d1.scroll, { type: "click", x: x2, y: y2, at: t }, d1).action
                if (pressed(a)) violations.push({ spec, w, h, st, x, y, x2, y2, t, a })
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checks > 1000, `enough moved-button cases (${checks})`)
  assert.ok(legit > 50)
  assert.deepEqual(violations.slice(0, 3), [], `${violations.length} presses of a just-moved button`)
})
