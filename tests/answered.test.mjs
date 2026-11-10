// Run: node --test (from the repo root)
// A press takes its card off "waiting on you" at once (0.19.0): the pane's press and `answer`
// move it to Doing with `your press "<label>": being carried out`, without its question and
// buttons; `answered` does the same for words typed in the chat. The press stays in the inbox
// (inbox get, which ship.mjs reads), not-run still finds it, a new question brings the card back,
// and a parent whose cards were answered no longer shows under Waiting. Herdr is faked by
// fixtures/fake-herdr.mjs; every test has its own temp HOME and store.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answeredLine, buildView, createAnswerer, NOT_RUN, readBoard, unacked, updateBoard, waitsOnUser } from "../board.mjs"
import { reminder } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const COORD = "w1:p1"

/** A temp HOME and store, a coordinator pane with a live job-board channel (so a press goes into the inbox), and one Waiting card. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ba-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, "store")
  mkdirSync(store)
  const fake = join(base, "herdr.json")
  writeFileSync(fake, JSON.stringify({ agents: [{ pane_id: COORD, name: "", agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base }] }))
  const env = { ...process.env, HOME: base, XDG_STATE_HOME: "", JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: COORD, TZ: "UTC", NO_COLOR: "1" }
  delete env.JOB_AGENT_ROLE
  const board = (args, extra = {}) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: { ...env, ...extra }, encoding: "utf8" })
  const ok = (args, extra) => {
    const r = board(args, extra)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  ok(["add", "waiting", "Login fix: merge it", "--desc", "The login fix passed its check.\nNow: checked; waiting for your merge OK", "--ask", "Merge the login fix?", "--option", "Merge it", "--option", "Hold it for now", "--suggest", "Merge it"])
  mkdirSync(join(store, "channels"), { recursive: true })
  writeFileSync(join(store, "channels", `${process.pid}.json`), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), started: new Date().toISOString(), pane: COORD, workspace: "w1", version: "0.9.0" }))
  const file = join(store, "board.json")
  const card = (id = 1) => readBoard(file).items.find((i) => i.id === id)
  return { base, file, env, board, ok, card, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("a press in the pane: the card goes to Doing at once, its question and buttons gone; the press stays in the inbox for inbox get (ship.mjs)", async () => {
  const s = setup()
  try {
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    const c = s.card()
    assert.equal(c.column, "doing")
    assert.equal(c.ask, "")
    assert.equal(c.options, undefined)
    assert.equal(c.sent, undefined)
    assert.equal(c.now.text, 'your press "Merge it": being carried out')
    assert.deepEqual([c.answered.via, c.answered.label, c.answered.ask], ["press", "Merge it", "Merge the login fix?"])
    assert.match(c.answered.to, /coordinator \(w1:p1\)$/)
    assert.deepEqual(c.answered.options, [{ label: "Merge it", suggested: true }, { label: "Hold it for now" }])
    assert.equal(answers.notes["#1"], undefined, "no note: the card moved")

    // The board: under Doing, not Waiting; nothing needs you.
    const view = buildView(readBoard(s.file), null)
    assert.deepEqual([view.waiting.length, view.doing.map((e) => e.id)], [0, [1]])
    assert.match(s.ok(["ls"]).replace(/\n +/g, " "), /Now: your press "Merge it": being carried out/)
    assert.doesNotMatch(s.ok(["ls"]), /WAITING ON YOU \(1\)|\[ Merge it/)
    // get: the answer and the question it answered.
    const got = s.ok(["get", "1"])
    assert.match(got, /^card 1 · doing/m)
    assert.match(got, /^Answered: Merge it \(a press · .* · to .*coordinator \(w1:p1\)\)$/m)
    assert.match(got, /^ {2}to the question: Merge the login fix\?$/m)

    // The coordinator's message, and inbox get: what ship.mjs's press lookup reads (kind, card, label).
    const [m] = unacked(s.file)
    assert.deepEqual([m.kind, m.card, m.label], ["answer", 1, "Merge it"])
    const r = s.board(["inbox", "get", m.id])
    assert.equal(r.status, 0, r.stderr)
    const read = JSON.parse(r.stdout)
    assert.deepEqual([read.kind, Number(read.card), read.label, read.acked], ["answer", 1, "Merge it", ""])

    // A second press of the same button (a stale screen): the card isn't waiting, nothing is sent.
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    assert.equal(unacked(s.file).length, 1)
  } finally {
    s.done()
  }
})

test("not-run after a press: the press on record and the other buttons come back, with the not-run question", async () => {
  const s = setup()
  try {
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    assert.equal(s.card().column, "doing")
    const out = s.ok(["not-run", "1", "--type", "merge the login fix"])
    assert.match(out, /the "Merge it" button is gone from the card \(buttons left: Hold it for now\)/)
    const c = s.card()
    assert.equal(c.column, "waiting")
    assert.equal(c.ask, `${NOT_RUN}type "merge the login fix" in the coordinator's chat`)
    assert.deepEqual(c.options, [{ label: "Hold it for now" }])
    assert.equal(c.not_run.label, "Merge it")
    assert.equal(c.answered, undefined, "the answer is over: the card asks again")
    // --label takes the press on record, or another of the buttons the card had.
    await answers.press({ type: "send", id: 1, label: "Hold it for now", key: "#1" })
    assert.equal(s.card().column, "doing")
    assert.equal(s.board(["not-run", "1", "--type", "x", "--label", "Deploy it"]).status, 2, "no button it had")
    s.ok(["not-run", "1", "--type", "hold it", "--label", "Hold it for now"])
    assert.deepEqual([s.card().column, s.card().options], ["waiting", undefined])
  } finally {
    s.done()
  }
})

test("answer from the command line does what a press does: the card leaves Waiting, and says so", () => {
  const s = setup()
  try {
    const out = s.ok(["answer", "1", "2"], { HERDR_PANE_ID: "w1:p9", JOB_BOARD_DELIVERY: "channel" })
    assert.match(out, /its job-board channel\): Hold it for now$/m)
    assert.match(out, /^card 1 → doing: your press "Hold it for now": being carried out$/m)
    assert.deepEqual([s.card().column, s.card().answered.label], ["doing", "Hold it for now"])
    // Not waiting any more: a second answer is refused, nothing sent.
    const again = s.board(["answer", "1", "1"], { HERDR_PANE_ID: "w1:p9", JOB_BOARD_DELIVERY: "channel" })
    assert.equal(again.status, 1)
    assert.match(again.stderr, /isn't waiting on you/)
    assert.equal(unacked(s.file).length, 1)
    // To this pane itself (it owns the card): it acts on it, and the card leaves Waiting too.
    s.ok(["move", "1", "waiting", "--ask", "Merge it now?", "--option", "Merge it", "--option", "Hold it for now", "--suggest", "Merge it"])
    assert.match(s.ok(["answer", "1", "Merge it"]), /act on it here: Merge it\ncard 1 → doing/)
    assert.equal(s.card().column, "doing")
  } finally {
    s.done()
  }
})

test("answered: the user's words typed in the chat take the card off Waiting, kept on the card; refused for a worker, a card not waiting, a secret, too many words", () => {
  const s = setup()
  try {
    const words = "merge it, but leave the docs change for tomorrow"
    const out = s.ok(["answered", "1", words])
    assert.match(out, /^1 → doing: Login fix: merge it$/m)
    assert.match(out, /now: your answer "merge it, but leave the docs change for tomorrow": being carried out/)
    const c = s.card()
    assert.deepEqual([c.column, c.ask, c.options, c.now.text], ["doing", "", undefined, `your answer "${words}": being carried out`])
    assert.deepEqual([c.answered.via, c.answered.label, c.answered.ask], ["chat", words, "Merge the login fix?"])
    assert.match(s.ok(["get", "1"]), /^Answered: "merge it, but leave the docs change for tomorrow" \(typed in the chat · /m)
    assert.equal(unacked(s.file).length, 0, "nothing is sent: the coordinator has the words already")

    // Refusals: exit 2, nothing written.
    const before = JSON.stringify(s.card())
    for (const [args, extra, why] of [
      [["answered", "1", "again"], {}, /isn't waiting on you \(it is in doing\)/],
      [["answered", "1", "x"], { JOB_AGENT_ROLE: "worker" }, /answered is the coordinator's/],
      [["answered", "1", " "], {}, /needs the user's words/],
      [["answered", "1"], {}, /usage: board\.mjs answered/],
    ]) {
      const r = s.board(args, extra)
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`)
      assert.match(r.stderr, why)
    }
    assert.equal(JSON.stringify(s.card()), before)

    // A new question brings it back to Waiting, and ends the answer it had.
    s.ok(["move", "1", "waiting", "--ask", "Merge the docs change too?", "--option", "Merge it", "--option", "Leave it", "--suggest", "Merge it"])
    assert.deepEqual([s.card().column, s.card().answered], ["waiting", undefined])
    for (const [text, why] of [
      ["the key is ghp_abcdefghijklmnopqrstuvwxyz0123456789", /looks like it holds a secret/],
      ["x".repeat(301), /at most 300 characters/],
    ]) {
      const r = s.board(["answered", "1", text])
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, why)
    }
    assert.equal(s.card().column, "waiting")
    // Long words: the status line is cut to fit, the card keeps them whole.
    const long = `${"a long answer ".repeat(20)}end`
    s.ok(["answered", "1", long])
    assert.ok(s.card().now.text.length <= 200)
    assert.match(s.card().now.text, /^your answer "a long answer .*…": being carried out$/)
    assert.equal(s.card().answered.label, long.trim())
    assert.equal(answeredLine({ via: "press", label: "Go" }), 'your press "Go": being carried out')
  } finally {
    s.done()
  }
})

test("a new question written while a press is on its way stays on the card: the press answered the old one", async () => {
  const s = setup()
  try {
    // The send takes a moment, and the coordinator writes a new question meanwhile.
    const send = async () => {
      updateBoard(s.file, (st) => {
        const it = st.items.find((i) => i.id === 1)
        it.ask = "Merge both fixes?"
        it.options = [{ label: "Merge both" }, { label: "Hold" }]
      })
      return null
    }
    const answers = createAnswerer({ file: s.file, origin: COORD, env: s.env, agents: () => null, send })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    const c = s.card()
    assert.deepEqual([c.column, c.ask, c.answered], ["waiting", "Merge both fixes?", undefined])
    assert.match(answers.notes["#1"].t, /^sent: Merge it to .*; the card has a new question since, so it stays here$/)
  } finally {
    s.done()
  }
})

test("a parent shows under Waiting only while it, or a card under it, asks something", () => {
  const at = "2026-11-10T10:00:00Z"
  const card = (id, column, extra = {}) => ({ id, title: `Card ${id}: do it`, column, since: at, updated: at, ...extra })
  const ask = { ask: "Merge it?", options: [{ label: "Merge it" }, { label: "Hold it" }] }
  const answered = { now: { text: 'your press "Merge it": being carried out', at }, answered: { via: "press", label: "Merge it", at, ask: "Merge it?", options: [] } }
  const where = (items) => {
    const state = { version: 1, next_id: 10, items, panes: {} }
    const view = buildView(state, null)
    return { waiting: view.waiting.map((e) => e.id), doing: view.doing.map((e) => e.id), reminder: reminder(state) }
  }
  // The parent waits with no question of its own; its child was pressed (now in Doing): the parent is in Doing too.
  let w = where([card(1, "waiting"), card(2, "doing", { parent: 1, ...answered })])
  assert.deepEqual([w.waiting, w.doing.sort()], [[], [1, 2]])
  assert.equal(w.reminder, "", "the turn reminder agrees: nothing waits on the user")
  assert.equal(waitsOnUser({ items: [card(1, "waiting"), card(2, "doing", { parent: 1 })] }, card(1, "waiting")), false)
  // Its child asks something: the parent shows under Waiting, the child under it.
  w = where([card(1, "waiting"), card(2, "waiting", { parent: 1, ...ask })])
  assert.deepEqual(w.waiting.sort(), [1, 2])
  assert.match(w.reminder, /#1 "Card 1: do it"; ↳ #2/)
  // A grandchild's question counts; so does a blocked job under it (live state).
  assert.deepEqual(where([card(1, "waiting"), card(2, "doing", { parent: 1 }), card(3, "waiting", { parent: 2, ...ask })]).waiting.sort(), [1, 3])
  const items = [card(1, "waiting"), card(2, "doing", { parent: 1, job: "fix-x" })]
  assert.deepEqual(buildView({ version: 1, items, panes: {} }, [{ name: "fix-x", agent_status: "blocked", workspace_id: "w1", pane_id: "w1:p2" }], { workspace: "w1" }).waiting.map((e) => e.id).sort(), [1, 2])
  // A parent with its own question stays, whatever its cards do; so does a Waiting card with nothing under it.
  assert.deepEqual(where([card(1, "waiting", ask), card(2, "doing", { parent: 1 })]).waiting, [1])
  assert.deepEqual(where([card(1, "waiting", { ask: "Run the restart yourself" })]).waiting, [1])
  assert.deepEqual(where([card(1, "waiting")]).waiting, [1])
  // Its cards all done: nothing open under it, so it is an ordinary Waiting card again.
  assert.deepEqual(where([card(1, "waiting"), card(2, "done", { parent: 1 })]).waiting, [1])
})

test("a parent that was pressed shows its press, not the line built from the cards under it", async () => {
  const s = setup()
  try {
    s.ok(["add", "todo", "Login fix: docs", "--desc", "The docs half.", "--parent", "1"])
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    const entry = buildView(readBoard(s.file), null).doing.find((e) => e.id === 1)
    assert.equal(entry.now.text, 'your press "Merge it": being carried out')
    // Once the coordinator writes its own line, the built line is back as before.
    s.ok(["now", "1", "merging the login fix", "--only"])
    assert.match(buildView(readBoard(s.file), null).doing.find((e) => e.id === 1).now.text, /#2 to do/)
  } finally {
    s.done()
  }
})
