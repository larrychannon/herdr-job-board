// Run: node --test (from the repo root)
// The pane's layout, scrolling, keys, mouse and answer buttons. Herdr is faked by
// fixtures/fake-herdr.mjs; the real one is never called.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, handleInput, makeOptions, optionsOf, parseInput, renderBoard, sendDecision, viewport } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = join(ROOT, "board-pane.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const NOW = new Date("2026-10-13T10:30:00Z")

const key = (name) => ({ type: "key", name })

/** A board in memory: `waiting` cards (with options when given), plus Doing, To do and Done. */
function state({ waiting = 6, doing = 2, todo = 3, withOptions = [] } = {}) {
  const items = []
  let id = 1
  const at = "2026-10-13T10:00:00Z"
  for (let i = 0; i < waiting; i++, id++) {
    const item = { id, title: `Card ${id}: approve`, desc: `What card ${id} is about, in a sentence long enough to wrap.`, column: "waiting", ask: `Reply ok (${id})`, since: at }
    if (withOptions.includes(id)) item.options = [{ label: "Go", suggested: true }, { label: "Not now" }]
    items.push(item)
  }
  for (let i = 0; i < doing; i++, id++) items.push({ id, title: `Job ${id}: build`, desc: "Building it.", column: "doing", since: at })
  for (let i = 0; i < todo; i++, id++) items.push({ id, title: `Later ${id}`, desc: "Some day.", column: "todo", since: at })
  items.push({ id, title: "Shipped", column: "done", since: at })
  return { version: 1, next_id: id + 1, items, panes: {} }
}

const draw = (s, opts = {}) =>
  renderBoard(buildView(s, opts.agents ?? null, { now: NOW, workspace: "w9" }), { width: 88, height: 40, now: NOW, interactive: true, ...opts })

/** Feed events one by one, redrawing after each, as the pane does. */
function feed(s, events, opts = {}) {
  let drawn = draw(s, opts)
  const actions = []
  for (const event of events) {
    const { scroll, action } = handleInput(drawn.scroll, event, drawn)
    if (action) actions.push(action)
    drawn = draw(s, { ...opts, scroll })
  }
  return { drawn, actions }
}

/** Where `text` is on the screen, 1-based, as a mouse report gives it. */
function find(drawn, text, nth = 0) {
  const lines = drawn.text.split("\n")
  const hits = []
  lines.forEach((l, y) => {
    let x = l.indexOf(text)
    while (x >= 0) {
      hits.push({ x: [...l.slice(0, x)].length + 1, y: y + 1 })
      x = l.indexOf(text, x + 1)
    }
  })
  return hits[nth]
}

test("parseInput: keys, SGR mouse reports, and junk skipped", () => {
  assert.deepEqual(parseInput("\t\x1b[Z\x1b[C\x1b[D\x1bOA\x1b[B").map((e) => e.name), ["next", "prev", "right", "left", "up", "down"])
  assert.deepEqual(parseInput("jkgGqr\r\no\x03").map((e) => e.name), ["down", "up", "top", "bottom", "quit", "redraw", "enter", "enter", "other", "quit"])
  assert.deepEqual(parseInput("\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[5;5~").map((e) => e.name), ["pageup", "pagedown", "top", "bottom", "top", "bottom", "pageup"])
  assert.deepEqual(parseInput("\x1b[<64;10;5M\x1b[<65;11;6M\x1b[<68;1;1M"), [
    { type: "wheel", dir: "up", x: 10, y: 5 },
    { type: "wheel", dir: "down", x: 11, y: 6 },
    { type: "wheel", dir: "up", x: 1, y: 1 },
  ])
  // A left press is a click; its release, motion, and other buttons are not.
  assert.deepEqual(parseInput("\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<32;3;4M\x1b[<2;3;4M"), [{ type: "click", x: 3, y: 4 }])
  assert.deepEqual(parseInput("x\x1b\x1b[99Xz\x1b[?1;2c"), [], "unknown keys and sequences are skipped")
})

test("viewport: markers count the cards above and below; the offset stops at the ends", () => {
  const blocks = Array.from({ length: 6 }, (_, i) => ({ keys: [`#${i + 1}`], lines: [[{ t: `card ${i + 1}` }], [{ t: "desc" }]] }))
  const texts = (v) => v.lines.map((l) => l[0]?.t ?? "")
  const first = viewport(blocks, 8, 0)
  assert.deepEqual(texts(first), ["card 1", "desc", "", "card 2", "desc", "↓ 4 more"])
  assert.equal(first.below, 4)
  assert.equal(first.page, 2)
  const mid = viewport(blocks, 8, 2)
  assert.deepEqual(texts(mid), ["↑ 2 above", "card 3", "desc", "", "card 4", "desc", "↓ 2 more"])
  const end = viewport(blocks, 8, 99)
  assert.equal(end.maxOffset, 4)
  assert.equal(end.offset, 4, "clamped to the last full page")
  assert.deepEqual(texts(end), ["↑ 4 above", "card 5", "desc", "", "card 6", "desc"])
  assert.equal(end.below, 0)
  // A card taller than the space is cut, never skipped.
  const tall = viewport([{ keys: ["#1"], lines: Array.from({ length: 20 }, () => [{ t: "x" }]) }], 5, 0)
  assert.equal(tall.lines.length, 5)
  assert.equal(viewport([], 5, 0).lines.length, 0)
})

test("keys: Tab / Shift-Tab and ← → move between sections; ↑ ↓, PgUp PgDn, g G scroll and stop at the ends", () => {
  const s = state({ waiting: 2, doing: 2, todo: 12 })
  const sel = (events) => feed(s, events).drawn.scroll.selected
  assert.equal(sel([]), "waiting")
  assert.equal(sel([key("next")]), "doing")
  assert.equal(sel([key("next"), key("next"), key("next"), key("next")]), "waiting", "Tab wraps around")
  assert.equal(sel([key("prev")]), "done")
  assert.equal(sel([key("right"), key("right")]), "todo", "→ moves on when the card has no buttons")
  const { drawn } = feed(s, [key("next")])
  assert.match(drawn.text, /^▸ DOING \(2\)/m, "the selected section's header is marked")

  // To do has 12 cards: scroll it.
  const todo = (events) => feed(s, [key("next"), key("next"), ...events]).drawn
  const offset = (d) => d.sections.todo.offset
  assert.equal(offset(todo([key("up")])), 0, "↑ at the top stays at the top")
  assert.equal(offset(todo([key("down"), key("down")])), 2)
  const bottom = todo([key("bottom")])
  assert.equal(offset(bottom), bottom.sections.todo.maxOffset)
  assert.equal(offset(todo([key("bottom"), key("down"), key("down")])), bottom.sections.todo.maxOffset, "↓ at the bottom stays there")
  assert.equal(offset(todo([key("bottom"), key("top")])), 0)
  const page = todo([]).sections.todo.page
  assert.ok(page >= 1)
  assert.equal(offset(todo([key("pagedown")])), Math.min(page, bottom.sections.todo.maxOffset))
  assert.equal(offset(todo([key("pagedown"), key("pageup")])), 0)
  // The markers say how many cards are hidden.
  const two = todo([key("down"), key("down")])
  assert.match(two.text, /↑ 2 above/)
  const shown = two.sections.todo.page
  assert.match(two.text, new RegExp(`↓ ${12 - 2 - shown} more`))
})

test("mouse: the wheel scrolls the section under the pointer, a click selects it", () => {
  const s = state({ waiting: 8, todo: 12 })
  const start = draw(s)
  const todoHeader = find(start, "TO DO (12)")
  const down = { type: "wheel", dir: "down", x: todoHeader.x + 2, y: todoHeader.y + 3 }
  const after = feed(s, [down, down]).drawn
  assert.equal(after.sections.todo.offset, 2)
  assert.equal(after.sections.waiting.offset, 0, "other sections stay put")
  assert.equal(after.scroll.selected, "waiting", "the wheel doesn't change the selection")
  const waitDown = feed(s, [{ type: "wheel", dir: "down", x: 5, y: 6 }]).drawn
  assert.equal(waitDown.sections.waiting.offset, 1)
  assert.equal(feed(s, [{ type: "click", x: todoHeader.x, y: todoHeader.y + 2 }]).drawn.scroll.selected, "todo")
})

test("scroll position holds across redraws and new cards", () => {
  const s = state({ waiting: 2, todo: 12 })
  const scrolled = feed(s, [key("next"), key("next"), key("down"), key("down"), key("down")]).drawn
  assert.equal(scrolled.sections.todo.offset, 3)
  const firstShown = scrolled.sections.todo.blockKeys[3]
  // The 3-second redraw, same data: same place.
  assert.equal(draw(s, { scroll: scrolled.scroll }).sections.todo.offset, 3)
  // A card added at the end never moves the view.
  const later = structuredClone(s)
  later.items.push({ id: 99, title: "Appended", column: "todo", since: "2026-10-13T10:29:00Z" })
  const kept = draw(later, { scroll: scrolled.scroll })
  assert.equal(kept.sections.todo.blockKeys[kept.sections.todo.offset], firstShown)
  // The first card in view is done: the view stays at the same place in the list.
  const gone = structuredClone(s)
  gone.items.find((i) => `#${i.id}` === firstShown).column = "done"
  const after = draw(gone, { scroll: scrolled.scroll }).sections.todo
  assert.equal(after.offset, Math.min(3, after.maxOffset))
  // A blocked agent appears at the top of Waiting: the card in view stays in view.
  const w = state({ waiting: 8 })
  const wheel = { type: "wheel", dir: "down", x: 5, y: 6 }
  const down = feed(w, [wheel, wheel]).drawn
  const inView = down.sections.waiting.blockKeys[down.sections.waiting.offset]
  assert.match(down.text, /↑ 2 above/)
  const withBlocked = draw(w, { scroll: down.scroll, agents: [{ name: "stuck", agent_status: "blocked", workspace_id: "w9" }] })
  assert.equal(withBlocked.sections.waiting.blockKeys[withBlocked.sections.waiting.offset], inView)
  assert.match(withBlocked.text, /↑ 3 above/, "one more card above now")
})

test("buttons: ← → select, Enter and o press, ↑ ↓ move between cards; a click on a button presses it (88 and 120)", () => {
  const s = state({ waiting: 3, withOptions: [2, 3] })
  // Card 1 has no buttons: Enter does nothing; ↓ goes to card 2 with its suggested answer chosen.
  assert.deepEqual(feed(s, [key("enter")]).actions, [])
  const onTwo = feed(s, [key("down")]).drawn
  assert.match(onTwo.text, /2▸Card 2: approve/)
  assert.match(onTwo.text, /< Go ✓ >  \[ Not now \]  \[ Other… \]/)
  assert.deepEqual(feed(s, [key("down"), key("enter")]).actions, [{ type: "send", id: 2, key: "#2", label: "Go" }])
  assert.deepEqual(feed(s, [key("down"), key("right"), key("enter")]).actions, [{ type: "send", id: 2, key: "#2", label: "Not now" }])
  assert.deepEqual(feed(s, [key("down"), key("right"), key("right"), key("right"), key("enter")]).actions, [{ type: "other", id: 2, key: "#2" }], "→ stops at Other…")
  assert.deepEqual(feed(s, [key("down"), key("left"), key("left"), key("enter")]).actions[0].label, "Go", "← stops at the first")
  assert.deepEqual(feed(s, [key("down"), key("down"), key("other")]).actions, [{ type: "other", id: 3, key: "#3" }])
  assert.equal(feed(s, [key("down"), key("next")]).drawn.scroll.selected, "doing", "Tab still changes section")

  for (const width of [88, 120]) {
    const drawn = draw(s, { width })
    const notNow = find(drawn, "[ Not now ]", 1)
    assert.ok(notNow, `card 3's button is on screen at ${width}`)
    const press = (x, y) => handleInput(drawn.scroll, { type: "click", x, y }, drawn).action
    assert.deepEqual(press(notNow.x, notNow.y), { type: "send", id: 3, key: "#3", label: "Not now" }, `${width}: first cell`)
    assert.deepEqual(press(notNow.x + 10, notNow.y), { type: "send", id: 3, key: "#3", label: "Not now" }, `${width}: last cell`)
    assert.equal(press(notNow.x + 11, notNow.y), null, `${width}: just past it`)
    assert.equal(press(notNow.x, notNow.y + 1), null, `${width}: the line below`)
    const other = find(drawn, "[ Other… ]", 0)
    assert.deepEqual(press(other.x + 1, other.y), { type: "other", id: 2, key: "#2" })
  }
  // At 120 two cards share a row: card 2's buttons sit in the right half.
  assert.ok(find(draw(s, { width: 120 }), "[ Not now ]", 0).x > 60)
})

test("sendDecision: a card answered already asks before sending again", () => {
  assert.deepEqual(sendDecision({ id: 4 }, "Go", null, 1000), { send: true, confirm: null, note: null })
  const sent = { id: 4, sent: { label: "Go", at: "2026-10-13T10:00:00Z" } }
  const first = sendDecision(sent, "Go", null, 1000)
  assert.equal(first.send, false)
  assert.match(first.note.t, /send again\?/)
  assert.equal(sendDecision(sent, "Go", first.confirm, 5000).send, true, "the same button again within 10 s")
  assert.equal(sendDecision(sent, "Not now", first.confirm, 5000).send, false, "another button asks again")
  assert.equal(sendDecision(sent, "Go", first.confirm, 12_000).send, false, "too late: asks again")
  assert.equal(sendDecision({ id: 5, sent: sent.sent }, "Go", first.confirm, 5000).send, false, "another card asks again")
})

test("options: cleaned, at most 4 of at most 24 characters, Waiting only; job paths drop them", () => {
  assert.deepEqual(makeOptions(["Go", "Not now"], "Go"), [{ label: "Go", suggested: true }, { label: "Not now" }])
  assert.deepEqual(makeOptions([" Go\u001b[2J ", "Later\u0007"]), [{ label: "Go[2J" }, { label: "Later" }])
  assert.throws(() => makeOptions(["a", "b", "c", "d", "e"]), /at most 4/)
  assert.throws(() => makeOptions(["x".repeat(25)]), /longer than 24/)
  assert.throws(() => makeOptions(["Go", "go"]), /different/)
  assert.throws(() => makeOptions(["Go"], "Stop"), /not one of/)
  assert.throws(() => makeOptions(["  "]), /needs a label/)
  // Read back defensively: a hand-written board can't make bigger or dirtier buttons.
  assert.deepEqual(optionsOf({ options: [{ label: "y".repeat(40), suggested: "yes" }, null, { label: "\u009b" }, 7, { label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] }), [
    { label: "y".repeat(24), suggested: false },
    { label: "a", suggested: false },
    { label: "b", suggested: false },
    { label: "c", suggested: false },
  ])

  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-options-")))
  try {
    spawnSync("git", ["-C", base, "init", "-q"])
    const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_NOW: NOW.toISOString() }
    const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
    const items = () => JSON.parse(readFileSync(join(base, ".git", "job-board.json"), "utf8")).items
    assert.equal(run("add", "waiting", "Ship it?", "--ask", "Say go", "--option", "Go", "--option", "Not now", "--suggest", "Go").status, 0)
    assert.deepEqual(items()[0].options, [{ label: "Go", suggested: true }, { label: "Not now" }])
    assert.equal(run("add", "todo", "x", "--option", "Go").status, 2, "buttons are for Waiting cards")
    assert.equal(run("add", "waiting", "x", "--option", "a", "--option", "b", "--option", "c", "--option", "d", "--option", "e").status, 2)
    assert.equal(run("edit", "1", "--suggest", "Not now").status, 0)
    assert.deepEqual(items()[0].options, [{ label: "Go" }, { label: "Not now", suggested: true }])
    assert.equal(run("edit", "1", "--clear-options").status, 0)
    assert.equal(items()[0].options, undefined)
    // A card a job reports on never keeps buttons, wherever they came from.
    assert.equal(run("add", "waiting", "Job's card", "--job", "build", "--option", "Merge").status, 0)
    const report = join(base, "r.json")
    writeFileSync(report, JSON.stringify({ status: "done", needs_user: ["Merge PR #21"] }))
    assert.equal(run("job-report", "build", report).status, 0)
    assert.equal(items()[1].options, undefined)
    assert.equal(run("job-start", "build", "--id", "2").status, 0)
    assert.equal(run("job-start", "build", "--option", "Go").status, 2, "job-start takes no --option")
    assert.equal(items()[1].options, undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("buttons end to end: the prompt's exact argv, sent state, send again?, Other…, errors", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-buttons-")))
  try {
    spawnSync("git", ["-C", base, "init", "-q"])
    const herdr = join(base, "herdr.json")
    const agents = [{ name: "coord", agent_status: "idle", workspace_id: "w9", pane_id: "w9:p1" }]
    writeFileSync(herdr, JSON.stringify({ agents }))
    const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", JOB_BOARD_FILE: "", JOB_BOARD_NOW: NOW.toISOString(), NO_COLOR: "1", TZ: "UTC" }
    const board = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
    const pane = (keys, origin = "w9:p1") =>
      spawnSync(process.execPath, [PANE, "--once", "--width", "88", "--height", "30", "--origin", origin, "--keys", keys], { cwd: base, env, encoding: "utf8" })
    const log = () => JSON.parse(readFileSync(herdr, "utf8")).log.filter((a) => (a[0] === "agent" && a[1] !== "list") || a[1] === "send-text" || a[1] === "send-keys")
    const items = () => JSON.parse(readFileSync(join(base, ".git", "job-board.json"), "utf8")).items
    assert.equal(board("add", "waiting", `Hooks: build? $(touch ${base}/pwned) \`touch ${base}/pwned2\``, "--desc", "Keep the board fresh.", "--ask", "Say go", "--option", "Go", "--option", "Not now", "--suggest", "Go").status, 0)

    let r = pane("\r")
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(log(), [["agent", "prompt", "w9:p1", `Board card 1 (Hooks: build? $(touch ${base}/pwned) \`touch ${base}/pwned2\`): Go`]], "one argv element; no shell ever sees it")
    assert.ok(!existsSync(join(base, "pwned")) && !existsSync(join(base, "pwned2")), "nothing in the title ran")
    assert.deepEqual(items()[0].sent, { label: "Go", at: NOW.toISOString() })
    assert.match(r.stdout, /sent: Go · 10:30/)

    // Pressing again only asks; pressing twice sends again.
    r = pane("\r")
    assert.match(r.stdout, /send again\? "Go" was sent already/)
    assert.equal(log().length, 1)
    pane("\r\r")
    assert.equal(log().length, 2)

    // Other…: focus the coordinator and type "Board card 1: " without Enter.
    pane("o")
    assert.deepEqual(log().slice(-2), [["agent", "focus", "w9:p1"], ["pane", "send-text", "w9:p1", "Board card 1: "]])

    // The coordinator is gone, or blocked on a question: one red line, nothing marked sent.
    board("edit", "1", "--option", "Go", "--option", "Not now", "--suggest", "Go")
    r = pane("\r", "w9:p7")
    assert.match(r.stdout, /couldn't send: coordinator pane not found/)
    assert.equal(items()[0].sent, undefined)
    // (No name, so it doesn't also show as a blocked card of its own.)
    writeFileSync(herdr, JSON.stringify({ ...JSON.parse(readFileSync(herdr, "utf8")), agents: [{ ...agents[0], name: undefined, agent_status: "blocked" }] }))
    r = pane("\r")
    assert.match(r.stdout, /couldn't send: the coordinator is waiting on a question in its pane/)
    r = pane("\r", "")
    assert.match(r.stdout, /couldn't send: no coordinator pane known/)
    // A coordinator the user started has no Herdr name, so `agent prompt` refuses it: the answer
    // is typed in as the user would, but only when Herdr sees an agent there.
    writeFileSync(herdr, JSON.stringify({ agents: [{ ...agents[0], name: undefined }], log: [] }))
    board("edit", "1", "--option", "Go", "--option", "Not now", "--suggest", "Go")
    r = pane("\r")
    assert.doesNotMatch(r.stdout, /couldn't send/)
    assert.deepEqual(log().slice(-3), [
      ["agent", "get", "w9:p1"],
      ["pane", "send-text", "w9:p1", `Board card 1 (Hooks: build? $(touch ${base}/pwned) \`touch ${base}/pwned2\`): Go`],
      ["pane", "send-keys", "w9:p1", "enter"],
    ])
    // A shell there (no agent): nothing is typed.
    writeFileSync(herdr, JSON.stringify({ agents: [], log: [] }))
    board("edit", "1", "--option", "Go", "--option", "Not now", "--suggest", "Go")
    r = pane("\r")
    assert.match(r.stdout, /couldn't send: coordinator pane not found/)
    assert.deepEqual(JSON.parse(readFileSync(herdr, "utf8")).log.filter((a) => a[1] === "send-text" || a[1] === "send-keys"), [])
    // A click on a button sends too.
    writeFileSync(herdr, JSON.stringify({ agents, log: [] }))
    const screen = pane("").stdout.split("\n")
    const y = screen.findIndex((l) => l.includes("[ Not now ]"))
    const x = [...screen[y].slice(0, screen[y].indexOf("[ Not now ]"))].length + 1
    pane(`\x1b[<0;${x + 3};${y + 1}M`)
    assert.deepEqual(log().at(-1), ["agent", "prompt", "w9:p1", `Board card 1 (Hooks: build? $(touch ${base}/pwned) \`touch ${base}/pwned2\`): Not now`])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
