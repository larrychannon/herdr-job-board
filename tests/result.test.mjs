// Run: node --test (from the repo root)
// A card's result (0.19.0): `result <ref> "<text>" | --file <path> | - | --clear` keeps an answer,
// a draft or figures with the card, as written (indentation and the spaces between figures kept).
// The pane shows its first lines on the card and all of it in the details; ls, get and the select
// layout (m) show it whole; c copies it first (OSC 52), then the card's links, then its text.
// `get <ref> [--json]` prints one card whole. Secrets are refused from a file and stdin too.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, cleanResult, copyPayload, copyTargets, detailLines, findCards, readBoard, render, RESULT_MAX, resultLines, wordingFailures } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = join(ROOT, "board-pane.mjs")
const T0 = "2026-11-08T10:00:00Z"

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-result-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: T0, TZ: "UTC", NO_COLOR: "1", JOB_AGENT_ROLE: "" }
  const run = (args, input) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8", input })
  const ok = (...args) => {
    const r = run(args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const pane = (args = [], keys = "") => spawnSync(process.execPath, [PANE, "--once", "--width", "100", "--height", "60", ...args, "--keys", keys], { cwd: base, env, encoding: "utf8" })
  const file = join(state, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  return { base, run, ok, pane, file, item, done: () => rmSync(base, { recursive: true, force: true }) }
}

const decode52 = (text) => [...text.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8"))
const FIGURES = "City        Clients   Active\nTaipei          412      380\nHong Kong       1207     1150\n\nSource: the October export."

function seedCard(t) {
  t.ok("add", "waiting", "Client figures: check them", "--desc", "The client counts per city for October.\nNow: figures ready, waiting for your OK", "--ask", "Do the figures look right?", "--option", "Accept the figures", "--option", "Recount the clients", "--suggest", "Accept the figures")
}

test("cleanResult keeps indentation and the spaces between figures; tabs, line ends, controls and blank runs are tidied", () => {
  assert.equal(cleanResult(FIGURES), FIGURES)
  assert.equal(cleanResult("\n\n  a\tb\r\nc   \n\n\n\nd e​\x1b[2J\n\n"), "  a     b\nc\n\nd\ne[2J")
  // A literal backslash-n stays: it can be code.
  assert.equal(cleanResult('printf "a\\n"'), 'printf "a\\n"')
  assert.equal(cleanResult(42), "42")
  assert.equal(cleanResult({}), "(not text)")
})

test("result: set from an argument, a file or stdin, kept as written; set again replaces it; --clear removes it", () => {
  const t = setup()
  try {
    seedCard(t)
    // An argument: a literal \n is a line break, as in --desc.
    assert.equal(t.ok("result", "1", "Yes: 412 in Taipei.\\nAnd 1207 in Hong Kong.").trim(), "1 result: 2 lines (board.mjs get 1 shows it)")
    assert.equal(t.item(1).result, "Yes: 412 in Taipei.\nAnd 1207 in Hong Kong.")
    assert.equal(t.item(1).result_at, "2026-11-08T10:00:00.000Z")
    // A file, as it is (numbers and code are fine: no wording refusal).
    const path = join(t.base, "figures.txt")
    writeFileSync(path, `${FIGURES}\n\t! node count.mjs --month 10\n`)
    t.ok("result", "1", "--file", path)
    assert.equal(t.item(1).result, `${FIGURES}\n        ! node count.mjs --month 10`)
    // stdin.
    const r = t.run(["result", "1", "-"], "line one\n  line two\n")
    assert.equal(r.status, 0, r.stderr)
    assert.equal(t.item(1).result, "line one\n  line two")
    // The rest of the card is untouched.
    assert.equal(t.item(1).desc, "The client counts per city for October.")
    assert.equal(t.item(1).now.text, "figures ready, waiting for your OK")
    assert.equal(t.ok("result", "1", "--clear").trim(), "1 result cleared")
    assert.equal(t.item(1).result, undefined)
    assert.equal(t.item(1).result_at, undefined)
    // json carries it as `result`, a string, while it is set.
    t.ok("result", "1", "kept")
    assert.equal(JSON.parse(t.ok("json")).items[0].result, "kept")
  } finally {
    t.done()
  }
})

test("result: usage, empty text, size, a missing file and secrets (argument, file, stdin) are refused and write nothing", () => {
  const t = setup()
  try {
    seedCard(t)
    const before = readFileSync(t.file, "utf8")
    const refused = (args, input, pattern) => {
      const r = t.run(args, input)
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, pattern)
    }
    refused(["result", "1"], undefined, /usage: board\.mjs result/)
    refused(["result", "1", "text", "--clear"], undefined, /usage: board\.mjs result/)
    refused(["result", "1", "text", "--file", "x"], undefined, /usage: board\.mjs result/)
    refused(["result", "1", "  \n  "], undefined, /a result needs text/)
    refused(["result", "1", "x".repeat(RESULT_MAX + 1)], undefined, new RegExp(`a card keeps ${RESULT_MAX}`))
    refused(["result", "1", "--file", join(t.base, "nope.txt")], undefined, /no such file/)
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`
    refused(["result", "1", `the token is ${token}`], undefined, /the result holds what looks like a GitHub token/)
    const secret = join(t.base, "secret.txt")
    writeFileSync(secret, `deploy with ${token}\n`)
    refused(["result", "1", "--file", secret], undefined, /the result holds what looks like a GitHub token/)
    refused(["result", "1", "-"], `deploy with ${token}\n`, /the result holds what looks like a GitHub token/)
    assert.equal(readFileSync(t.file, "utf8"), before, "nothing written")
  } finally {
    t.done()
  }
})

test("get: one card whole as text, --json as stored; an archived Done card by its number; an unknown one fails", () => {
  const t = setup()
  try {
    seedCard(t)
    const path = join(t.base, "figures.txt")
    writeFileSync(path, FIGURES)
    t.ok("result", "1", "--file", path)
    const text = t.ok("get", "1")
    const [head, ...body] = text.trimEnd().split("\n")
    assert.match(head, /^card 1 · waiting on you · project board-result-\w+ \(\w+\)$/)
    assert.equal(
      body.join("\n"),
      [
        "Title: Client figures: check them",
        "Now: figures ready, waiting for your OK",
        "Question: Do the figures look right?",
        "Buttons: Accept the figures (suggested) · Recount the clients",
        "",
        "Description:",
        "The client counts per city for October.",
        "",
        "Result (written 10:00):",
        FIGURES,
      ].join("\n"),
    )
    const json = JSON.parse(t.ok("get", "1", "--json"))
    assert.equal(json.id, 1)
    assert.equal(json.result, FIGURES)
    assert.deepEqual(json, JSON.parse(t.ok("json")).items[0], "the card as json's items show it")
    const missing = t.run(["get", "99"])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no item 99 on the board/)
    assert.equal(t.run(["get"]).status, 2)
  } finally {
    t.done()
  }
})

test("get: a card in the archive is found by its number", () => {
  const t = setup()
  try {
    const archive = join(t.base, ".git", "board-state", "archive")
    t.ok("add", "todo", "Placeholder card: keep the store", "--desc", "So the store exists.")
    spawnSync("mkdir", ["-p", archive])
    writeFileSync(join(archive, "2026-10.jsonl"), `${JSON.stringify({ id: 40, project: "x", title: "Old report: read it", desc: "Done long ago.", column: "done", result: "42 clients", since: "2026-10-01T10:00:00Z" })}\n`)
    const text = t.ok("get", "40")
    assert.match(text, /^card 40 · done \(archived\) · project x\nTitle: Old report: read it\n/)
    assert.match(text, /\nResult:\n42 clients\n/)
  } finally {
    t.done()
  }
})

test("the pane: a card shows the result's first lines and how many more; the details show it whole; ls whole", () => {
  const t = setup()
  try {
    seedCard(t)
    const long = Array.from({ length: 14 }, (_, i) => `  row ${i + 1}`).join("\n")
    const r = t.run(["result", "1", "-"], long)
    assert.equal(r.status, 0, r.stderr)
    const frame = t.pane(["--width", "80"]).stdout
    assert.match(frame, /\n {5}Result:\n {7}row 1\n(?: {7}row \d\n){5} {5}\+8 more lines: Enter shows all · c copies it\n {5}Question: Do the figures look right\?/)
    assert.doesNotMatch(frame, /row 7/)
    const details = t.pane(["--width", "80", "--height", "200"], "\r").stdout.split("── card 1")[1]
    assert.match(details, /\n {2}Result\n {2}Written 10:00 · 14 lines · c copies it\n {4}row 1\n/)
    assert.match(details, /\n {4}row 14\n/)
    // In the details, Result comes after What it is and before What you need to do.
    assert.ok(details.indexOf("What it is") < details.indexOf("Result") && details.indexOf("Result") < details.indexOf("What you need to do"))
    const ls = t.ok("ls", "--width", "100")
    assert.match(ls, /row 1\n[\s\S]*row 14\n/)
    // While selecting text (m): the card shows it whole.
    assert.match(t.pane(["--width", "80"], "m").stdout, /row 14/)
  } finally {
    t.done()
  }
})

test("copy: c copies the result exactly first (OSC 52), then each link, then the card as text", () => {
  const t = setup()
  try {
    seedCard(t)
    const path = join(t.base, "figures.txt")
    writeFileSync(path, `${FIGURES}\nSee https://example.com/report for the export.`)
    t.ok("result", "1", "--file", path)
    const stored = t.item(1).result
    let r = t.pane([], "c")
    assert.deepEqual(decode52(r.stdout), [stored], "the stored text, not the drawn lines")
    assert.match(r.stdout, /copied 1\/3: the result, 6 lines · /)
    r = t.pane([], "ccc")
    const [, link, card] = decode52(r.stdout)
    assert.equal(link, "https://example.com/report")
    assert.match(card, /^#1 Client figures: check them\n\nNow: figures ready, waiting for your OK\n\nThe client counts per city for October\.\n\nResult:\nCity {8}Clients/)
    assert.match(card, /\n\n→ Do the figures look right\?\n\nbuttons: Accept the figures · Recount the clients$/)
    // In the details too.
    assert.deepEqual(decode52(t.pane([], "\rc").stdout), [stored])
    // Without a result: as before (links, then text).
    assert.deepEqual(copyTargets({ id: 2, title: "Plain card: read it" }).map((x) => x.what), ["card"])
    assert.equal(copyPayload({ id: 2, title: "a", result: "  42" }).text, "  42")
  } finally {
    t.done()
  }
})

test("resultLines: code lines are broken at the width, prose is word-wrapped, and max cuts with a count", () => {
  const segs = (r) => r.lines.map((l) => l.map((s) => s.t).join(""))
  assert.deepEqual(segs(resultLines("  abcdefghij", 6)), ["  abcd", "efghij"])
  assert.deepEqual(segs(resultLines("one two three four", 9)), ["one two", "three", "four"])
  assert.deepEqual(segs(resultLines("a\n\nb", 10)), ["a", "", "b"])
  const cut = resultLines("1\n2\n3\n4", 10, new Set(), 2)
  assert.deepEqual(segs(cut), ["1", "2"])
  assert.equal(cut.more, 2)
  // A link whole in the result is a link segment.
  const url = "https://example.com/x"
  assert.ok(resultLines(`see ${url}`, 40, new Set([url])).lines[0].some((s) => s.link === url))
})

test("lint and find: a result's long prose line and temp path warn (never its numbers or code); find searches it", () => {
  const item = { id: 5, column: "waiting", title: "Figures: check", desc: "The counts.", result: `${"word ".repeat(60)}\n  ${"code ".repeat(60)}\nPR 12 and build 3456 are fine here\nSaved in /tmp/figures.csv` }
  const [failing] = wordingFailures([item])
  const lines = failing.problems.filter((p) => p.field === "result")
  assert.equal(lines.length, 2, JSON.stringify(lines))
  assert.match(lines[0].why, /a line over three lines long/)
  assert.match(lines[1].why, /temporary folder/)
  assert.ok(failing.problems.every((p) => p.level === "warn"))
  const [hit] = findCards([item], ["build", "3456"])
  assert.equal(hit.field, "result")
  assert.match(hit.line, /build 3456/)
})

test("buildView and render keep the result; detailLines leaves it out when there is none", () => {
  const state = { version: 2, next_id: 3, items: [{ id: 1, project: "p", title: "With result: read", column: "waiting", desc: "", result: "42", updated: T0, since: T0 }, { id: 2, project: "p", title: "Without: read", column: "waiting", desc: "x", updated: T0, since: T0 }], projects: { p: { tag: "p" } } }
  const view = buildView(state, null, { now: new Date(T0) })
  const text = render(view, { width: 100, now: new Date(T0) })
  assert.match(text, /Result:\n\s+42/)
  const flat = (e) => detailLines(e, 80, { now: new Date(T0) }).lines.map((l) => l.map((s) => s.t ?? "").join("")).join("\n")
  assert.match(flat(view.waiting.find((e) => e.id === 1)), /\n {2}Result\n {2}1 line · c copies it\n {2}42/)
  assert.doesNotMatch(flat(view.waiting.find((e) => e.id === 2)), /Result/)
})
