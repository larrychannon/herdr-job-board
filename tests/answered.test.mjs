// Run: node --test (from the repo root)
// A press takes its card off "waiting on you" at once (0.19.0): the pane's press and `answer`
// move it to Doing with `your press "<label>": being carried out`, without its question and
// buttons; `answered` does the same for words typed in the chat. The press stays in the inbox
// (inbox get, which ship.mjs reads), not-run still finds it, a new question brings the card back,
// and a parent shows under Waiting only for a question of its own (a pressed card under it leaves). Herdr is faked by
// fixtures/fake-herdr.mjs; every test has its own temp HOME and store.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answeredLine, buildView, createAnswerer, NO_PRESS, NOT_RUN, readBoard, unacked, updateBoard } from "../board.mjs"
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

test("a parent shows under Waiting only while a part asks: a pressed card under it leaves Waiting, and the parent with it", async () => {
  const s = setup()
  try {
    // Card 2 (Doing) is the parent of card 1, which asks a question.
    s.ok(["add", "doing", "Login work: ship it", "--desc", "The login fix and its docs."])
    s.ok(["edit", "1", "--parent", "2"])
    const where = () => {
      const state = readBoard(s.file)
      const view = buildView(state, null)
      return { waiting: view.waiting.map((e) => e.id).sort(), doing: view.doing.map((e) => e.id).sort(), reminder: reminder(state) }
    }
    let w = where()
    // Its part asks the user: the parent shows in Waiting with it (0.20.0), worked out, not written.
    assert.deepEqual([w.waiting, w.doing], [[1, 2], []])
    assert.equal(readBoard(s.file).items.find((i) => i.id === 2).column, "doing")
    assert.match(w.reminder, /#1 "Login fix: merge it" \(for #2 "Login work: ship it"\)/)
    // The question under it is answered: nothing is left under Waiting, nor in the turn reminder.
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    w = where()
    assert.deepEqual([w.waiting, w.doing], [[], [1, 2]])
    assert.equal(w.reminder, "")
    // A parent with its own question shows under Waiting until it is answered too.
    s.ok(["move", "2", "waiting", "--desc", "The login fix and its docs.\nNow: the fix is merging; the docs wait", "--ask", "Ship the docs today?", "--option", "Ship them today", "--option", "Keep them for tomorrow", "--suggest", "Ship them today"])
    assert.deepEqual(where().waiting, [2])
    await answers.press({ type: "send", id: 2, label: "Ship them today", key: "#2" })
    assert.deepEqual(where().waiting, [])
    // A Waiting card with no question but a step of yours (as ship.mjs leaves one, with a card
    // under it to do) still shows under Waiting: only a press or an answer takes a card off it.
    s.ok(["add", "waiting", "Restart: your step", "--desc", "You do: restart the service."])
    s.ok(["add", "todo", "Follow-up: tidy the logs", "--desc", "Low findings.", "--parent", "3"])
    assert.deepEqual(where().waiting, [3])
  } finally {
    s.done()
  }
})

test("a job's report applied again after a press doesn't bring its question back", () => {
  const s = setup()
  try {
    const report = join(s.base, "report.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Built the export.", needs_user: ["Ship the export to everyone today?"], tested: "read-only" }))
    s.ok(["job-start", "export-csv", "--title", "Export to CSV: build", "--desc", "A CSV export of the list.", "--report", report])
    s.ok(["job-report", "export-csv"])
    const id = readBoard(s.file).items.find((i) => i.job === "export-csv").id
    assert.equal(s.card(id).column, "waiting")
    s.ok(["answered", String(id), "yes, ship it today"])
    assert.equal(s.card(id).column, "doing")
    // The same report read again (a watcher firing twice, a tab closed later): nothing changes.
    s.ok(["job-report", "export-csv", "--if-final"])
    assert.deepEqual([s.card(id).column, s.card(id).answered.label], ["doing", "yes, ship it today"])
  } finally {
    s.done()
  }
})

test("a job's report with a new question on a card a press answered: the old answer goes, so get and not-run don't name the old press", async () => {
  const s = setup()
  try {
    s.ok(["edit", "1", "--job", "login-fix"])
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    assert.equal(s.card().answered.label, "Merge it")
    // The coordinator took the press and ran the job; the press is out of the inbox.
    for (const m of unacked(s.file)) s.ok(["inbox", "ack", m.id])
    const report = join(s.base, "report.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Merged the login fix.", needs_user: [{ ask: "Deploy to staging or production first?", options: ["Staging first", "Production now"], suggest: "Staging first" }], tested: "read-only" }))
    s.ok(["job-report", "login-fix", report])
    const c = s.card()
    assert.deepEqual([c.column, c.ask, c.options.map((o) => o.label)], ["waiting", "Deploy to staging or production first?", ["Staging first", "Production now"]])
    assert.equal(c.answered, undefined, "the press answered the old question")
    assert.doesNotMatch(s.ok(["get", "1"]), /Answered:|Merge the login fix/)
    // A bare not-run names no press: nothing was pressed for this question.
    s.ok(["not-run", "1", "--type", "deploy it to staging"])
    assert.equal(s.card().ask, `${NO_PRESS}type "deploy it to staging" in the coordinator's chat`)

    // The same for a closed job's late blocked report: the card reopens with the reason, no old answer.
    s.ok(["add", "waiting", "Export: ship it", "--desc", "The export is built.", "--ask", "Ship the export to everyone?", "--option", "Ship the export", "--option", "Hold the export", "--suggest", "Ship the export"])
    s.ok(["edit", "2", "--job", "export-csv"])
    await answers.press({ type: "send", id: 2, label: "Ship the export", key: "#2" })
    assert.deepEqual([s.card(2).column, s.card(2).answered.label], ["doing", "Ship the export"])
    s.ok(["edit", "2", "--job", ""])
    const late = join(s.base, "late.json")
    writeFileSync(late, JSON.stringify({ status: "blocked", summary: "The export host is down", needs_user: ["Decide whether to wait for the host"] }))
    s.ok(["job-report", "export-csv", late])
    const c2 = s.card(2)
    assert.equal(c2.column, "waiting")
    assert.match(c2.ask, /export host is down|wait for the host/)
    assert.equal(c2.answered, undefined)
  } finally {
    s.done()
  }
})

test("a parent that was pressed shows its press in Doing; once its line is written over, nothing runs and it shows To do with its part", async () => {
  const s = setup()
  try {
    s.ok(["add", "todo", "Login fix: docs", "--desc", "The docs half.", "--parent", "1"])
    const answers = createAnswerer({ file: s.file, origin: COORD, env: { ...s.env, JOB_BOARD_DELIVERY: "channel" }, agents: () => null })
    await answers.press({ type: "send", id: 1, label: "Merge it", key: "#1" })
    const entry = buildView(readBoard(s.file), null).doing.find((e) => e.id === 1)
    assert.equal(entry.now.text, 'your press "Merge it": being carried out')
    // Its own line stays its own (no line built from the cards under it, 0.20.0); with no job, no
    // run and no press going on, its To do part is the work left: it shows in To do.
    s.ok(["now", "1", "merging the login fix", "--only"])
    assert.equal(buildView(readBoard(s.file), null).todo.find((e) => e.id === 1).now.text, "merging the login fix")
  } finally {
    s.done()
  }
})
