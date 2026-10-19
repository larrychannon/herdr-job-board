// Run: node --test (from the repo root)
// The pane's layout, scrolling, keys, mouse and answer buttons. Herdr is faked by
// fixtures/fake-herdr.mjs; the real one is never called.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answerText, buildView, createAnswerer, handleInput, makeOptions, optionsOf, parseInput, renderBoard, sendDecision, viewport } from "../board.mjs"

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

// The wide layout (the pane draws it from 120 columns) at 88 columns, where these tests'
// mouse positions were measured; the inbox and compact layouts have tests of their own.
const draw = (s, opts = {}) =>
  renderBoard(buildView(s, opts.agents ?? null, { now: NOW, workspace: "w9" }), { width: 88, height: 40, now: NOW, interactive: true, layout: "wide", ...opts })

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
  assert.deepEqual(parseInput("xz\x1b[99X\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x07\x1b[>0;95;0c"), [], "unknown keys and the terminal's replies are skipped whole")
  assert.deepEqual(parseInput("\x1b").map((e) => e.name), ["escape"], "Esc on its own")
  assert.deepEqual(parseInput("ctmo").map((e) => e.name), ["copy", "tab", "mouse", "other"])
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

test("keys: Tab / Shift-Tab and ← → move between sections; ↑ ↓ select cards, the view follows; PgUp PgDn, g G scroll", () => {
  const s = state({ waiting: 2, doing: 2, todo: 12 })
  const sel = (events) => feed(s, events).drawn.scroll.selected
  assert.equal(sel([]), "waiting")
  assert.equal(sel([key("next")]), "doing")
  assert.equal(sel([key("next"), key("next"), key("next")]), "waiting", "Tab wraps around, past Done folded")
  assert.equal(sel([key("done"), key("next"), key("next"), key("next")]), "done", "Done open is on the way")
  assert.equal(sel([key("done"), key("next"), key("next"), key("next"), key("next")]), "waiting")
  assert.equal(sel([key("prev")]), "todo", "Done is folded: Shift-Tab skips it")
  assert.equal(sel([key("done"), key("prev")]), "done", "open, it is a section like the others")
  assert.equal(sel([key("right"), key("right")]), "todo", "→ moves on when the card has no buttons")
  const { drawn } = feed(s, [key("next")])
  assert.match(drawn.text, /^▸ DOING \(2\)/m, "the selected section's header is marked")
  assert.match(drawn.text, /^\s*\d+▸Job \d+: build/m, "and its first card")

  // To do has 12 cards. ↑ ↓ move the selection; the view scrolls only when it leaves it.
  const todo = (events) => feed(s, [key("next"), key("next"), ...events]).drawn
  const offset = (d) => d.sections.todo.offset
  const selected = (d) => d.scroll.card
  const start = todo([])
  const page = start.sections.todo.page
  assert.ok(page >= 2)
  assert.equal(selected(todo([key("up")])), selected(start), "↑ on the first card stays")
  const two = todo([key("down"), key("down")])
  assert.equal(selected(two), start.sections.todo.cards[2].key)
  assert.equal(offset(two), Math.max(0, 3 - page), "still in view: no scroll unless needed")
  const past = todo(Array.from({ length: page }, () => key("down")))
  assert.ok(offset(past) >= 1, "one past the page: the view moves")
  assert.match(past.text, new RegExp(`\\d+▸Later ${start.sections.todo.cards[page].key.slice(1)}\\b`), "and the selected card is in it")
  // The least scroll: one card less and the selected card would be out of view again.
  const fewer = draw(s, { scroll: { ...past.scroll, anchors: { ...past.scroll.anchors, todo: { key: past.sections.todo.blockKeys[offset(past) - 1], index: offset(past) - 1 } }, card: undefined, selected: "todo" } })
  assert.ok(fewer.sections.todo.offset < offset(past))
  const bottom = todo([key("bottom")])
  assert.equal(offset(bottom), bottom.sections.todo.maxOffset)
  assert.equal(selected(bottom), start.sections.todo.cards.at(-1).key, "G selects the last card")
  assert.equal(selected(todo([key("bottom"), key("down"), key("down")])), selected(bottom), "↓ on the last card stays")
  assert.equal(offset(todo([key("bottom"), key("top")])), 0)
  assert.equal(offset(todo([key("pagedown")])), Math.min(page, bottom.sections.todo.maxOffset))
  assert.equal(offset(todo([key("pagedown"), key("pageup")])), 0)
  // The markers say how many cards are hidden.
  const paged = todo([key("pagedown")])
  assert.match(paged.text, new RegExp(`↑ ${offset(paged)} above`))
  const below = 12 - offset(paged) - paged.sections.todo.page
  if (below > 0) assert.match(paged.text, new RegExp(`↓ ${below} more`))
  else assert.doesNotMatch(paged.text.split("TO DO")[1] ?? "", /↓ \d+ more/)
})

test("Done: folded by default; d or a click on its line opens it, d or a click on its header folds it; nothing else moves", () => {
  const s = state({ waiting: 2, doing: 2, todo: 12 })
  for (const [width, height, layout] of [[88, 40, "wide"], [120, 40, undefined], [88, 40, undefined], [60, 30, undefined]]) {
    const at = { width, height, layout }
    const folded = draw(s, at)
    const lines = folded.text.split("\n")
    // Wide: at the bottom, just above the key hint; the inbox and compact: after the last section.
    const y = folded.layout === "wide" ? height - 1 : lines.indexOf("DONE · 1 today ▸") + 1
    assert.equal(lines[y - 1], "DONE · 1 today ▸", `${width} ${folded.layout}: one line`)
    if (folded.layout === "wide") assert.equal(y, height - 1, "just above the key hint")
    else assert.match(lines[y - 2 - (folded.layout === "inbox" ? 1 : 0)], /^ +\d+ {3}Later \d+ +30 min$/, "right after To do")
    assert.equal(folded.sections.done, undefined, "no Done section to scroll or select")
    assert.deepEqual(folded.doneToggle, { y, x0: 1, x1: width })
    if (folded.layout === "wide") assert.match(folded.text, /^DOING \(2\) +TO DO \(12\)$/m, `${width}: Doing and To do share the width`)
    // d opens it; d again folds it.
    const open = feed(s, [key("done")], at).drawn
    assert.match(open.text, /DONE \(1\) ▾/)
    assert.match(open.text, /\bShipped\b/)
    assert.doesNotMatch(open.text, /DONE · /)
    assert.equal(feed(s, [key("done"), key("done")], at).drawn.text, folded.text)
    // A click on the folded line opens it; a click on the open header folds it.
    const clickLine = feed(s, [{ type: "click", x: 3, y }], at).drawn
    assert.equal(clickLine.text, open.text)
    const header = find(open, "DONE (1)")
    assert.equal(feed(s, [key("done"), { type: "click", x: header.x + 2, y: header.y }], at).drawn.text, folded.text)
    // The wheel on the folded line does nothing; Enter, c, ↑ ↓ never reach Done.
    assert.equal(feed(s, [{ type: "wheel", dir: "down", x: 3, y }], at).drawn.text, folded.text)
  }
  // The selection and every section's scroll position hold as Done opens and folds.
  const todoHeader = find(draw(s), "TO DO (12)")
  const wheel = { type: "wheel", dir: "down", x: todoHeader.x + 2, y: todoHeader.y + 3 }
  const before = feed(s, [key("next"), key("next"), key("down"), key("down"), wheel]).drawn
  assert.equal(before.scroll.selected, "todo")
  const card = before.scroll.card
  const first = before.sections.todo.blockKeys[before.sections.todo.offset]
  for (const events of [[key("done")], [key("done"), key("done")], [{ type: "click", x: 3, y: 39 }]]) {
    const after = feed(s, [key("next"), key("next"), key("down"), key("down"), wheel, ...events]).drawn
    assert.equal(after.scroll.selected, "todo", "same section")
    assert.equal(after.scroll.card, card, "same card")
    assert.match(after.text, new RegExp(`\\d+▸Later ${card.slice(1)}\\b`), "still marked and in view")
    assert.equal(after.sections.todo.blockKeys[after.sections.todo.offset], first, "same first card in view")
  }
  // Done open and selected, then folded: the selection goes to To do, not anywhere else.
  const inDone = feed(s, [key("done"), key("prev")]).drawn
  assert.equal(inDone.scroll.selected, "done")
  assert.equal(feed(s, [key("done"), key("prev"), key("done")]).drawn.scroll.selected, "todo")
  // Folded, Tab and Shift-Tab and ← → skip it; the details keep d for themselves (it does nothing there).
  assert.deepEqual(
    [[key("next")], [key("next"), key("next")], [key("next"), key("next"), key("next")], [key("prev")], [key("left")]].map((e) => feed(s, e).drawn.scroll.selected),
    ["doing", "todo", "waiting", "todo", "todo"],
  )
  const detail = feed(s, [key("enter"), key("done")]).drawn
  assert.equal(detail.scroll.detail.key, "#1")
  assert.notEqual(detail.scroll.doneOpen, true)
  // Counts stay right: the headers count the cards, the folded line today's Done.
  const many = structuredClone(s)
  for (let i = 0; i < 31; i++) many.items.push({ id: 100 + i, title: `Old ${i}`, column: "done", since: "2026-10-13T09:00:00Z" })
  many.items.push({ id: 200, title: "Yesterday", column: "done", since: "2026-10-12T09:00:00Z" })
  const counted = draw(many)
  assert.match(counted.text, /^DONE · 32 today ▸$/m)
  assert.match(counted.text, /^DOING \(2\) +TO DO \(12\)$/m)
  assert.match(feed(many, [key("done")]).drawn.text, /DONE \(32\) ▾/)
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
  const todoHeader = find(draw(s), "TO DO (12)")
  const wheelTodo = { type: "wheel", dir: "down", x: todoHeader.x + 2, y: todoHeader.y + 3 }
  const scrolled = feed(s, [wheelTodo, wheelTodo, wheelTodo]).drawn
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

test("buttons: → chooses one (the suggested first), Enter presses it; Enter alone opens details; a click on a button presses it (88 and 120)", () => {
  const s = state({ waiting: 3, withOptions: [2, 3] })
  // Card 1 has no buttons: Enter opens its details, nothing is sent.
  const open = feed(s, [key("enter")])
  assert.deepEqual(open.actions, [])
  assert.equal(open.drawn.scroll.detail.key, "#1")
  const onTwo = feed(s, [key("down")]).drawn
  assert.match(onTwo.text, /2▸Card 2: approve/)
  assert.match(onTwo.text, /\[ Go ✓ \]  \[ Not now \]  \[ Other… \]/, "no button is chosen in advance")
  // Enter on a card with buttons, before choosing one: details, not an answer.
  const details = feed(s, [key("down"), key("enter")])
  assert.deepEqual(details.actions, [])
  assert.equal(details.drawn.scroll.detail.key, "#2")
  assert.match(feed(s, [key("down"), key("right")]).drawn.text, /< Go ✓ >  \[ Not now \]  \[ Other… \]/, "→ chooses the suggested one")
  assert.deepEqual(feed(s, [key("down"), key("right"), key("enter")]).actions, [{ type: "send", id: 2, key: "#2", label: "Go" }])
  assert.deepEqual(feed(s, [key("down"), key("right"), key("right"), key("enter")]).actions, [{ type: "send", id: 2, key: "#2", label: "Not now" }])
  assert.deepEqual(feed(s, [key("down"), key("right"), key("right"), key("right"), key("right"), key("enter")]).actions, [{ type: "other", id: 2, key: "#2" }], "→ stops at Other…")
  assert.deepEqual(feed(s, [key("down"), key("right"), key("left"), key("left"), key("enter")]).actions[0].label, "Go", "← stops at the first")
  assert.equal(feed(s, [key("down"), key("right"), key("escape"), key("enter")]).drawn.scroll.detail.key, "#2", "Esc un-chooses the button")
  assert.deepEqual(feed(s, [key("down"), key("down"), key("other")]).actions, [{ type: "other", id: 3, key: "#3" }])
  assert.equal(feed(s, [key("down"), key("next")]).drawn.scroll.selected, "doing", "Tab still changes section")

  for (const width of [88, 120]) {
    const drawn = draw(s, { width, layout: undefined, ...(width < 120 ? { scroll: { selected: "waiting", anchors: {}, card: "#3" } } : {}) })
    // The inbox shows the selected card's buttons only (card 3's here); wide shows every card's.
    const inbox = drawn.layout === "inbox"
    const notNow = find(drawn, "[ Not now ]", inbox ? 0 : 1)
    assert.ok(notNow, `card 3's button is on screen at ${width}`)
    const press = (x, y) => handleInput(drawn.scroll, { type: "click", x, y }, drawn).action
    assert.deepEqual(press(notNow.x, notNow.y), { type: "send", id: 3, key: "#3", label: "Not now" }, `${width}: first cell`)
    assert.deepEqual(press(notNow.x + 10, notNow.y), { type: "send", id: 3, key: "#3", label: "Not now" }, `${width}: last cell`)
    assert.equal(press(notNow.x + 11, notNow.y), null, `${width}: just past it`)
    assert.equal(press(notNow.x, notNow.y + 1), null, `${width}: the line below`)
    const other = find(drawn, "[ Other… ]", 0)
    assert.deepEqual(press(other.x + 1, other.y), inbox ? { type: "other", id: 3, key: "#3" } : { type: "other", id: 2, key: "#2" })
    if (inbox) assert.equal(find(drawn, "[ Other… ]", 1), undefined, "card 2's row is closed: no buttons")
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
    const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: join(base, ".git", "board-state"), JOB_BOARD_NOW: NOW.toISOString() }
    const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
    const items = () => JSON.parse(readFileSync(join(base, ".git", "board-state", "board.json"), "utf8")).items
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
    // A coordinator Herdr can prompt (ready for input).
    const agents = [{ name: "coord", agent_status: "idle", workspace_id: "w9", pane_id: "w9:p1", interactive_ready: true }]
    writeFileSync(herdr, JSON.stringify({ agents }))
    const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", JOB_BOARD_FILE: "", JOB_BOARD_HOME: join(base, ".git", "board-state"), JOB_BOARD_NOW: NOW.toISOString(), NO_COLOR: "1", TZ: "UTC" }
    const board = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
    const pane = (keys, origin = "w9:p1") =>
      spawnSync(process.execPath, [PANE, "--once", "--width", "88", "--height", "30", "--origin", origin, "--keys", keys], { cwd: base, env, encoding: "utf8" })
    // A card's note can wrap: read it as one line.
    const flat = (r) => r.stdout.replace(/\n +/g, " ")
    const calls = () => JSON.parse(readFileSync(herdr, "utf8")).log.filter((a) => a[0] !== "agent" || a[1] !== "list")
    const log = () => calls().filter((a) => a[0] === "agent")
    const typed = () => calls().filter((a) => a[1] === "send-text" || a[1] === "send-keys")
    const items = () => JSON.parse(readFileSync(join(base, ".git", "board-state", "board.json"), "utf8")).items
    const title = `Hooks: build? $(touch ${base}/pwned) \`touch ${base}/pwned2\``
    const rearm = () => board("edit", "1", "--option", "Go", "--option", "Not now", "--suggest", "Go")
    assert.equal(board("add", "waiting", title, "--desc", "Keep the board fresh.", "--ask", "Say go", "--option", "Go", "--option", "Not now", "--suggest", "Go").status, 0)

    let r = pane("\x1b[C\r")
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(log(), [["agent", "prompt", "w9:p1", `Board card 1 (${title}): Go`]], "one argv element; no shell ever sees it")
    assert.ok(!existsSync(join(base, "pwned")) && !existsSync(join(base, "pwned2")), "nothing in the title ran")
    assert.deepEqual(items()[0].sent, { label: "Go", at: NOW.toISOString() })
    assert.match(r.stdout, /sent: Go · 10:30/)

    // Pressing again only asks; pressing twice sends again.
    r = pane("\x1b[C\r")
    assert.match(r.stdout, /send again\? "Go" was sent already/)
    assert.equal(log().length, 1)
    pane("\x1b[C\r\r")
    assert.equal(log().length, 2)

    // Other…: only focuses the coordinator; nothing is typed for the user.
    r = pane("o")
    assert.deepEqual(log().at(-1), ["agent", "focus", "w9:p1"])
    assert.match(r.stdout, /type your answer for card 1 in the coordinator's chat/)

    // The coordinator is gone, blocked on a question, or not started by Herdr: one red line,
    // nothing marked sent, and never anything typed into its pane.
    rearm()
    r = pane("\x1b[C\r", "w9:p7")
    assert.match(r.stdout, /couldn't send: coordinator pane not found/)
    assert.equal(items()[0].sent, undefined)
    writeFileSync(herdr, JSON.stringify({ agents: [{ ...agents[0], name: undefined, agent_status: "blocked" }] }))
    assert.match(flat(pane("\x1b[C\r")), /couldn't send: the coordinator is waiting on a question in its pane; answer it there, then press again/)
    writeFileSync(herdr, JSON.stringify({ agents: [{ ...agents[0], name: undefined, interactive_ready: undefined }] }))
    assert.match(flat(pane("\x1b[C\r")), /couldn't send: the coordinator isn't taking input right now \(a prompt may be open in its pane\); press again in a moment/)
    assert.match(pane("\x1b[C\r", "").stdout, /couldn't send: no coordinator pane known/)
    assert.deepEqual(typed(), [], "no send-text, no send-keys, ever")
    assert.equal(items()[0].sent, undefined)

    // A click on a button sends too.
    writeFileSync(herdr, JSON.stringify({ agents, log: [] }))
    const screen = pane("").stdout.split("\n")
    const y = screen.findIndex((l) => l.includes("[ Not now ]"))
    const x = [...screen[y].slice(0, screen[y].indexOf("[ Not now ]"))].length + 1
    pane(`\x1b[<0;${x + 3};${y + 1}M`)
    assert.deepEqual(log().at(-1), ["agent", "prompt", "w9:p1", `Board card 1 (${title}): Not now`])

    // A hand-written board with a hostile id: refused when read, so nothing is ever sent.
    const file = join(base, ".git", "board-state", "board.json")
    const hostile = JSON.parse(readFileSync(file, "utf8"))
    hostile.items[0].id = "7\u001b]52;c;cHduZWQ=\u0007\u001b[2J"
    writeFileSync(file, JSON.stringify(hostile))
    writeFileSync(herdr, JSON.stringify({ agents, log: [] }))
    r = pane("\x1b[C\r")
    assert.match(r.stdout, /is not a job board \(every item id must be/)
    assert.doesNotMatch(r.stdout, /\u001b|\u0007/)
    assert.deepEqual(log(), [])
    const ls = board("ls")
    assert.equal(ls.status, 1)
    assert.match(ls.stderr, /every item id must be a positive whole number/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("answerText: only a positive whole id, the cleaned title and the cleaned label", () => {
  assert.equal(answerText({ id: 3, title: "Ship\u001b[2J it\u0007" }, "Go\u009b"), "Board card 3 (Ship[2J it): Go")
  for (const id of ["3", "7\u001b]52;c;x\u0007", 0, -1, 1.5, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => answerText({ id, title: "x" }, "Go"), /no valid id/, String(id))
  }
})

test("presses run one at a time: a double press sends once; failures become notes, never a crash", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-answerer-")))
  const file = join(base, "board.json")
  const item = { id: 1, title: "Ship it?", column: "waiting", since: NOW.toISOString(), options: [{ label: "Go", suggested: true }] }
  const write = (extra = {}) => writeFileSync(file, JSON.stringify({ version: 1, next_id: 2, items: [{ ...item, ...extra }], panes: {} }))
  const go = { type: "send", id: 1, key: "#1", label: "Go" }
  try {
    write()
    const sent = []
    const slow = (action) => new Promise((done) => setTimeout(() => done(sent.push(action) && null), 50))
    const answers = createAnswerer({ file, origin: "w9:p1", now: () => NOW, send: slow })
    // A double click: the second press arrives while the first is still sending.
    await Promise.all([answers.press(go), answers.press(go)])
    assert.equal(sent.length, 1, "one send")
    assert.equal(JSON.parse(readFileSync(file, "utf8")).items[0].sent.label, "Go")
    // A later press asks first.
    await answers.press(go)
    assert.equal(sent.length, 1)
    assert.match(answers.notes["#1"].t, /send again\?/)

    // The send fails: a note, and the next press still works.
    write()
    const failing = createAnswerer({ file, origin: "w9:p1", now: () => NOW, send: async () => "coordinator pane not found" })
    await failing.press(go)
    assert.equal(failing.notes["#1"].t, "couldn't send: coordinator pane not found")
    const throwing = createAnswerer({ file, origin: "w9:p1", now: () => NOW, send: async () => { throw new Error("boom") } })
    await throwing.press(go)
    assert.equal(throwing.notes["#1"].t, "couldn't send: boom")
    // Sent, but the board is locked by a live process: said on the card, the pane goes on.
    mkdirSync(`${file}.lock`)
    writeFileSync(join(`${file}.lock`, "owner"), `${process.pid} ${hostname()} x`)
    process.env.JOB_BOARD_LOCK_WAIT_MS = "200"
    const locked = createAnswerer({ file, origin: "w9:p1", now: () => NOW, send: async () => null })
    await locked.press(go)
    assert.match(locked.notes["#1"].t, /^sent, but couldn't note it on the card: the board is locked by process/)
    // An unreadable board: a note.
    rmSync(`${file}.lock`, { recursive: true })
    writeFileSync(file, "not json")
    const broken = createAnswerer({ file, origin: "w9:p1", now: () => NOW, send: async () => null })
    await broken.press(go)
    assert.match(broken.notes["#1"].t, /^couldn't send: .*not valid JSON/)
  } finally {
    delete process.env.JOB_BOARD_LOCK_WAIT_MS
    rmSync(base, { recursive: true, force: true })
  }
})

test("viewport: every card is above, shown or below, at any height", () => {
  const sizes = [1, 3, 5, 2, 4, 6, 1, 1, 7, 2]
  const blocks = sizes.map((h, i) => ({ keys: [`#${i + 1}`], lines: Array.from({ length: h }, (_, j) => [{ t: `card ${i + 1} line ${j + 1}` }]) }))
  for (let height = 0; height <= 30; height++) {
    for (let offset = 0; offset <= blocks.length; offset++) {
      const v = viewport(blocks, height, offset)
      assert.ok(v.lines.length <= height, `${height}/${offset}: ${v.lines.length} lines`)
      assert.equal(v.above + v.shown + v.below, blocks.length, `${height}/${offset}: ${v.above} + ${v.shown} + ${v.below}`)
      const text = v.lines.map((l) => l.map((s) => s.t).join("")).join("\n")
      if (v.above && height > 0) assert.match(text, new RegExp(`↑ ${v.above} above`), `${height}/${offset}`)
      if (v.below && height > 0) assert.match(text, new RegExp(`↓ ${v.below} more`), `${height}/${offset}`)
      // A card shown cut says so on the last line; one shown whole never does.
      const cutShown = v.shown === 1 && v.lines.length && !text.includes(`card ${v.offset + 1} line ${sizes[v.offset]}`)
      assert.equal(v.cut, cutShown, `${height}/${offset}: cut`)
      if (v.cut) assert.match(v.lines.at(-1)[0].t, /card cut off: open it for the rest$/, `${height}/${offset}`)
      // A card counted as shown has at least one line on screen.
      for (let k = v.offset; k < v.offset + v.shown; k++) assert.ok(text.includes(`card ${k + 1} line 1`), `${height}/${offset}: card ${k + 1}`)
    }
  }
})
