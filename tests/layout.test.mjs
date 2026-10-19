// Run: node --test (from the repo root)
// The layout by pane size (wide, inbox, compact): breakpoints, one-line rows, folding, every
// card counted, widths with emoji and CJK text, colour never the only signal, Space and ← →.
import "./guard.mjs"
import assert from "node:assert/strict"
import test from "node:test"

import { buildView, emojiOn, formatAge, handleInput, layoutOf, renderBoard, SECTION_EMOJI, textWidth, wrap } from "../board.mjs"

const NOW = new Date("2026-10-13T10:30:00Z")
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const plain = (text) => text.replace(ANSI, "")
const key = (name) => ({ type: "key", name })

/** A board like the user's: Waiting cards with buttons, a Doing job, To do cards with long, CJK and emoji titles, Done. */
function board({ waiting = 4, doing = 1, todo = 8, done = 2 } = {}) {
  const items = []
  let id = 181
  const at = (h) => new Date(NOW - h * 3600_000).toISOString()
  const titles = [
    "UI consistency plan: answer 10 questions",
    "粵語標題：今日要做嘅嘢，記得覆客 (Cantonese title)",
    "🚀 Launch ✅ checklist ❤️ with emoji 👨‍👩‍👧 in it",
    "Telegram bot token leaked in a screenshot: replace it now, before anyone else sees it and uses it",
    "SNMP stats follow-ups (from #142 re-check)",
    "全形ＡＢＣ and ｶﾀｶﾅ half-width kana",
    "Redis / AC: parked until a real SFC node reports via AC",
    "3CX SSL certificate: renew before ~25 Oct 2026",
  ]
  const t = (i) => titles[i % titles.length]
  for (let i = 0; i < waiting; i++) {
    items.push({ id: id++, title: t(i), desc: `Card ${i}: ${"a long description that wraps over several lines and is cut at three ".repeat(2)}`, column: "waiting", ask: "Accept all suggested answers, or go through them?", since: at(i * 20 + 1), options: [{ label: "Accept all ✓", suggested: true }, { label: "Go through" }] })
  }
  for (let i = 0; i < doing; i++) items.push({ id: id++, title: t(i + 3), desc: "Building it.", column: "doing", job: `job-${i}`, since: at(0.2) })
  for (let i = 0; i < todo; i++) items.push({ id: id++, title: t(i + 1), desc: "Later.", column: "todo", since: at(30 + i) })
  for (let i = 0; i < done; i++) items.push({ id: id++, title: t(i), column: "done", since: at(0.5) })
  return { version: 1, next_id: id, items, panes: {} }
}
const agents = [{ name: "job-0", agent_status: "working", workspace_id: "w9" }]
const draw = (state, opts = {}) => renderBoard(buildView(state, opts.agents ?? agents, { now: NOW, workspace: "w9" }), { width: 95, height: 40, interactive: true, now: NOW, frame: 0, ...opts })

test("layoutOf: wide from 120 columns, the inbox from 70, compact under 70 columns or under 24 rows", () => {
  for (const [w, h, want] of [
    [200, 60, "wide"],
    [120, 24, "wide"],
    [119, 40, "inbox"],
    [95, 40, "inbox"],
    [70, 24, "inbox"],
    [69, 40, "compact"],
    [40, 60, "compact"],
    [120, 23, "compact"],
    [200, 15, "compact"],
    [95, Infinity, "inbox"],
  ]) {
    assert.equal(layoutOf(w, h), want, `${w}x${h}`)
    assert.equal(draw(board(), { width: w, height: Number.isFinite(h) ? h : 40 }).layout, Number.isFinite(h) ? want : "inbox")
  }
})

test("every size from 40x15 to 200x60: exactly the pane's lines, none wider, and no card left out without a count", () => {
  const state = board()
  const view = buildView(state, agents, { now: NOW, workspace: "w9" })
  const total = { waiting: view.waiting.length, doing: view.doing.length, todo: view.todo.length }
  for (let width = 40; width <= 200; width += 5) {
    for (const height of [15, 20, 23, 24, 30, 40, 60]) {
      for (const scroll of [{}, { selected: "todo" }, { doneOpen: true }, { selected: "waiting", open: true }]) {
        for (const color of [false, true]) {
          const d = draw(state, { width, height, color, emoji: color, scroll: { selected: "waiting", anchors: {}, ...scroll } })
          const lines = d.text.split("\n")
          const size = `${width}x${height} ${d.layout} ${JSON.stringify(scroll)}${color ? " colour" : ""}`
          assert.equal(lines.length, height, `${size}: ${height} lines`)
          for (const l of lines) assert.ok(textWidth(plain(l)) <= width, `${size}: wider than ${width}: ${plain(l)}`)
          if (!scroll.doneOpen) assert.ok(lines.some((l) => plain(l).includes("DONE · 2 today ▸")), `${size}: Done's folded line`)
          if (color) continue
          // Each section: the cards on screen plus "↑ N above" and "↓ N more" are all of them.
          for (const s of ["waiting", "doing", "todo"]) {
            const r = d.regions[s]
            if (!r) continue
            const region = lines.slice(r.top - 1, r.bottom).map((l) => l.slice(0, r.right))
            const shown = new Set(d.cardHits.filter((c) => c.y >= r.top && c.y <= r.bottom && c.x0 >= r.left && c.x0 <= r.right).map((c) => c.key)).size
            const above = Number(/↑ (\d+) above/.exec(region.join("\n"))?.[1] ?? 0)
            const below = Number(/↓ (\d+) more/.exec(region.join("\n"))?.[1] ?? 0)
            assert.equal(shown + above + below, total[s], `${size}: ${s} counts ${shown}+${above}+${below} of ${total[s]}`)
          }
        }
      }
    }
  }
})

test("rows: id, glyph, the title cut with …, the status and the age; the id and the age never cut, at every width", () => {
  const state = board()
  for (const width of [40, 50, 60, 70, 95, 119]) {
    const d = draw(state, { width, height: 60 })
    const rows = plain(d.text)
      .split("\n")
      .filter((l) => /^[▸ ] *\d{3} [! ] /.test(l))
    assert.ok(rows.length >= 10, `${width}: rows found`)
    for (const row of rows) {
      assert.equal(textWidth(row), width, `${width}: the row runs to the right edge (the age right-aligned): ${row}`)
      assert.match(row, /(?:just now|\d+ min|\d+ h(?: \d+ min)?|\d+ days)$/, `${width}: the age, whole`)
      assert.match(row, /^[▸ ] *\d{3} /, `${width}: the id, whole`)
    }
    // A title too long for its row ends in "…", and the working job keeps its status before the age.
    assert.ok(rows.some((r) => /Telegram bot token leaked.*…/.test(r)), `${width}: a long title is cut with …`)
    if (width >= 60) assert.ok(rows.some((r) => / working \[=   \] {2}\d+ min$/.test(r)), `${width}: Doing shows its agent's state (and its bar)`)
  }
  assert.equal(formatAge(26 * 3600_000), "26 h")
})

test("the inbox: the selected card open under its row (description, question, buttons); the others one row each; Space closes it", () => {
  const state = board()
  let d = draw(state)
  const text = plain(d.text)
  assert.match(text, /^Job board · 4 need you +\d\d:\d\d$/m, "the headline count")
  assert.match(text, /^▸ WAITING ON YOU \(4\) ─+$/m, "the selected section, its count and a rule")
  assert.match(text, /^▸181 ! UI consistency plan: answer 10 questions +1 h$\n {7}Card 0: a long/m)
  assert.match(text, /^ {7}Question: Accept all suggested answers, or go through them\?$\n {7}\[ Accept all ✓ ✓ \] {2}\[ Go through \] {2}\[ Other… \]$/m)
  assert.match(text, /^ 182 ! 粵語標題：今日要做嘅嘢，記得覆客 \(Cantonese title\) +21 h$/m, "the next card: one row")
  assert.equal(d.buttons.filter((b) => b.key !== "#181").length, 0, "only the open card's buttons are on screen")
  // ↓ opens the next card and closes this one.
  d = draw(state, { scroll: handleInput(d.scroll, key("down"), d).scroll })
  assert.match(plain(d.text), /^ 181 ! UI consistency plan/m)
  assert.match(plain(d.text), /^▸182 ! 粵語標題/m)
  assert.ok(d.buttons.some((b) => b.key === "#182"))
  // Space closes it (and opens it again); ← → then move between sections, as on a row with no buttons.
  const closed = draw(state, { scroll: handleInput(d.scroll, key("peek"), d).scroll })
  assert.equal(closed.open, false)
  assert.equal(closed.buttons.length, 0)
  assert.equal(handleInput(closed.scroll, key("right"), closed).scroll.selected, "doing")
  assert.equal(draw(state, { scroll: handleInput(closed.scroll, key("peek"), closed).scroll }).open, true)
})

test("compact: rows only, no blank lines; Space peeks at the selected card; ← → on a closed row move between sections", () => {
  const state = board()
  let d = draw(state, { width: 60, height: 30 })
  assert.equal(d.layout, "compact")
  const lines = plain(d.text).split("\n")
  assert.match(lines[0], /^4 need you +\d\d:\d\d$|^Job board · 4 need you/)
  assert.match(lines[1], /^▸ WAITING ON YOU \(4\) ─+$/, "no blank line after the title")
  assert.ok(!lines.slice(1, lines.indexOf("DONE · 2 today ▸")).includes(""), "no blank line between sections")
  assert.equal(d.buttons.length, 0, "no card open")
  assert.match(lines.at(-1), /^Tab · ↑↓ · Space peek · Enter/)
  assert.equal(handleInput(d.scroll, key("right"), d).scroll.selected, "doing", "→ moves on: the row's buttons aren't on screen")
  d = draw(state, { width: 60, height: 30, scroll: handleInput(d.scroll, key("peek"), d).scroll })
  assert.equal(d.open, true)
  assert.ok(d.buttons.some((b) => b.key === "#181"), "Space: its buttons")
  const chose = handleInput(d.scroll, key("right"), d).scroll
  assert.deepEqual([chose.selected, chose.button], ["waiting", 0], "→ chooses its suggested button")
})

test("empty sections fold to one line that says so; the wide layout folds an empty Doing over the columns", () => {
  const state = board({ waiting: 0, doing: 0, todo: 2, done: 0 })
  const inbox = plain(draw(state, { agents: [] }).text)
  assert.match(inbox, /^▸ WAITING ON YOU \(0\) {2}Nothing needs you ─+$/m)
  assert.match(inbox, /^DOING \(0\) · nothing running ─+$/m)
  assert.match(inbox, /^DONE · 0 today ▸$/m)
  assert.doesNotMatch(inbox, /^nothing$/m)
  const open = plain(draw(state, { agents: [], scroll: { doneOpen: true } }).text)
  assert.match(open, /^DONE \(0\) ▾ · nothing finished today ─+$/m)
  const empty = plain(draw(board({ waiting: 1, doing: 1, todo: 0, done: 0 })).text)
  assert.match(empty, /^TO DO \(0\) · nothing to do ─+$/m)
  const wide = plain(draw(state, { agents: [], width: 140 }).text).split("\n")
  const doing = wide.indexOf("DOING (0) · nothing running")
  assert.ok(doing > 0, "folded")
  assert.match(wide[doing + 2], /^TO DO \(2\)$/, "To do has the whole width")
})

test("emoji and CJK: widths by East Asian Width, variation selectors and joiners dropped, so every line has the width the board counts", () => {
  assert.equal(textWidth("粵語標題"), 8)
  assert.equal(textWidth("ｶﾀｶﾅ"), 4, "half-width kana: one cell each")
  assert.equal(textWidth("全形ＡＢＣ"), 10)
  assert.equal(textWidth("✅⭐⚡"), 6, "BMP emoji with emoji presentation: two cells")
  assert.equal(textWidth("❤"), 1, "text-presentation symbol: one cell")
  assert.equal(textWidth("❤️"), 1, "and its variation selector none (it is not drawn)")
  assert.equal(textWidth("é"), 1, "a combining mark takes none")
  assert.equal(textWidth("한국어"), 6)
  assert.equal(textWidth("🫩"), 2, "an emoji newer than the Unicode 15.0 table (16.0): two cells, as in Herdr")
  // Cutting never splits a wide character or leaves a line a cell too wide.
  for (const width of [5, 6, 7, 8, 9]) for (const line of wrap("粵語標題：今日要做嘅嘢 🚀🚀 記得", width, 9)) assert.ok(textWidth(line) <= width, `${width}: ${line}`)
  // What the pane writes for an emoji title has no U+FE0F or U+200D, and the row is exactly the pane's width.
  const d = draw(board(), { width: 80, height: 40, scroll: { selected: "todo", anchors: {} } })
  assert.doesNotMatch(d.text, /[\ufe0f\ufe0e\u200d]/u)
  const row = plain(d.text)
    .split("\n")
    .find((l) => l.includes("Launch"))
  assert.match(row, /🚀 Launch ✅ checklist ❤ with emoji 👨👩👧 in it/)
  assert.equal(textWidth(row), 80)
  // Skin tones and flags, which terminals draw at different widths, are drawn the one way all agree on.
  const odd = { version: 1, next_id: 3, items: [{ id: 1, title: "Thumbs 👍🏽 up", column: "todo", since: NOW.toISOString() }, { id: 2, title: "Flags 🇭🇰🇬🇧", column: "todo", since: NOW.toISOString() }], panes: {} }
  const shown = plain(draw(odd, { width: 70, height: 30 }).text)
  assert.match(shown, /Thumbs 👍 up/)
  assert.match(shown, /Flags HKGB/)
  for (const l of shown.split("\n").filter((l) => /Thumbs|Flags/.test(l))) assert.equal(textWidth(l), 70)
})

test("section emoji: one code point each, two cells, no variation selector or joiner; on only when asked, in a UTF-8 locale", () => {
  for (const [section, e] of Object.entries(SECTION_EMOJI)) {
    assert.equal([...e].length, 1, `${section}: one code point`)
    assert.equal(textWidth(e), 2, `${section}: two cells`)
    assert.doesNotMatch(e, /[\ufe0f\u200d]/u)
  }
  assert.equal(emojiOn({ LANG: "en_US.UTF-8" }), true)
  assert.equal(emojiOn({ LC_ALL: "C", LANG: "en_US.UTF-8" }), false, "LC_ALL wins")
  assert.equal(emojiOn({ LANG: "C" }), false)
  assert.equal(emojiOn({}), false)
  assert.equal(emojiOn({ LANG: "en_US.UTF-8", TERM: "dumb" }), false)
  for (const v of ["0", "off", "false", "no"]) assert.equal(emojiOn({ LANG: "en_US.UTF-8", BOARD_EMOJI: v }), false, v)
  assert.equal(emojiOn({ LANG: "C", BOARD_EMOJI: "1" }), true)
  const on = plain(draw(board(), { emoji: true }).text)
  assert.match(on, /^▸ 🔔 WAITING ON YOU \(4\) ─+$/m)
  assert.match(on, /^📋 TO DO \(8\) ─+$/m)
  assert.match(on, /^🏁 DONE · 2 today ▸$/m)
  assert.doesNotMatch(plain(draw(board()).text), /[🔔🔨📋🏁]/u, "off by default")
})

test("colour is never the only signal: without it the selection, urgency, state and folds still read", () => {
  const state = board()
  const off = draw(state, { color: false })
  assert.doesNotMatch(off.text, /\x1b\[/, "no colour: no escape sequence")
  const text = off.text
  assert.match(text, /^▸ WAITING ON YOU/m, "the selected section: ▸")
  assert.match(text, /^▸181 /m, "the selected card: ▸")
  assert.match(text, /^ 182 ! /m, "waiting: !")
  assert.match(text, / working \[=   \] {2}\d+ min$/m, "the agent's state in words")
  assert.match(text, /\[ Accept all ✓ ✓ \]/, "buttons keep their brackets")
  const on = draw(state, { color: true }).text
  assert.ok(on.includes("\x1b[1;7m181\x1b[0m"), "colour adds reverse video to the selected id")
  assert.ok(on.includes("\x1b[1;33m4 need you\x1b[0m"), "the headline count in Waiting's amber")
  assert.match(on, /\x1b\[33m─+\x1b\[0m/, "Waiting's rule in its colour")
  assert.ok(![...on.matchAll(/\x1b\[([0-9;]*)m/g)].some((m) => /38;|48;/.test(m[1])), "16 colours only")
})

test("live resize: the same board re-laid out at each new size, the selection and the open card kept", () => {
  const state = board()
  let d = draw(state, { width: 160, height: 50 })
  d = draw(state, { width: 160, height: 50, scroll: handleInput(d.scroll, key("down"), d).scroll })
  const card = d.scroll.card
  for (const [width, height] of [[95, 40], [60, 30], [200, 60], [120, 40], [70, 24], [95, 40]]) {
    d = draw(state, { width, height, scroll: d.scroll })
    assert.equal(d.scroll.card, card, `${width}x${height}: same card selected`)
    const lines = d.text.split("\n")
    assert.equal(lines.length, height)
    assert.ok(lines.every((l) => textWidth(plain(l)) <= width))
    assert.ok(d.cardHits.some((c) => c.key === card), `${width}x${height}: still in view`)
    if (d.layout === "inbox") assert.equal(d.open, true, `${width}x${height}: still open`)
  }
})
