// Run: node --test (from the repo root)
// The cards' order in each section: new cards and cards that change section on top, `order`,
// Shift+↑ ↓ in the pane, boards from before 0.6.0, and the blocked job first in Waiting.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, handleInput, parseInput, placeItem, readBoard, renderBoard } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = join(ROOT, "board-pane.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const NOW = "2026-10-13T10:30:00Z"

/** Two repos (app, lib) with one store in a temp dir, a fake Herdr, the CLI and the pane. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-order-")))
  const repo = (name) => {
    const dir = join(root, name)
    mkdirSync(dir)
    spawnSync("git", ["-C", dir, "init", "-q"])
    return dir
  }
  const app = repo("app")
  const lib = repo("lib")
  const herdr = join(root, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ agents: [] }))
  const env = { ...process.env, HERDR_ENV: "0", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, JOB_BOARD_FILE: "", JOB_BOARD_HOME: join(root, "store"), HOME: root, JOB_BOARD_NOW: NOW, TZ: "UTC", NO_COLOR: "1" }
  const run = (args, cwd = app) => spawnSync(process.execPath, [BOARD, ...args], { cwd, env, encoding: "utf8" })
  const ok = (args, cwd) => {
    const r = run(args, cwd)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const file = join(root, "store", "board.json")
  const view = () => buildView(readBoard(file), null, { now: new Date(NOW) })
  const ids = (section) => view()[section].map((e) => e.id)
  const pane = (keys) =>
    spawnSync(process.execPath, [PANE, "--once", "--width", "100", "--height", "30", "--keys", keys], { cwd: app, env: { ...env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w9" }, encoding: "utf8" })
  return { app, lib, run, ok, file, view, ids, pane, done: () => rmSync(root, { recursive: true, force: true }) }
}

test("a new card goes on top of its section, and so does a card that moves into another section", () => {
  const t = setup()
  try {
    for (const title of ["one", "two", "three"]) t.ok(["add", "todo", title])
    assert.deepEqual(t.ids("todo"), [3, 2, 1], "the newest on top")
    t.ok(["add", "doing", "four"])
    t.ok(["move", "1", "doing"])
    assert.deepEqual(t.ids("doing"), [1, 4], "a card moved in goes on top")
    assert.deepEqual(t.ids("todo"), [3, 2])
    t.ok(["edit", "2", "--desc", "changed"])
    assert.deepEqual(t.ids("todo"), [3, 2], "an edit keeps its place")
    t.ok(["move", "1", "todo"])
    assert.deepEqual(t.ids("todo"), [1, 3, 2], "back in To do: on top again")
    // job-start moves its card to Doing: on top too.
    t.ok(["job-start", "build", "--id", "2"])
    assert.deepEqual(t.ids("doing"), [2, 4])
  } finally {
    t.done()
  }
})

test("order <ref> top|up|down|bottom moves a card in its section; at an end it says so; Done keeps its own order", () => {
  const t = setup()
  try {
    for (const title of ["a", "b", "c", "d"]) t.ok(["add", "todo", title])
    assert.deepEqual(t.ids("todo"), [4, 3, 2, 1])
    assert.match(t.ok(["order", "1", "up"]), /^1 → up in to do: a/)
    assert.deepEqual(t.ids("todo"), [4, 3, 1, 2])
    t.ok(["order", "1", "top"])
    assert.deepEqual(t.ids("todo"), [1, 4, 3, 2])
    assert.match(t.ok(["order", "1", "up"]), /^1 is at the top of to do already: a/)
    t.ok(["order", "4", "bottom"])
    assert.deepEqual(t.ids("todo"), [1, 3, 2, 4])
    t.ok(["order", "3", "down"])
    assert.deepEqual(t.ids("todo"), [1, 2, 3, 4])
    assert.match(t.ok(["order", "4", "down"]), /at the bottom of to do already/)
    // Bad input: exit 2, nothing changes.
    const before = readFileSync(t.file, "utf8")
    assert.equal(t.run(["order", "1", "sideways"]).status, 2)
    assert.equal(t.run(["order", "1"]).status, 2)
    t.ok(["done", "2"])
    const r = t.run(["order", "2", "top"])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Done keeps its own order/)
    assert.notEqual(before, readFileSync(t.file, "utf8"), "done 2 wrote")
    assert.deepEqual(t.ids("todo"), [1, 3, 4])
  } finally {
    t.done()
  }
})

test("order with --project: another project's card needs it, and up and down then step over that project's cards only", () => {
  const t = setup()
  try {
    t.ok(["add", "todo", "app 1"], t.app)
    t.ok(["add", "todo", "lib 2"], t.lib)
    t.ok(["add", "todo", "app 3"], t.app)
    assert.deepEqual(t.ids("todo"), [3, 2, 1])
    // A lib card from the app folder: --project lib, as for move or edit.
    assert.equal(t.run(["order", "2", "top"]).status, 2)
    // Without --project, up steps over the card just above, whatever its project.
    t.ok(["order", "1", "up"])
    assert.deepEqual(t.ids("todo"), [3, 1, 2])
    t.ok(["order", "1", "down"])
    // With --project app, up steps over app's cards only: past lib 2 to above app 3.
    t.ok(["order", "1", "up", "--project", "app"])
    assert.deepEqual(t.ids("todo"), [1, 3, 2])
  } finally {
    t.done()
  }
})

test("a board from before 0.6.0 (no order) reads newest first in each section, with nothing lost", () => {
  const t = setup()
  try {
    t.ok(["add", "todo", "first"])
    const card = (id, column, title) => ({ id, project: "app", column, title, desc: `about ${title}`, job: "", ask: "", origin: "", workspace: "", created: NOW, since: NOW, updated: NOW })
    const items = [card(1, "todo", "one"), card(2, "doing", "two"), card(3, "todo", "three"), card(5, "todo", "five"), card(4, "waiting", "four"), card(6, "done", "six")]
    const old = { ...JSON.parse(readFileSync(t.file, "utf8")), next_id: 7, items }
    writeFileSync(t.file, JSON.stringify(old))
    assert.deepEqual(t.ids("todo"), [5, 3, 1])
    const read = readBoard(t.file).items
    assert.deepEqual(read.map(({ order: _o, ...rest }) => rest), items, "every card and field kept")
    assert.ok(read.every((i) => Number.isFinite(i.order)))
    // The first write saves the order; a new card goes on top of it.
    t.ok(["add", "todo", "seven"])
    assert.deepEqual(t.ids("todo"), [7, 5, 3, 1])
    assert.ok(JSON.parse(readFileSync(t.file, "utf8")).items.every((i) => Number.isFinite(i.order)))
    // A card added by hand without an order goes below the others.
    const hand = JSON.parse(readFileSync(t.file, "utf8"))
    hand.items.push({ ...card(8, "todo", "eight") })
    hand.next_id = 9
    writeFileSync(t.file, JSON.stringify(hand))
    assert.deepEqual(t.ids("todo"), [7, 5, 3, 1, 8])
  } finally {
    t.done()
  }
})

test("Waiting: a blocked job still shows first, whatever the order", () => {
  const card = (id, column, order, job = "") => ({ id, project: "app", column, title: `card ${id}`, desc: "", job, ask: "", origin: "", workspace: "w9", created: NOW, since: NOW, updated: NOW, order })
  const state = { items: [card(1, "waiting", 0), card(2, "waiting", 1, "stuck"), card(3, "waiting", 2), card(4, "doing", 0, "busy")], projects: {} }
  const agents = [{ name: "stuck", agent_status: "blocked", workspace_id: "w9" }, { name: "busy", agent_status: "blocked", workspace_id: "w9" }, { name: "loose", agent_status: "blocked", workspace_id: "w9" }]
  const view = buildView(state, agents, { now: new Date(NOW), workspace: "w9" })
  // Blocked first (cards in their order, then a blocked agent with no card), then the others in theirs.
  assert.deepEqual(view.waiting.map((e) => e.id ?? e.job), [4, 2, "loose", 1, 3])
  assert.deepEqual(buildView(state, null, { now: new Date(NOW) }).waiting.map((e) => e.id), [1, 2, 3])
})

test("placeItem: only the card's own order changes, until its neighbours are too close (then the section is numbered again)", () => {
  const card = (id, order) => ({ id, column: "todo", title: `${id}`, order })
  const state = { items: [card(1, 0), card(2, 1), card(3, 2), { ...card(4, 0), column: "doing" }] }
  assert.equal(placeItem(state, state.items[2], "up"), true)
  assert.deepEqual(state.items.map((i) => i.order), [0, 1, 0.5, 0], "halfway between its new neighbours")
  assert.equal(placeItem(state, state.items[1], "top"), true)
  assert.deepEqual(state.items.map((i) => i.order), [0, -1, 0.5, 0])
  const tight = { items: [card(1, 0), card(2, Number.MIN_VALUE), card(3, 1)] }
  placeItem(tight, tight.items[2], "up")
  assert.deepEqual(tight.items.map((i) => i.order), [0, 2, 1], "numbered again, in the new order")
  assert.throws(() => placeItem(state, state.items[0], "left"), /top, up, down, bottom/)
})

test("Shift+↑ ↓: parsed from ESC [1;2A / [1;2B (other modifiers stay ↑ ↓); they move the selected card among those its section shows", () => {
  assert.deepEqual(parseInput("\x1b[1;2A\x1b[1;2B\x1b[1;5A\x1b[A"), [
    { type: "key", name: "moveUp" },
    { type: "key", name: "moveDown" },
    { type: "key", name: "up" },
    { type: "key", name: "up" },
  ])
  const card = (id, order, project = "app") => ({ id, project, column: "todo", title: `card ${id}`, desc: "", job: "", ask: "", origin: "", workspace: "", created: NOW, since: NOW, updated: NOW, order })
  const view = buildView({ items: [card(1, 0), card(2, 1, "lib"), card(3, 2)], projects: {} }, null, { now: new Date(NOW) })
  const drawn = renderBoard(view, { width: 100, height: 30, interactive: true, now: new Date(NOW), scroll: { selected: "todo", card: "#3", anchors: {} } })
  const { scroll, action } = handleInput(drawn.scroll, { type: "key", name: "moveUp" }, drawn)
  assert.deepEqual(action, { type: "order", id: 3, key: "#3", where: "up", among: [1, 2, 3] })
  assert.equal(scroll.card, "#3", "the selection stays on the card")
})

test("the pane: Shift+↓ on the selected To do card moves it down and saves the board; the screen shows the new order", () => {
  const t = setup()
  try {
    for (const title of ["alpha", "beta", "gamma"]) t.ok(["add", "todo", title])
    assert.deepEqual(t.ids("todo"), [3, 2, 1])
    // Tab twice: Waiting → Doing → To do; its first card (gamma) is selected.
    const r = t.pane("\t\t\x1b[1;2B")
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(t.ids("todo"), [2, 3, 1])
    const lines = r.stdout.split("\n")
    const row = (title) => lines.findIndex((l) => l.includes(title))
    assert.ok(row("beta") < row("gamma") && row("gamma") < row("alpha"), r.stdout)
    assert.match(r.stdout, /card 3 moved down/)
    // Shift+↑ twice: back up, then at the top it says it can't go further.
    const r2 = t.pane("\t\t\x1b[B\x1b[1;2A\x1b[1;2A")
    assert.equal(r2.status, 0, r2.stderr)
    assert.deepEqual(t.ids("todo"), [3, 2, 1])
    assert.match(r2.stdout, /card 3 can't go further up/)
  } finally {
    t.done()
  }
})
