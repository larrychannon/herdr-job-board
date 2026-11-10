// Run: node --test (from the repo root)
// "Came from" links between cards (0.7.0): --parent on add, job-start and edit, --no-parent; the
// child's "for …" line and ↳, the parent shown where its most urgent open part is (0.20.0: no
// "waiting on …" lines, no "ready to resume"), json, old boards, and the coordinator's turn-start
// reminder of cards that look stuck.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildView, detailLines, flagReminder, readBoard, render } from "../board.mjs"
import { handle } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const NOW = "2026-10-13T10:30:00Z"

/** Two repos (app, ops) with one store in a temp dir, a fake Herdr and the CLI. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-parents-")))
  const repo = (name) => {
    const dir = join(root, name)
    mkdirSync(dir)
    spawnSync("git", ["-C", dir, "init", "-q"])
    return dir
  }
  const app = repo("app")
  const ops = repo("ops")
  const herdr = join(root, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ agents: [] }))
  const store = join(root, "store")
  const env = { ...process.env, HERDR_ENV: "0", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HOME: root, JOB_BOARD_NOW: NOW, TZ: "UTC", NO_COLOR: "1" }
  const run = (args, cwd = app, extra = {}) => spawnSync(process.execPath, [BOARD, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" })
  const ok = (args, cwd, extra) => {
    const r = run(args, cwd, extra)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  const view = () => buildView(readBoard(file), null, { now: new Date(NOW) })
  const entry = (id) => {
    const v = view()
    return [...v.waiting, ...v.doing, ...v.todo, ...v.doneToday].find((e) => e.id === id)
  }
  const ids = (section) => view()[section].map((e) => e.id)
  const ls = (width, cwd = app) => ok(["ls", "--width", String(width), "--project", "all"], cwd).stdout
  return { root, app, ops, store, run, ok, file, item, view, entry, ids, ls, done: () => rmSync(root, { recursive: true, force: true }) }
}

/** The chain from the mockup: 1 Node health ← 2 AWS switch ← 3 job guard change (in ops). */
function chain(t) {
  t.ok(["add", "doing", "Node health: review found one real problem — being fixed", "--desc", "The node panel would say a node has no health check."])
  t.ok(["add", "doing", "AI agents' AWS switch: approve the 4 steps", "--parent", "1", "--desc", "The switch is prepared."])
  return t.ok(["add", "doing", "~/work backup: let the coordinator commit and push it — build", "--parent", "2", "--desc", "A per-repo setting in the job guard."], t.ops)
}

test("add --parent links a card: the child is 'for' its parent, every open card under it is its part", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Node health: review found one real problem — being fixed"])
    const two = t.ok(["add", "doing", "AI agents' AWS switch: approve the 4 steps", "--parent", "1"]).stdout
    assert.equal(two.trim(), "added 2 (doing): AI agents' AWS switch: approve the 4 steps · for #1 Node health")
    const three = t.ok(["add", "todo", "Job guard change — build", "--parent", "2"], t.ops).stdout
    assert.match(three, /· for #2 AI agents' AWS switch$/m)
    assert.equal(t.item(2).parent, 1)
    assert.equal(t.item(3).parent, 2)
    assert.equal(t.item(1).parent, undefined)
    // The parent lists grandchildren too, as ids; a child names its direct parent only.
    assert.deepEqual(t.entry(1).waitingOn, [2, 3])
    assert.deepEqual(t.entry(2).waitingOn, [3])
    assert.deepEqual(t.entry(2).parentOf, { id: 1, title: "Node health", tag: "", done: false, deploy: false })
    // A child keeps its own project; its parent's tag shows when the projects differ.
    assert.equal(t.item(3).project, "ops")
    assert.equal(t.entry(3).parentOf.tag, "app")
    // Neither #1 nor #2 has a job of its own, and the only work left under them is To do: both show
    // in To do (0.20.0), #2 under #1 and #3 under #2; their own column stays Doing.
    assert.deepEqual(t.ids("doing"), [])
    assert.deepEqual(t.ids("todo").sort(), [1, 2, 3])
    assert.equal(t.item(1).column, "doing")
  } finally {
    t.done()
  }
})

test("--parent refuses: an unknown card, a Done card, the card itself, a loop, not an id, both --parent and --no-parent", () => {
  const t = setup()
  try {
    chain(t)
    t.ok(["add", "done", "Old"])
    const unknown = t.run(["add", "todo", "x", "--parent", "99"])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /no item 99 on the board/)
    const done = t.run(["add", "todo", "x", "--parent", "4"])
    assert.equal(done.status, 2)
    assert.match(done.stderr, /4 is done: a card can only be made for an open card/)
    const self = t.run(["edit", "2", "--parent", "2"])
    assert.equal(self.status, 2)
    assert.match(self.stderr, /2 can't be for 2: 2 is the card itself/)
    const loop = t.run(["edit", "1", "--parent", "3"])
    assert.equal(loop.status, 2)
    assert.match(loop.stderr, /1 can't be for 3: 3 is already under 1/)
    assert.equal(t.run(["add", "todo", "x", "--parent", "abc"]).status, 2)
    assert.equal(t.run(["edit", "2", "--parent", "1", "--no-parent"]).status, 2)
    assert.equal(t.run(["move", "2", "todo", "--parent", "1"]).status, 2, "move takes no --parent")
    // Nothing changed, and no card was added.
    assert.equal(t.item(1).parent, undefined)
    assert.equal(t.item(2).parent, 1)
    assert.equal(readBoard(t.file).items.length, 4)
  } finally {
    t.done()
  }
})

test("done on the last open card under a parent: nothing is marked; the parent shows in its own column again", () => {
  const t = setup()
  try {
    chain(t)
    t.ok(["add", "doing", "Something else"])
    assert.deepEqual(t.ids("doing"), [4, 3, 2, 1])
    // #3 done: #2 has nothing open under it; #1 still has #2 in Doing.
    const out = t.ok(["done", "3"], t.ops).stdout
    assert.match(out, /^3 → done: /)
    assert.doesNotMatch(out, /ready to resume/)
    assert.equal(t.item(2).ready, undefined)
    assert.deepEqual(t.ids("doing"), [4, 2, 1])
    assert.deepEqual(t.entry(1).waitingOn, [2])
    // #2 done: #1 has no parts left, so it shows in its own column, where it was.
    assert.doesNotMatch(t.ok(["done", "2"]).stdout, /ready to resume/)
    assert.deepEqual(t.ids("doing"), [4, 1])
    assert.equal(t.entry(1).ready, undefined)
    // A parent in To do stays in To do, never Waiting on you.
    t.ok(["add", "todo", "Plan", "--desc", "p"])
    t.ok(["add", "todo", "Other plan", "--desc", "p"])
    t.ok(["add", "todo", "Step", "--parent", "5"])
    t.ok(["done", "7"])
    assert.deepEqual(t.ids("todo"), [6, 5])
    assert.deepEqual(t.ids("waiting"), [])
    assert.doesNotMatch(readFileSync(t.file, "utf8"), /"ready/)
  } finally {
    t.done()
  }
})

test("rm of a card under a parent marks nothing; rm of a parent unlinks its cards", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Parent"])
    t.ok(["add", "todo", "A", "--parent", "1"])
    t.ok(["add", "todo", "B", "--parent", "1"])
    assert.doesNotMatch(t.ok(["done", "2"]).stdout, /ready to resume/)
    assert.doesNotMatch(t.ok(["rm", "3"]).stdout, /ready to resume/)
    assert.equal(t.item(1).ready, undefined)
    // rm of the parent: its cards are for nothing now.
    t.ok(["add", "todo", "C", "--parent", "1"])
    t.ok(["rm", "1"])
    assert.equal(t.item(4).parent, undefined)
    assert.equal(t.entry(4).parentOf, undefined)
  } finally {
    t.done()
  }
})

test("a board from before 0.20.0: a card's ready mark is dropped when it is read", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Parent", "--desc", "d"])
    const s0 = JSON.parse(readFileSync(t.file, "utf8"))
    s0.items[0].ready = NOW
    s0.items[0].ready_after = [2]
    writeFileSync(t.file, JSON.stringify(s0))
    const read = readBoard(t.file).items[0]
    assert.equal(read.ready, undefined)
    assert.equal(read.ready_after, undefined)
    assert.doesNotMatch(t.ls(120), /ready to resume/)
  } finally {
    t.done()
  }
})

test("done on a parent with open cards: allowed with a warning; they keep their link, shown as (done); their done passes it over", () => {
  const t = setup()
  try {
    chain(t)
    const r = t.ok(["done", "2"])
    assert.match(r.stderr, /board: #2 had open cards for it: #3\. They keep their link, and #2 shows where the most urgent of them is until they are done\./)
    assert.equal(t.item(3).parent, 2)
    // #2 is Done, but its part #3 is still in Doing: #2 shows in Doing (0.20.0), so #3 isn't "for
    // … (done)"; once #3 is done, #2 is Done and #3 says so.
    assert.deepEqual(t.entry(3).parentOf, { id: 2, title: "AI agents' AWS switch", tag: "app", done: false, deploy: false })
    assert.equal(t.entry(2).shown, "doing")
    t.ok(["move", "3", "todo"], t.ops)
    assert.deepEqual(t.entry(3).parentOf, { id: 2, title: "AI agents' AWS switch", tag: "app", done: true, deploy: false })
    const details = detailLines({ ...t.entry(3), column: "todo" }, 100, { now: new Date(NOW) }).lines.map((l) => l.map((seg) => seg.t).join("")).join("\n")
    assert.match(details, /For app #2 AI agents' AWS switch \(done\)/)
    t.ok(["move", "3", "doing"], t.ops)
    // #3 (under #1's Done child) is still #1's part; done, nothing is marked.
    assert.deepEqual(t.entry(1).waitingOn, [3])
    assert.doesNotMatch(t.ok(["done", "3"], t.ops).stdout, /ready to resume/)
  } finally {
    t.done()
  }
})

test("edit --parent sets or changes a parent later, --no-parent removes it", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Parent"])
    t.ok(["add", "todo", "Other parent"])
    t.ok(["add", "todo", "Child"])
    assert.match(t.ok(["edit", "3", "--parent", "1"]).stdout, /^3 edited: Child · for #1 Parent$/m)
    t.ok(["edit", "3", "--parent", "2"])
    assert.equal(t.item(3).parent, 2)
    assert.deepEqual(t.entry(1).waitingOn, [])
    assert.match(t.ok(["edit", "3", "--no-parent"]).stdout, /^3 edited: Child · no parent now$/m)
    assert.equal(t.item(3).parent, undefined)
    assert.deepEqual(t.entry(2).waitingOn, [])
  } finally {
    t.done()
  }
})

test("job-start --parent links a job's card (new or found); its job-report moves only that card", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Node health"])
    const report = join(t.root, "r.json")
    const r = t.ok(["job-start", "aws-key", "--title", "AWS key for the agents", "--parent", "1", "--report", report])
    assert.match(r.stdout, /^2 → doing: AWS key for the agents \(job aws-key\) · for #1 Node health$/m)
    assert.equal(t.item(2).parent, 1)
    // An existing card found by --id gets the parent too.
    t.ok(["add", "todo", "Guard change"])
    t.ok(["job-start", "guard", "--id", "3", "--parent", "2"])
    assert.equal(t.item(3).parent, 2)
    writeFileSync(join(t.root, "g.json"), JSON.stringify({ status: "done", summary: "ok" }))
    assert.doesNotMatch(t.ok(["job-report", "guard", join(t.root, "g.json")]).stdout, /ready to resume/)
    assert.equal(t.item(3).column, "done")
    assert.equal(t.item(2).column, "doing")
  } finally {
    t.done()
  }
})

test("json: parent, waiting_on (open ids under it) and shown_column", () => {
  const t = setup()
  try {
    chain(t)
    const items = () => JSON.parse(t.ok(["json", "--project", "all"]).stdout).items
    const by = (id) => items().find((i) => i.id === id)
    assert.equal(by(2).parent, 1)
    assert.deepEqual(by(1).waiting_on, [2, 3])
    assert.equal(by(3).waiting_on, undefined)
    // #1 (no job of its own) shows in Doing for its parts in Doing: no shown_column.
    assert.equal(by(1).shown_column, undefined)
    t.ok(["move", "3", "waiting"], t.ops)
    // A part asks: #1 and #2 show in Waiting; their own column stays Doing.
    assert.equal(by(1).shown_column, "waiting")
    assert.equal(by(1).column, "doing")
    assert.equal(by(3).shown_column, undefined)
    // The default scope (this project's cards) counts open cards in other projects too.
    t.ok(["move", "3", "doing"], t.ops)
    const mine = JSON.parse(t.ok(["json"]).stdout).items
    assert.deepEqual(mine.find((i) => i.id === 1).waiting_on, [2, 3])
    // The file itself never stores waiting_on or shown_column: they are worked out each time.
    assert.doesNotMatch(readFileSync(t.file, "utf8"), /waiting_on|shown_column/)
  } finally {
    t.done()
  }
})

test("an old board (no links) reads unchanged; bad link fields from a hand edit are dropped, not fatal; a loop in the file can't hang", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Old card", "--desc", "d"])
    const before = JSON.parse(readFileSync(t.file, "utf8"))
    assert.equal(before.items[0].parent, undefined)
    assert.match(t.ls(60), /Old card/)
    assert.doesNotMatch(t.ls(60), /↳|waiting on|ready to resume/)
    const bad = { ...before, items: [
      { ...before.items[0], id: 1, parent: "x", ready: 5, ready_after: "x" },
      { ...before.items[0], id: 2, parent: 2, ready: "not a time", ready_after: [0] },
      { ...before.items[0], id: 3, parent: 4 },
      { ...before.items[0], id: 4, parent: 3 },
    ] }
    writeFileSync(t.file, JSON.stringify(bad))
    const s = readBoard(t.file)
    for (const key of ["parent", "ready", "ready_after"]) {
      assert.equal(s.items[0][key], undefined, key)
      assert.equal(s.items[1][key], undefined, key)
    }
    // 3 and 4 point at each other (no CLI makes this): the board still draws, each waits on the other.
    assert.deepEqual(t.entry(3).waitingOn, [4])
    assert.deepEqual(t.entry(4).waitingOn, [3])
    assert.match(t.ls(120), /Old card/)
    // A child whose parent left the board (archived): no name to give.
    writeFileSync(t.file, JSON.stringify({ ...before, items: [{ ...before.items[0], parent: 99 }] }))
    assert.match(t.ls(120), /for #99, no longer on the board\n/)
  } finally {
    t.done()
  }
})

test("ls at 120 columns: 'for …' (dim) and the cards under it; no 'Waiting on:' list and no 'ready to resume' (0.20.0)", () => {
  const t = setup()
  try {
    chain(t)
    const wide = t.ls(120)
    const card = (id) => wide.split("\n\n").find((b) => new RegExp(`(^|\\n)${id} `).test(b)) || ""
    // All three in Doing (0.7.3): 2's card straight under 1's, 3's under 2's, each title one step
    // further in after the ↳, its id in the id column, and its state (0.7.5); no "for …" inside
    // the family.
    assert.doesNotMatch(card(1), /Waiting on:/)
    assert.match(card(1), /\n2 app   ↳ AI agents' AWS switch:\n {10}approve the 4 steps\n {10}\[doing\]\n/)
    assert.match(card(1), /\n3 ops     ↳ ~\/work backup: let the\n[^\n]*\n {12}\[doing\]\n/)
    assert.doesNotMatch(card(1), /for Node health|for AI agents/)
    t.ok(["done", "3"], t.ops)
    t.ok(["done", "2"])
    const after = t.ls(120)
    assert.match(after, /DOING \(1\)[^\n]*\n1 app\s+Node health: review found one/)
    assert.doesNotMatch(after, /ready to resume|↳/)
    // A new To do card under it: the only work left is To do, so #1 shows in To do with it drawn under it.
    t.ok(["add", "todo", "Child again", "--parent", "1"])
    const again = render(buildView(readBoard(t.file), null, { now: new Date(NOW) }), { width: 120, color: true, now: new Date(NOW), layout: "wide", scroll: { todoOpen: true } })
    assert.doesNotMatch(again, /Waiting on:/)
    assert.match(again, /TO DO \(2\)/)
    assert.match(again, /↳ \x1b\[0m\x1b\[1mChild again/)
  } finally {
    t.done()
  }
})

test("ls at 60 columns: a child's row starts with ↳, its state as a tag; a parent's row says nothing of the cards under it", () => {
  const t = setup()
  try {
    chain(t)
    const narrow = t.ls(60)
    const row = (text, id) => text.split("\n").find((l) => new RegExp(`^.\\s*${id} `).test(l)) || ""
    // All in Doing (0.7.3): each straight under its parent, its title one step further in after
    // the ↳, its id in the id column.
    assert.match(row(narrow, 3), /^ 3   ops     ↳ ~\/work.* \[doing\]  just now$/)
    assert.match(row(narrow, 2), /^ 2   app   ↳ AI.* \[doing\]  just now$/)
    assert.match(row(narrow, 1), /^ 1   app Node health[^\n]* just now$/)
    assert.doesNotMatch(narrow, /waiting on|ready to resume|#\d/)
    assert.deepEqual(narrow.split("\n").filter((l) => /↳/.test(l)).map((l) => l.match(/^ (\d) /)[1]), ["2", "3"], "each drawn once")
    for (const line of narrow.split("\n")) assert.ok([...line].length <= 60, `fits 60: ${line}`)
  } finally {
    t.done()
  }
})

test("the card details: 'For #1 Node health', and where a card shows when it isn't its own column", () => {
  const t = setup()
  try {
    chain(t)
    const text = (id) => detailLines(t.entry(id), 100, { now: new Date(NOW) }).lines.map((l) => l.map((s) => s.t).join("")).join("\n")
    assert.match(text(2), /\n  For #1 Node health\n/)
    assert.doesNotMatch(text(2), /Waiting on:/)
    t.ok(["move", "3", "waiting", "--ask", "Which backup folder?", "--desc", "The setting.\nNow: asks which folder", "--option", "Use the home folder", "--option", "Use the work folder", "--suggest", "Use the home folder", "--project", "ops"], t.ops)
    assert.match(text(1), /\n  Shows in Waiting on you: #2 asks you \(its own column: Doing\)\n/)
  } finally {
    t.done()
  }
})

test("the turn reminder lists cards that look stuck: a press nothing started since, a Doing card with nothing running", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Node health: build", "--desc", "d"])
    t.ok(["add", "waiting", "Proxmox updates: switch them on", "--desc", "d\nNow: ready for you", "--ask", "Switch the updates on?", "--option", "Switch them on", "--option", "Wait a week", "--suggest", "Switch them on"])
    const s0 = JSON.parse(readFileSync(t.file, "utf8"))
    // The press 20 minutes ago, as the board writes it; nothing changed on either card since.
    const pressed = new Date(Date.parse(NOW) - 20 * 60_000).toISOString()
    for (const i of s0.items) i.updated = pressed
    const two = s0.items.find((i) => i.id === 2)
    Object.assign(two, { column: "doing", ask: "", options: undefined, answered: { via: "press", label: "Switch them on", at: pressed, ask: "Switch the updates on?", options: [] }, now: { text: 'your press "Switch them on": being carried out', at: pressed } })
    writeFileSync(t.file, JSON.stringify(s0))
    const state = readBoard(t.file)
    const line = flagReminder(state, { agents: () => [], now: new Date(NOW) })
    assert.match(line, /#1 "Node health: build" \(in Doing, nothing running\)/)
    assert.match(line, /#2 "Proxmox updates: switch them on" \(pressed 20 min ago, nothing started\)/)
    // Herdr not asked (no agent list): no Doing flag, since nothing can say what runs.
    assert.doesNotMatch(flagReminder(state, { agents: () => null, now: new Date(NOW) }), /#1 /)
    // A working agent on it: nothing to flag.
    t.ok(["edit", "1", "--job", "node-health"])
    const s1 = JSON.parse(readFileSync(t.file, "utf8"))
    s1.items.find((i) => i.id === 1).updated = pressed
    writeFileSync(t.file, JSON.stringify(s1))
    assert.doesNotMatch(flagReminder(readBoard(t.file), { agents: () => [{ name: "node-health", agent_status: "working" }], now: new Date(NOW) }), /#1 /)
    // On the row, where its state goes, in amber.
    const view = buildView(readBoard(t.file), [], { now: new Date(NOW) })
    assert.equal(view.doing.find((e) => e.id === 2).flag, "pressed 20 min ago, nothing started")
    assert.match(render(view, { width: 119, color: false, now: new Date(NOW), layout: "inbox" }), /pressed 20 min ago, nothing started/)
    // A narrow row says it in fewer words.
    assert.match(render(view, { width: 70, color: false, now: new Date(NOW), layout: "inbox" }), /pressed, not started/)
    // Through the hook, inside Herdr, as the coordinator of app.
    const out = handle({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.app, prompt: "hi" }, { HERDR_ENV: "1", JOB_BOARD_HOME: t.store, HOME: t.root, HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: join(t.root, "herdr.json") }, { now: new Date(NOW) })
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /^Job board: Cards that look stuck .*#2 "Proxmox updates/m)
  } finally {
    t.done()
  }
})

/** The case from the board (0.7.1): a parent in Doing, one card under it in Doing (newer, so above it), one in To do. */
function nodeHealth(t) {
  t.ok(["add", "doing", "Node health: goes live after its two fixes and with the phone alerts", "--desc", "Merged, not live yet."])
  t.ok(["add", "todo", "Phone alerts move: being updated to the latest code — then merge", "--parent", "1", "--desc", "Moving the alerts."])
  t.ok(["add", "doing", "Badge and chart fixes before going live — build", "--parent", "1", "--desc", "Honest Offline badge."])
}

test("grouped (0.7.1): at 60 columns a card under a parent in its section is drawn straight under its row; one in another section in its own, named with its state", () => {
  const t = setup()
  try {
    nodeHealth(t)
    const lines = t.ls(60).split("\n")
    const at = lines.findIndex((l) => /^ 1 /.test(l))
    assert.match(lines[at], /^ 1   Node health: goes live after [^\n]* just now$/)
    // The one in Doing (0.7.3) its own row, once, straight under it, its id in the id column and
    // its title further in after the ↳, with its state (0.7.5).
    assert.match(lines[at + 1], /^ 3 {5}↳ Badge and chart fixes before goi… \[doing\]  just now$/)
    const doing = lines.slice(lines.findIndex((l) => /^DOING/.test(l)), lines.findIndex((l) => /^TO DO/.test(l)))
    assert.equal(doing.filter((l) => /\b3\b/.test(l)).length, 1, "3 drawn once")
    assert.doesNotMatch(doing.join("\n"), /for #1/)
    // The one in To do keeps its own row there, counted there, with whose it is.
    const todo = lines.slice(lines.findIndex((l) => /^TO DO/.test(l)))
    assert.match(todo[0], /^TO DO \(1\) ─/)
    assert.match(todo[1], /^ 2   Phone alerts move: being updated to the lates… just now$/)
    assert.match(todo[2], /^ {5}for #1 Node health$/)
    // No ids in the waiting lines; nothing wider than the pane.
    assert.doesNotMatch(lines.join("\n"), /waiting on #|Waiting on: #/)
    for (const line of lines) assert.ok([...line].length <= 60, `fits 60: ${line}`)
  } finally {
    t.done()
  }
})

test("grouped (0.7.1): at 120 columns the parent's card draws the cards under it in its section; a blocked part puts it in Waiting with it", () => {
  const t = setup()
  try {
    nodeHealth(t)
    const wide = t.ls(120)
    const card = wide.split("\n\n").find((b) => /(^|\n)1 Node health/.test(b)) || ""
    assert.doesNotMatch(card, /Waiting on:/)
    // 3 (Doing too) is its own card straight under it, further in, with its state; 2 (To do) its
    // own card in To do.
    assert.match(card, /\n3   ↳ Badge and chart fixes before[^\n]*\n {6}going live — build {6}just now\n {6}\[doing\]\n {6}Honest Offline badge\./)
    assert.equal(wide.match(/(^| )2 /gm).length, 1, "2 drawn once")
    assert.equal(wide.match(/^3 /gm).length, 1, "3 drawn once")
    assert.doesNotMatch(wide, /waiting on #|Waiting on: #/)
    // The same through the view, with agents: a working one says so; a blocked one is first (it waits on you).
    t.ok(["job-start", "fixes", "--id", "3"])
    t.ok(["job-start", "alerts", "--id", "2"])
    const view = buildView(readBoard(t.file), [
      { name: "fixes", agent_status: "working" },
      { name: "alerts", agent_status: "blocked" },
    ], { now: new Date(NOW) })
    // 2's job is blocked: a part asks the user, so 1 shows in Waiting too, 2 drawn under it; 3
    // (working) has its own row in Doing, "for #1 …". "1 needs you": the one question.
    const parent = view.waiting.find((e) => e.id === 1)
    assert.deepEqual(parent.under.map((c) => [c.id, c.title, c.live]), [[2, "Phone alerts move", "blocked"], [3, "Badge and chart fixes before going live", "working"]])
    const text = render(view, { width: 60, now: new Date(NOW), layout: "compact", scroll: { todoOpen: true, doneOpen: true } })
    assert.match(text, /\nWAITING ON YOU \(2\) ─+\n 1 ! Node health[^\n]*\n(?: {5}[^\n]*\n)* 2 ! {3}↳ Phone alerts move[^\n]* blocked  just now\n/)
    assert.match(text, /\nDOING \(1\) ─+\n 3   Badge and chart fixes[^\n]* working  just now\n {5}for #1 Node health\n/)
    assert.match(text, /^Job board · 1 needs you/)
    const details = detailLines(parent, 100, { now: new Date(NOW) }).lines.map((l) => l.map((s) => s.t).join("")).join("\n")
    assert.match(details, /\n  Shows in Waiting on you: #2 asks you \(its own column: Doing\)\n/)
  } finally {
    t.done()
  }
})

test("grouped (0.7.1): one level under each card; a Done card's open cards show under its parent in its place; none under a Done card", () => {
  const t = setup()
  try {
    chain(t)
    // 1 ← 2 ← 3: 1 shows 2 only, 2 shows 3.
    let v = t.view()
    assert.deepEqual(v.doing.find((e) => e.id === 1).under.map((c) => c.id), [2])
    assert.deepEqual(v.doing.find((e) => e.id === 2).under.map((c) => c.id), [3])
    assert.match(t.ls(60), / 1   app Node health[^\n]* just now/)
    // 2 done with 3 still open: 2 shows in Doing for its part (0.20.0), drawn under 1, 3 under it.
    t.ok(["done", "2"])
    v = t.view()
    assert.deepEqual(v.doing.find((e) => e.id === 1).under.map((c) => c.id), [2])
    assert.deepEqual(v.doing.find((e) => e.id === 2).under.map((c) => c.id), [3])
    // 3 done too: 2 is Done; a card under a Done card shows under its parent in its place.
    t.ok(["add", "todo", "Leftover", "--parent", "3"], t.ops)
    t.ok(["done", "3"], t.ops)
    v = t.view()
    assert.ok(v.doneToday.some((e) => e.id === 2))
    const narrow = t.ls(60)
    assert.equal(narrow.match(/^ 4 /gm).length, 1, "drawn once")
  } finally {
    t.done()
  }
})

test("under a deploy card (0.14.0): the merged cards wait for the deploy, and the deploy card deploys them, in the CLI, the pane and the details", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Release Notes Manager: deploy the three merged changes"])
    const one = t.ok(["add", "waiting", "PDF file names: merge", "--parent", "1", "--ask", "Merge the file names change?", "--option", "Merge the change", "--option", "Wait for a check", "--suggest", "Merge the change"]).stdout
    assert.equal(one.trim(), "added 2 (waiting on you): PDF file names: merge · waits for the deploy on #1 Release Notes Manager")
    assert.match(t.ok(["add", "todo", "Forum posts: merge", "--parent", "1"]).stdout, /· waits for the deploy on #1 Release Notes Manager$/m)
    assert.equal(t.entry(2).parentOf.deploy, true)
    assert.equal(t.entry(1).deploys, true)
    const wide = t.ls(120)
    assert.doesNotMatch(wide, /Deploys:|Waiting on:|deploys \d/)
    // Its merge question asks the user: the deploy card shows in Waiting on you with it.
    assert.match(t.ls(80), /WAITING ON YOU \(2\)[^\n]*\n 1 ! Release Notes Manager: deploy the three merged changes/)
    const details = (id) => detailLines(t.entry(id), 100).lines.map((l) => l.map((s) => s.t).join("").trimEnd()).join("\n")
    assert.match(details(2), /\n {2}Waits for the deploy on #1 Release Notes Manager\n/)
    assert.match(details(1), /\n {2}Shows in Waiting on you: #2 asks you \(its own column: Doing\)\n/)
    // The deploy done while a card under it still asks: it shows in Waiting until that is answered;
    // once nothing open under it is more than To do, it is Done and its cards say they went out with it.
    assert.match(t.run(["done", "1"]).stderr, /#1 shows where the most urgent of them is until they are done/)
    assert.match(details(2), /Waits for the deploy on #1 Release Notes Manager/)
    t.ok(["move", "2", "todo"])
    assert.match(details(2), /Deployed with #1 Release Notes Manager \(done\)/)
    // A card under any other card is still a part of it, and that card waits on it.
    t.ok(["add", "doing", "Node health: goes live"])
    assert.match(t.ok(["add", "todo", "Badge fixes", "--parent", "4"]).stdout, /· for #4 Node health$/m)
  } finally {
    t.done()
  }
})

test("sub-card names (0.19.0): a check or review under a card shows as its parent's number and kind, its number kept; commands take either", () => {
  const t = setup()
  try {
    t.ok(["add", "doing", "Test proof and secret screen, rules side: install", "--desc", "Install it."])
    t.ok(["add", "doing", "Test proof and secret screen, rules side: check", "--parent", "1", "--desc", "A fresh check."])
    t.ok(["add", "todo", "Test proof, rules side: second review", "--parent", "1", "--desc", "Again."])
    t.ok(["add", "todo", "Test proof docs: write", "--parent", "1", "--job", "proof-review", "--desc", "By its job's slug."])
    t.ok(["add", "todo", "Node health fixes: built — in independent review", "--parent", "1", "--desc", "Not a review: where it stands."])
    t.ok(["add", "todo", "Export to CSV: check", "--desc", "No parent: no name."])
    assert.deepEqual([2, 3, 4, 5, 6].map((id) => t.entry(id).subRef ?? ""), ["1-check", "1-review", "1-review2", "", ""])
    assert.equal(t.entry(4).subName, "1 · review2 (4)")
    // Rows: the name where the number goes; the title still lines up after it.
    const rows = t.ls(100)
    // Under its parent in the same section: its own number (its parent is the row above) and the
    // title after the ↳; in another section: the name, on its own row.
    assert.match(rows, /^ 1   Test proof and secret screen, rules side: install[^\n]*\n 2 {5}↳ Test proof and secret screen, rules side: check/m)
    assert.match(rows, /^ 1 · review2 \(4\)   Test proof docs: write/m)
    assert.match(rows, /^ 5   Node health fixes/m)
    // Commands take the name: now, edit, done; --parent too; the nth one as review2.
    assert.match(t.ok(["now", "1-check", "checked: one fix first", "--only"]).stdout, /^2 now: checked: one fix first/m)
    t.ok(["edit", "1-review2", "--desc", "By its job's slug, edited."])
    assert.equal(t.item(4).desc, "By its job's slug, edited.")
    t.ok(["done", "1-review"])
    assert.equal(t.item(3).column, "done")
    t.ok(["add", "todo", "Check notes: write", "--parent", "1-check", "--desc", "Under the check."])
    assert.equal(t.item(7).parent, 2)
    // The number is unchanged, and still works; a name that isn't there says what is.
    t.ok(["done", "4"])
    const r = t.run(["done", "1-review3"])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no review number 3 under card 1 on the board \(it has 1-check \(2\), 1-review \(3\), 1-review2 \(4\)\)/)
    // The details say both names.
    const lines = detailLines({ ...t.entry(2), column: "doing" }, 80, { now: new Date(NOW) }).lines.map((l) => l.map((s) => s.t).join("")).join("\n")
    assert.match(lines, /· card 2, also 1-check/)
  } finally {
    t.done()
  }
})

test("sub-card names count the archived ones: archiving an older review moves no name, and ls --done names what commands take", () => {
  const t = setup()
  const at = (day) => ({ JOB_BOARD_NOW: `2026-10-${day}T10:00:00Z` })
  try {
    t.ok(["add", "doing", "Parent work: build", "--job", "parent-build", "--desc", "The parent."], t.app, at("01"))
    t.ok(["add", "todo", "Parent work: review", "--parent", "1", "--desc", "First."], t.app, at("01"))
    t.ok(["done", "2"], t.app, at("01"))
    t.ok(["add", "todo", "Parent work: second review", "--parent", "1", "--desc", "Second."], t.app, at("06"))
    t.ok(["add", "todo", "Parent work: third review", "--parent", "1", "--desc", "Third."], t.app, at("06"))
    const ls = (args, day) => t.ok(["ls", "--width", "120", "--project", "all", ...args], t.app, at(day)).stdout
    assert.match(ls([], "06"), /1 · review2 \(3\)[\s\S]*1 · review3 \(4\)|1 · review3 \(4\)[\s\S]*1 · review2 \(3\)/)
    // 9 Oct: a write archives card 2; the names stay as they were.
    t.ok(["now", "1", "building", "--only"], t.app, at("09"))
    assert.equal(t.item(2), undefined, "card 2 is archived")
    const after = ls([], "09")
    assert.match(after, /1 · review2 \(3\)/)
    assert.match(after, /1 · review3 \(4\)/)
    assert.match(t.ok(["done", "1-review2"], t.app, at("09")).stdout, /^3 → done: Parent work: second review/m)
    assert.equal(t.item(4).column, "todo", "card 4 untouched")
    // A name that stands for the archived card is refused, naming it.
    const r = t.run(["edit", "1-review", "--desc", "x"], t.app, at("09"))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /1-review is card 2, done and archived/)
    // ls --done (the archive read too) shows the names the commands take.
    const done = ls(["--done", "30d"], "09")
    for (const name of ["1 · review \\(2\\)", "1 · review2 \\(3\\)", "1 · review3 \\(4\\)"]) assert.match(done, new RegExp(name))
    t.ok(["edit", "1-review3", "--desc", "Edited by its name."], t.app, at("09"))
    assert.equal(t.item(4).desc, "Edited by its name.")
    assert.notEqual(t.item(3).desc, "Edited by its name.")
    // --parent takes it the same way.
    t.ok(["add", "todo", "Notes on the third: write", "--parent", "1-review3", "--desc", "Under it."], t.app, at("09"))
    assert.equal(t.item(5).parent, 4)
  } finally {
    t.done()
  }
})
