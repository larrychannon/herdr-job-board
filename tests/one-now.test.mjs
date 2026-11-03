// Run: node --test (from the repo root)
// One Now line per card (0.17.0): a "Now:" line given in --desc (add, edit, move, job-start) is
// the card's status line, stored as its `now` and taken out of the description, so a card shows
// exactly one Now. A new question is explained by that line or by a status line that is current.
// A card from before (a Now line still in its stored description) shows it as its status line
// and keeps it in its description until a --desc rewrites it; one with both is left for lint
// to point out. (What keeps a person's Now line from being lost: now-kept.test.mjs.) Wrapped lines
// of numbered steps, "-> " lines and "Label: …" lines hang under their text.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, copyPayload, descLines, readBoard } from "../board.mjs"

const BOARD = join(fileURLToPath(new URL("../", import.meta.url)), "board.mjs")
const T = "2026-11-02T10:00:00Z"
const LATER = "2026-11-02T11:00:00Z"

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-one-now-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = (now) => {
    const e = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" }
    delete e.JOB_AGENT_ROLE
    return e
  }
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
  const ok = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(state, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  const raw = () => JSON.parse(readFileSync(file, "utf8"))
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex")
  /** A board file written by hand, as an older board left it. */
  const write = (items) => {
    mkdirSync(state, { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 2, next_id: items.length + 1, projects: {}, coordinators: {}, items, panes: {}, reports: {}, imports: [] }))
  }
  return { base, file, run, ok, item, raw, hash, write, done: () => rmSync(base, { recursive: true, force: true }) }
}

const plain = (lines) => lines.map((l) => l.map((s) => s.t).join("").trimEnd())

// --- a Now line in --desc is the status line -------------------------------------------------------

test("add, edit and move: a 'Now:' line in --desc becomes the card's status line, out of the description", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops after sign-in.\nNow: nothing started yet.")
    assert.equal(t.item(1).desc, "It loops after sign-in.")
    assert.equal(t.item(1).now.text, "nothing started yet.")
    assert.equal(t.item(1).now.at, new Date(T).toISOString())

    // edit: the new line replaces the old one; markdown around the label is not kept.
    t.ok(LATER, "edit", "1", "--ask", "Fix it before the release?", "--desc", "It loops after sign-in.\n\n**Now:** the fix is ready; yes ships it with the release.\n\nWhy: users can't sign in.")
    assert.equal(t.item(1).desc, "It loops after sign-in.\n\nWhy: users can't sign in.")
    assert.equal(t.item(1).now.text, "the fix is ready; yes ships it with the release.")
    assert.equal(t.item(1).now.at, new Date(LATER).toISOString())
    // A literal \n (a shell's one-line --desc) is a line break there too; a "Now:" mid-line stays.
    t.ok(LATER, "edit", "1", "--desc", "It loops. Now: it is still there.\\nNow: the fix is merged.")
    assert.equal(t.item(1).desc, "It loops. Now: it is still there.")
    assert.equal(t.item(1).now.text, "the fix is merged.")
    // A --desc without a Now line ends the line the earlier --desc gave (round three): it stays
    // at the end of the description as "Earlier: …", never on top as if current.
    t.ok(LATER, "edit", "1", "--desc", "It loops after sign-in.")
    assert.equal(t.item(1).now, undefined)
    assert.equal(t.item(1).desc, "It loops after sign-in.\nEarlier: the fix is merged.")

    // move … waiting with --desc: the same.
    t.ok(T, "add", "todo", "Docs: tidy the old pages", "--desc", "Old pages.")
    t.ok(LATER, "move", "2", "waiting", "--desc", "Old pages.\n- Now: nothing started; yes starts a job.", "--ask", "Tidy the docs now?", "--option", "Tidy the docs", "--option", "Leave them as they are", "--suggest", "Tidy the docs")
    assert.equal(t.item(2).desc, "Old pages.")
    assert.equal(t.item(2).now.text, "nothing started; yes starts a job.")

    // The card shows exactly one Now, at its top.
    const out = t.ok(LATER, "ls", "--width", "100").stdout
    const card = out.slice(out.indexOf("Docs: tidy the old pages"))
    assert.equal(card.match(/Now:/g).length, 1, card)
  } finally {
    t.done()
  }
})

test("a Now line from --desc is this card's line only, not the cards above or under it", () => {
  const t = setup()
  try {
    t.ok(T, "add", "doing", "Login fix: release", "--desc", "Ship the login fix.")
    t.ok(T, "add", "doing", "Login fix: check", "--parent", "1", "--job", "login-check", "--desc", "A fresh check.")
    t.ok(T, "now", "1", "both cards are in progress")
    t.ok(LATER, "edit", "2", "--desc", "A fresh check.\nNow: the check passed.")
    assert.equal(t.item(2).now.text, "the check passed.")
    assert.equal(t.item(1).now.text, "both cards are in progress")
  } finally {
    t.done()
  }
})

test("the Now line from --desc is checked as the description was: a PR number is refused, nothing written", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops after sign-in.")
    const before = t.hash()
    const r = t.run(T, "edit", "1", "--desc", "It loops after sign-in.\nNow: PR #12 is merged.")
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /the description says "PR #12", a PR number/)
    assert.equal(t.hash(), before)
    // add too.
    assert.equal(t.run(T, "add", "todo", "Docs: tidy", "--desc", "Old pages.\nNow: build 41 is out.").status, 2)
    assert.equal(t.raw().items.length, 1)
  } finally {
    t.done()
  }
})

test("a Now line longer than a status line holds is never cut: it stays in the description, whole, with a warning", () => {
  const t = setup()
  try {
    const long = `the fix is ready ${"and checked again ".repeat(15)}`.trim()
    assert.ok(long.length > 200)
    const r = t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", `It loops.\nNow: ${long}`)
    assert.match(r.stderr, /card 1: its Now line is longer than 200 characters, so it is kept in the description, whole/)
    assert.equal(t.item(1).now, undefined)
    assert.equal(t.item(1).desc, `It loops.\nNow: ${long}`)
  } finally {
    t.done()
  }
})

test("copying a card keeps its one Now: the status line, then the description", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops after sign-in.\nNow: nothing started yet.")
    const [entry] = buildView(readBoard(t.file), [], { now: new Date(T) }).todo
    assert.equal(copyPayload(entry).text, "#1 Login page: fix the redirect\n\nNow: nothing started yet.\n\nIt loops after sign-in.")
  } finally {
    t.done()
  }
})

// --- the question rule takes either form ----------------------------------------------------------

test("a new question is explained by a Now line in --desc or by a current status line; a stale one is refused", () => {
  const t = setup()
  try {
    t.ok(T, "add", "doing", "Login page: fix the redirect", "--desc", "It loops after sign-in.")
    t.ok(T, "now", "1", "the fix is ready; yes ships it with the release")
    // The status line is current: --ask alone is written.
    t.ok(T, "edit", "1", "--ask", "Fix it before the release?")
    assert.equal(t.item(1).ask, "Fix it before the release?")
    // So is a --desc without its own Now line.
    t.ok(T, "edit", "1", "--ask", "Ship the fix today?", "--desc", "It loops after sign-in, on every browser.")
    assert.equal(t.item(1).ask, "Ship the fix today?")

    // A status line out of date (a card under it was done since): refused, nothing written.
    t.ok(T, "add", "doing", "Login fix: release", "--desc", "Ship the login fix.")
    t.ok(T, "add", "doing", "Login fix: check", "--parent", "2", "--desc", "A fresh check.")
    t.ok(T, "now", "2", "the check is running", "--only")
    t.ok(LATER, "done", "3")
    assert.equal(t.item(2).event.kind, "card done")
    const before = t.hash()
    const r = t.run(LATER, "edit", "2", "--ask", "Release the login fix?")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /card 2: a new question needs its explanation in the same call, so nothing was written/)
    assert.match(r.stderr, /line that starts "Now:"/)
    assert.match(r.stderr, /board\.mjs now/)
    assert.equal(t.hash(), before)
    // A card with no status line at all: refused as before.
    t.ok(T, "add", "todo", "Docs: tidy the old pages", "--desc", "Old pages.")
    assert.equal(t.run(T, "edit", "4", "--ask", "Tidy the docs now?").status, 2)
  } finally {
    t.done()
  }
})

// --- cards written before: a Now line still in the description ------------------------------------

const OLD = (extra = {}) => ({
  id: 1,
  project: "p",
  origin: "",
  workspace: "",
  title: "Login page: fix the redirect",
  desc: "It loops after sign-in.\nNow: the fix is ready; yes ships it with the release.",
  column: "waiting",
  job: "",
  ask: "Fix it before the release?",
  options: [
    { label: "Fix it first", suggested: true },
    { label: "Release as is" },
  ],
  created: T,
  since: T,
  updated: T,
  order: 0,
  ...extra,
})

test("a card from before with a Now line in its description and no status line: shown as its status line, moved there only by a --desc", () => {
  const t = setup()
  try {
    t.write([OLD()])
    const out = t.ok(LATER, "ls", "--project", "all", "--width", "100").stdout
    const card = out.slice(out.indexOf("Login page: fix the redirect"))
    assert.equal(card.match(/Now:/g).length, 1, card)
    // The status line at the top of the card, before the description.
    assert.ok(card.indexOf("Now: the fix is ready") < card.indexOf("It loops after sign-in."), card)
    // Reading never writes it.
    assert.match(t.raw().items[0].desc, /Now: the fix is ready/)
    assert.equal(t.raw().items[0].now, undefined)

    // An edit that gives no --desc leaves it in the description (a job-open's line, written
    // next, would otherwise take its place).
    t.ok(LATER, "edit", "1", "--title", "Login page: fix the redirect first", "--project", "p")
    assert.equal(t.item(1).desc, "It loops after sign-in.\nNow: the fix is ready; yes ships it with the release.")
    assert.equal(t.item(1).now, undefined)
    // A --desc moves it.
    t.ok(LATER, "edit", "1", "--desc", t.item(1).desc, "--project", "p")
    assert.equal(t.item(1).desc, "It loops after sign-in.")
    assert.equal(t.item(1).now.text, "the fix is ready; yes ships it with the release.")
    assert.equal(t.item(1).now.at, new Date(LATER).toISOString())
  } finally {
    t.done()
  }
})

test("lint: a description that still has a Now line next to a status line, and a plain line over about three wrapped lines, warn; exit 0", () => {
  const t = setup()
  try {
    const wall = `The account team tops up by hand ${"because the provider has no automatic top-up for this pool ".repeat(4)}`.trim()
    t.write([
      OLD({ now: { text: "the job is closed; its work is in its report", at: T } }),
      OLD({ id: 2, title: "Pool top-ups: agree the flow", desc: `${wall}\n- a short item\n1. ${wall}`, now: { text: "the flow is drafted", at: T } }),
      OLD({ id: 3, title: "Docs: tidy the old pages", desc: "Old pages.", now: { text: "nothing started", at: T } }),
    ])
    const before = t.hash()
    const r = t.run(LATER, "lint")
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /card 1 .*\n {2}warn the description says "Now: the fix is ready; yes ships it with the release\.", a second Now next to its status line/)
    assert.match(r.stdout, /card 2 .*\n {2}warn the description says "The account team tops up by hand[^"]*…", a line over three lines long/)
    // Only the plain line: the numbered item of the same length hangs under its text.
    assert.equal(r.stdout.match(/over three lines long/g).length, 1)
    assert.doesNotMatch(r.stdout, /card 3 /)
    assert.match(r.stdout, /0 of 3 open cards fail the wording check \(2 more with a warning only\)/)
    assert.equal(t.hash(), before, "lint writes nothing")
  } finally {
    t.done()
  }
})

// --- wrapped lines hang under their text ----------------------------------------------------------

test("descLines: numbered steps, '-> ' lines and the text after a 'Label:' hang under their text when they wrap", () => {
  const desc = [
    "Flow:",
    "1. Before go-live: credit and the traffic pool are bought, and the node goes live only after both are confirmed.",
    "12) Warn when the credit or the pool runs low, and ask for a top-up within five working days.",
    "-> the account team tops up by hand, since the provider has no automatic top-up.",
    "Open: can the credit pay for pool packs, or do they need a card payment each time?",
  ].join("\n")
  const text = plain(descLines(desc, 40))
  for (const t of text) assert.ok(t.length <= 40, t)
  const at = (start) => text.findIndex((t) => t.startsWith(start))
  // "1. " hangs by three cells, "12) " by four, "-> " by three.
  let i = at("1. Before go-live")
  assert.ok(i >= 0, text.join("\n"))
  assert.match(text[i + 1], /^ {3}\S/, text.join("\n"))
  i = at("12) Warn")
  assert.match(text[i + 1], /^ {4}\S/, text.join("\n"))
  i = at("-> the account team")
  assert.match(text[i + 1], /^ {3}\S/, text.join("\n"))
  // "Open: …" wraps under the text after its label.
  i = at("Open: can the credit")
  assert.match(text[i + 1], /^ {6}\S/, text.join("\n"))
  // The label is still a heading.
  assert.ok(descLines(desc, 40).flat().some((s) => s.s === "head" && s.t === "Open:"))
  // A label wider than a third of the width hangs by two cells only.
  const narrow = plain(descLines("What it changes: the account team tops up by hand from now on.", 30))
  assert.match(narrow[1], /^ {2}\S/, narrow.join("\n"))
  // Not steps: a year or a number with a decimal point at a line's start.
  const year = plain(descLines("2026. was a long year for the account team and its pools.", 30))
  assert.match(year[1], /^\S/, year.join("\n"))
})

test("the status line hangs under its text when it wraps, on the card and in ls", () => {
  const t = setup()
  try {
    // A Waiting card: ls draws it open.
    t.ok(T, "add", "waiting", "Pool top-ups: agree the flow", "--desc", "Top-ups by hand.\nNow: the flow is drafted; your answer decides whether it becomes the account team's runbook.", "--ask", "Is this top-up flow right?", "--option", "Keep the flow", "--option", "Change the flow", "--suggest", "Keep the flow")
    const out = t.ok(T, "ls", "--width", "72").stdout.split("\n")
    const at = out.findIndex((l) => /^ +Now: the flow is drafted/.test(l))
    assert.ok(at > 0, out.join("\n"))
    const col = out[at].indexOf("Now:")
    // The next line starts under the text after "Now: ", not under "Now:".
    assert.equal(out[at + 1].search(/\S/), col + "Now: ".length, out.join("\n"))
  } finally {
    t.done()
  }
})
