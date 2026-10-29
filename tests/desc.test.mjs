// Run: node --test (from the repo root)
// A card's description in parts (0.9.0): paragraphs, "- " / "• " items and "Why:" labels kept in
// the details panel and in `ls`; a card or row in the pane shows its first paragraph, cut with "…".
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, cleanDesc, copyPayload, descLines, descParts, descPreview, detailLines, readBoard, renderBoard } from "../board.mjs"

const BOARD = join(fileURLToPath(new URL("../", import.meta.url)), "board.mjs")
const NOW = "2026-10-23T10:00:00.000Z"

// Card 304 as the coordinator now writes a card: what it is, why, what changes, risk, the answers.
const CARD_304 = `First checks that Claude Code accepts a home-made channel plugin, then builds a small Go plugin so job messages and your button answers arrive as their own channel instead of being typed into the chat.

Why: today a job's stop needs a Node watcher the coordinator keeps alive (~107 MB), and a button press is typed into the coordinator's input box.

What changes:
- a Go channel plugin pushes each inbox message into the coordinator's session
- a button answer goes through the same channel
• card details keep paragraphs and lists

Risk: channels are a research preview.

Your answers:
- Merge: I merge both PRs and install the board
- Not now: the PRs stay open`

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-desc-")))
  const env = { ...process.env, HOME: base, JOB_BOARD_FILE: "", JOB_BOARD_HOME: join(base, "store"), JOB_BOARD_NOW: NOW, TZ: "UTC", NO_COLOR: "1" }
  delete env.HERDR_ENV
  const board = (...args) => {
    const r = spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const file = join(base, "store", "board.json")
  return { base, file, board, done: () => rmSync(base, { recursive: true, force: true }) }
}

const plain = (lines) => lines.map((l) => l.map((s) => s.t).join("").trimEnd())

test("cleanDesc: lines kept, a blank line between paragraphs, \\n as a line break, controls gone", () => {
  assert.equal(cleanDesc("One.\n\n\n\nTwo\r\n  - a   b  \n\n"), "One.\n\nTwo\n- a b")
  assert.equal(cleanDesc("One.\\n\\nTwo\\n- x"), "One.\n\nTwo\n- x")
  assert.equal(cleanDesc("\n\nA\u0007B​\tC"), "AB C")
  assert.equal(cleanDesc(""), "")
  assert.equal(cleanDesc(undefined), "")
  // A description from before 0.9.0 (one line) is unchanged.
  assert.equal(cleanDesc("Just one paragraph, as before."), "Just one paragraph, as before.")
})

test("descParts and descPreview: lines, items, gaps; the first paragraph with 'more'", () => {
  const parts = descParts(CARD_304)
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["line", "gap", "line", "gap", "line", "item", "item", "item", "gap", "line", "gap", "line", "item", "item"],
  )
  assert.equal(parts[5].text, "a Go channel plugin pushes each inbox message into the coordinator's session")
  assert.equal(parts[7].text, "card details keep paragraphs and lists")
  assert.deepEqual(descPreview(CARD_304), { text: CARD_304.split("\n")[0], more: true })
  assert.deepEqual(descPreview("A\nB\n- c"), { text: "A B", more: true })
  assert.deepEqual(descPreview("Only this."), { text: "Only this.", more: false })
  assert.deepEqual(descPreview("- a list first\n- b"), { text: "- a list first", more: true })
})

test("descLines: paragraphs wrapped, items with a hanging indent, labels as headings", () => {
  const lines = descLines(CARD_304, 60)
  const text = plain(lines)
  assert.equal(text[0], "First checks that Claude Code accepts a home-made channel")
  assert.ok(text.includes(""), "a blank line between paragraphs")
  const items = text.filter((t) => t.startsWith("• "))
  assert.equal(items.length, 5)
  assert.ok(text.includes("  inbox message into the coordinator's session") || text.some((t) => /^ {2}\S/.test(t)), "an item's next line hangs under its text")
  // The labels: their own segment in the heading style.
  const labels = lines.flat().filter((s) => s.s === "head").map((s) => s.t)
  assert.deepEqual(labels, ["Why:", "What changes:", "Risk:", "Your answers:", "Merge:", "Not now:"])
  // Not a label: a lower-case start, a URL, more than four words.
  assert.deepEqual(descLines("see https://x.y/z: here\nthis is not: a label\nOne two three four five: no", 80).flat().filter((s) => s.s === "head"), [])
  for (const t of text) assert.ok(t.length <= 60, t)
})

test("add and edit: real newlines and \\n stay; the details panel shows the parts", () => {
  const s = setup()
  try {
    s.board("add", "waiting", "Card 304: build", "--desc", CARD_304, "--ask", "Merge?", "--option", "Merge", "--option", "Not now", "--allow-wording")
    s.board("add", "todo", "One-liner", "--desc", "Para one.\\n\\nPara two\\n- an item")
    const [a, b] = readBoard(s.file).items
    assert.equal(a.desc, cleanDesc(CARD_304))
    assert.equal(b.desc, "Para one.\n\nPara two\n- an item")
    s.board("edit", String(b.id), "--desc", "New.\n\nSecond.")
    assert.equal(readBoard(s.file).items[1].desc, "New.\n\nSecond.")
    const panel = plain(detailLines(a, 72).lines)
    const at = panel.indexOf("  What it is")
    assert.ok(at > 0)
    assert.deepEqual(panel.slice(at + 1, at + 4), ["  First checks that Claude Code accepts a home-made channel plugin, then", "  builds a small Go plugin so job messages and your button answers", "  arrive as their own channel instead of being typed into the chat."])
    assert.ok(panel.includes("  What changes:"))
    assert.ok(panel.includes("  • a button answer goes through the same channel"))
    assert.ok(panel.includes("  • Merge: I merge both PRs and install the board"))
    // A paragraph break is an empty line, not one with an indent only.
    assert.ok(panel.slice(at, panel.indexOf("  What you need to do")).includes(""))
    // Copying the card keeps its lines.
    assert.match(copyPayload(a).text, /\n\nWhy: today/)
  } finally {
    s.done()
  }
})

test("ls: a Waiting card's description in full with its parts; other cards and rows the first paragraph, cut with …", () => {
  const s = setup()
  try {
    s.board("add", "waiting", "Card 304: build", "--desc", CARD_304, "--ask", "Merge?", "--option", "Merge", "--option", "Not now", "--allow-wording")
    s.board("add", "doing", "A doing card", "--desc", CARD_304)
    s.board("add", "todo", "Short", "--desc", "Para one.\n\nPara two")
    for (const width of [100, 150]) {
      const out = s.board("ls", "--width", String(width))
      assert.match(out, /^ *What changes:$/m, `width ${width}`)
      assert.match(out, /^ *• a Go channel plugin pushes each inbox message/m)
      assert.match(out, /^ *• Not now: the PRs stay open$/m)
      assert.match(out, /^ *Risk: channels are a research preview\.$/m)
      // The Doing card: its first paragraph only.
      const doing = out.slice(out.indexOf("A doing card"))
      assert.doesNotMatch(doing.split("\n").slice(0, 4).join("\n"), /Why:/)
    }
    // The pane's rows (inbox layout, nothing selected): no Why: anywhere, the first paragraph cut.
    const state = readBoard(s.file)
    const view = buildView(state, [], { now: new Date(NOW) })
    const screen = renderBoard(view, { width: 90, height: 40, color: false, now: new Date(NOW), interactive: true, layout: "inbox" }).text
    assert.doesNotMatch(screen, /Why:|What changes:/)
    const wide = renderBoard(view, { width: 160, height: 50, color: false, now: new Date(NOW), interactive: true, layout: "wide" }).text
    assert.doesNotMatch(wide, /Why:|What changes:/)
    assert.match(wide, /Para one\. …/)
  } finally {
    s.done()
  }
})

test("a description from before 0.9.0 (one long line) shows as it did: wrapped, three lines on a card", () => {
  const long = "word ".repeat(80).trim()
  const lines = plain(descLines(long, 40))
  assert.ok(lines.length > 3 && lines.every((l) => l.length <= 40 && l))
  assert.deepEqual(descPreview(long), { text: long, more: false })
  assert.match(readFileSync(BOARD, "utf8"), /desc: cleanDesc\(opts\.desc\)/)
})
