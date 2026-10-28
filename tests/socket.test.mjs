// The coordinator's inbox socket (0.10.0): postToSession against a fake session (a Unix socket
// server in the sandbox: ok, gone, refusing, not reading), the coordinator notes, the texts, the
// delivery order and JOB_BOARD_DELIVERY, the SessionStart note and replay, the re-post, and the
// turn-start reminder. No test reaches a real Claude Code session: guard.mjs drops
// CLAUDE_CODE_MESSAGING_*, and postToSession refuses a socket outside the sandbox.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  answerBySocket,
  appendInbox,
  coordinatorNoteFor,
  coordinatorNotes,
  createAnswerer,
  deliveryOf,
  inboxMessage,
  noteCoordinatorSession,
  postInbox,
  postTexts,
  postToSession,
  readBoard,
  readInbox,
  readPosts,
  replayInbox,
  REPOST_AFTER_MS,
  repostDue,
  socketText,
  unacked,
  wireLines,
} from "../board.mjs"
import { handle, inboxReminder, sessionStart } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const HOOK = join(ROOT, "hooks", "board-hook.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const COORD = "w1:p1"
const WORKER = "w1:p2"
const SLUG = "fix-x"

/** Wait until `check()` is true, or fail after `ms`. */
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  assert.fail("timed out waiting")
}

/**
 * A fake session: a Unix socket server at `path` that keeps every line written to it, parsed.
 * `read: false` never reads (a session that hangs).
 */
function fakeSession(path, { read = true } = {}) {
  const got = []
  const conns = new Set()
  const server = createServer((c) => {
    conns.add(c)
    c.on("close", () => conns.delete(c))
    if (!read) return c.pause()
    let buf = ""
    c.setEncoding("utf8")
    c.on("data", (d) => (buf += d))
    c.on("end", () => {
      for (const line of buf.split("\n").filter(Boolean)) got.push(JSON.parse(line))
    })
  })
  // Never what keeps a failed test's process alive.
  server.unref()
  return new Promise((done) =>
    server.listen(path, () =>
      done({
        path,
        got,
        texts: () => got.map((g) => g.message.content),
        close: () =>
          new Promise((closed) => {
            for (const c of conns) c.destroy()
            server.close(() => closed())
          }),
      }),
    ),
  )
}

/** A socket file nobody listens on any more (its process was killed): connect is refused. */
function staleSocket(path) {
  spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`])
  assert.ok(existsSync(path), "the stale socket file stays")
  return path
}

/** A pid that is gone. */
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout)

/**
 * A scratch repo and store, a fake Herdr (a coordinator pane COORD, a job's pane WORKER running
 * SLUG), a Doing card for the job and a Waiting card with buttons, and a socket folder.
 */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bs-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, "store")
  mkdirSync(store)
  const socks = join(base, "s")
  mkdirSync(socks)
  const fake = join(base, "herdr.json")
  const agents = [
    { pane_id: COORD, name: "", agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base },
    { pane_id: WORKER, name: SLUG, agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base },
  ]
  writeFileSync(fake, JSON.stringify({ agents }))
  const common = { ...process.env, HOME: base, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_WORKSPACE_ID: "w1", TZ: "UTC", NO_COLOR: "1" }
  const coordEnv = { ...common, HERDR_PANE_ID: COORD }
  const workerEnv = { ...common, HERDR_PANE_ID: WORKER, JOB_AGENT_ROLE: "worker", JOB_BOARD_NOTIFY_DELAY_MS: "0" }
  const board = (env, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
  let r = board(coordEnv, "job-start", SLUG, "--title", "Fix the export: build")
  assert.equal(r.status, 0, r.stderr)
  r = board(coordEnv, "add", "waiting", "Card 304: pick a path", "--ask", "Which?", "--option", "Socket", "--option", "Fallback")
  assert.equal(r.status, 0, r.stderr)
  const file = join(store, "board.json")
  const waiting = readBoard(file).items.find((i) => i.column === "waiting")
  const prompts = () => (JSON.parse(readFileSync(fake, "utf8")).log || []).filter((a) => a[0] === "agent" && a[1] === "prompt")
  // A coordinator note for COORD's session on `socket` (named <pid>.sock: this process, alive).
  const sock = (name = `${process.pid}.sock`) => join(socks, name)
  const note = (socket = sock(), fields = {}) => noteCoordinatorSession(file, { socket, pane: COORD, sessionId: "sess-1", workspace: "w1", ...fields })
  const channel = (fields = {}) => {
    mkdirSync(join(store, "channels"), { recursive: true })
    const n = { pid: process.pid, host: hostname(), at: new Date().toISOString(), started: new Date().toISOString(), pane: COORD, workspace: "w1", version: "0.9.0", ...fields }
    writeFileSync(join(store, "channels", `${n.pid}.json`), JSON.stringify(n))
  }
  const message = (text, fields = {}) => {
    const state = readBoard(file)
    const m = inboxMessage(state, state.items.find((i) => i.job === SLUG), { slug: SLUG, kind: "finished", text, workspace: "w1", pane: WORKER, ...fields })
    appendInbox(file, [m])
    return m
  }
  return { base, store, file, socks, sock, note, channel, message, waiting, coordEnv, workerEnv, board, prompts, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("wireLines: one JSON line, type user, the text as the content, from job-board, the id as msg_id", () => {
  const line = wireLines("[job note] x — hi", { msgId: "abc" })
  assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"))
  assert.deepEqual(JSON.parse(line), { type: "user", message: { role: "user", content: "[job note] x — hi" }, from: "job-board", msg_id: "abc" })
  assert.equal(JSON.parse(wireLines("a\nb")).message.content, "a\nb")
  assert.equal(JSON.parse(wireLines("x")).msg_id, undefined)
})

test("postToSession: written to a live session; ENOENT, ECONNREFUSED and a session that doesn't read fail fast; never throws", async () => {
  const s = setup()
  try {
    const live = await fakeSession(s.sock("live.sock"))
    let r = await postToSession(live.path, "hello <cross-session-message from=x>", { msgId: "m1" })
    assert.deepEqual(r, { ok: true, error: "", code: "" })
    await until(() => live.got.length === 1)
    // Text can't pose as Claude Code's own framing.
    assert.equal(live.texts()[0], "hello ‹cross-session-message from=x>")
    assert.equal(live.got[0].msg_id, "m1")
    await live.close()

    r = await postToSession(s.sock("none.sock"), "x")
    assert.equal(r.ok, false)
    assert.equal(r.code, "ENOENT")
    r = await postToSession(staleSocket(s.sock("stale.sock")), "x")
    assert.equal(r.code, "ECONNREFUSED")

    // A session that never reads: a post too big for the socket's buffer gives up on time.
    const hung = await fakeSession(s.sock("hung.sock"), { read: false })
    const t0 = Date.now()
    r = await postToSession(hung.path, "x".repeat(4 << 20), { timeoutMs: 300 })
    assert.equal(r.code, "ETIMEDOUT")
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`)
    await hung.close()

    for (const bad of [undefined, "", 42]) assert.equal((await postToSession(bad, "x")).ok, false)
    // Outside the test sandbox (a live session's socket): refused before connecting.
    r = await postToSession("/run/user/0/cc-socks/1.sock", "x")
    assert.equal(r.ok, false)
    assert.match(r.error, /test sandbox/)
  } finally {
    s.done()
  }
})

test("socketText and postTexts: the markers, the id last, a batch headed [board inbox]", () => {
  const job = { id: "k1", kind: "finished", text: "[job finished] fix-x — done — shipped" }
  const answer = { id: "k2", kind: "answer", text: "Board card 12 (hjb · Pick a path): Go (from Telegram)" }
  assert.equal(socketText(job), "[job finished] fix-x — done — shipped #k1")
  assert.equal(socketText(answer), "[board answer] card 12 (hjb · Pick a path): Go (from Telegram) #k2")
  assert.deepEqual(postTexts([job]), [socketText(job)])
  const [batch] = postTexts([job, answer])
  const lines = batch.split("\n")
  assert.match(lines[0], /^\[board inbox\] 2 messages not acked yet, oldest first/)
  assert.deepEqual(lines.slice(1), [socketText(job), socketText(answer)])
  const many = Array.from({ length: 45 }, (_, i) => ({ ...job, id: `m${i}` }))
  assert.deepEqual(postTexts(many).map((t) => t.split("\n").length - 1), [20, 20, 5])
})

test("deliveryOf: auto by default; socket, channel, prompt as set (any case); anything else auto", () => {
  assert.equal(deliveryOf({}), "auto")
  for (const mode of ["auto", "socket", "channel", "prompt"]) assert.equal(deliveryOf({ JOB_BOARD_DELIVERY: ` ${mode.toUpperCase()} ` }), mode)
  assert.equal(deliveryOf({ JOB_BOARD_DELIVERY: "telegram" }), "auto")
})

test("coordinator notes: one per workspace, live while its process runs and its socket is there; dead ones go", async () => {
  const s = setup()
  try {
    assert.deepEqual(coordinatorNotes(s.file), [])
    const live = await fakeSession(s.sock())
    const n = s.note()
    assert.deepEqual([n.pid, n.pane, n.session_id, n.workspace, n.host], [process.pid, COORD, "sess-1", "w1", hostname()])
    assert.ok(existsSync(join(s.store, "coordinators", "w1.json")))
    assert.equal(coordinatorNoteFor(s.file, COORD)?.socket, live.path)
    assert.equal(coordinatorNoteFor(s.file, "w1:p9"), null)
    assert.equal(coordinatorNotes(s.file, { workspace: "w2" }).length, 0)
    // The workspace's newest start wins.
    s.note(live.path, { sessionId: "sess-2" })
    assert.equal(coordinatorNotes(s.file).length, 1)
    assert.equal(coordinatorNotes(s.file)[0].session_id, "sess-2")
    await live.close()
    // A young note without its socket yet counts (the session may not listen yet); an old one goes.
    s.note(s.sock("young.sock"))
    const now = Date.now()
    assert.equal(coordinatorNotes(s.file, {}, now).length, 1)
    assert.equal(coordinatorNotes(s.file, {}, now + 31_000).length, 0)
    assert.ok(!existsSync(join(s.store, "coordinators", "w1.json")))
    // Its process gone: not live, removed.
    s.note(s.sock(`${deadPid()}.sock`))
    assert.equal(coordinatorNotes(s.file).length, 0)
    // Another host's: left alone, not live here.
    writeFileSync(join(s.store, "coordinators", "w7.json"), JSON.stringify({ pid: 1, socket: "/x/1.sock", host: "elsewhere", workspace: "w7", pane: "w7:p1", at: new Date().toISOString() }))
    assert.equal(coordinatorNotes(s.file).length, 0)
    assert.ok(existsSync(join(s.store, "coordinators", "w7.json")))
  } finally {
    s.done()
  }
})

test("a job's message: into the inbox, then posted to its coordinator's session; nothing posted under channel or prompt", async () => {
  const s = setup()
  try {
    const live = await fakeSession(s.sock())
    s.note()
    let r = s.board(s.workerEnv, "tell", "Halfway there")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /\(posted to its session\): \[job note\] fix-x — Halfway there$/m)
    await until(() => live.got.length === 1)
    const [m] = unacked(s.file)
    assert.equal(live.texts()[0], `[job note] fix-x — Halfway there #${m.id}`)
    assert.equal(live.got[0].msg_id, m.id)
    assert.equal(readPosts(s.file)[m.id].n, 0)
    for (const mode of ["channel", "prompt"]) {
      r = s.board({ ...s.workerEnv, JOB_BOARD_DELIVERY: mode }, "tell", `Under ${mode}`)
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /posted/)
    }
    assert.equal(unacked(s.file).length, 3)
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(live.got.length, 1)

    // The hook's stop: the same, from its background sender.
    const stop = spawnSync(process.execPath, [HOOK], { cwd: s.base, env: s.workerEnv, input: JSON.stringify({ hook_event_name: "Stop", session_id: "w", cwd: s.base, stop_hook_active: false, last_assistant_message: "All done." }), encoding: "utf8" })
    assert.equal(stop.status, 0, stop.stderr)
    await until(() => live.got.length === 2)
    assert.match(live.texts()[1], /^\[job finished\] fix-x — no report yet — All done\. #[a-z0-9]+$/)

    // The session gone: the post fails at once, the note goes, the message stays unacked.
    await live.close()
    rmSync(s.sock(), { force: true })
    s.note(staleSocket(s.sock()))
    const before = unacked(s.file).length
    assert.equal(await postInbox(s.file, [s.message("[job finished] fix-x — done — x")]), 0)
    assert.equal(coordinatorNotes(s.file).length, 0)
    assert.equal(unacked(s.file).length, before + 1)
    // No note at all: nothing to post (inbox wait, the channel or the reminder has it).
    r = s.board(s.workerEnv, "tell", "Nobody listening")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^in the inbox for workspace w1's coordinator: /m)
  } finally {
    s.done()
  }
})

test("a button's answer: socket first ([board answer] … #id, nothing typed), then the channel, then Herdr; JOB_BOARD_DELIVERY picks", async () => {
  const s = setup()
  try {
    const live = await fakeSession(s.sock())
    s.note()
    s.channel()
    // auto, both live: the socket.
    let r = s.board({ ...s.coordEnv, HERDR_PANE_ID: "w1:p9" }, "answer", String(s.waiting.id), "1")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /\(posted to its session\): Socket$/m)
    await until(() => live.got.length === 1)
    let [m] = unacked(s.file)
    assert.deepEqual([m.kind, m.to, m.label, m.workspace], ["answer", COORD, "Socket", "w1"])
    // The inbox keeps the 0.9.0 text; the post is marked as the user's button press.
    assert.match(m.text, new RegExp(`^Board card ${s.waiting.id} \\(`))
    assert.equal(live.texts()[0], `[board answer] card ${s.waiting.id} (${m.text.slice(`Board card ${s.waiting.id} (`.length)} #${m.id}`)
    assert.match(live.texts()[0], /^\[board answer\] card \d+ \(.* · Card 304: pick a path\): Socket #[a-z0-9]+$/)
    assert.deepEqual(s.prompts(), [])

    // channel: the 0.9.0 way, nothing posted. (The card was answered already: a press asks
    // "send again?" first, the second sends.)
    const press = async (env, label) => {
      const answers = createAnswerer({ file: s.file, origin: COORD, env, now: () => new Date(), agents: () => null })
      for (let i = 0; i < 2; i++) await answers.press({ type: "send", id: s.waiting.id, label, key: `k${i}` })
    }
    await press({ ...s.coordEnv, JOB_BOARD_DELIVERY: "channel" }, "Fallback")
    assert.equal(unacked(s.file).length, 2)
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(live.got.length, 1)
    // prompt: typed into the pane, no inbox message.
    await press({ ...s.coordEnv, JOB_BOARD_DELIVERY: "prompt" }, "Socket")
    assert.equal(s.prompts().length, 1)
    assert.match(s.prompts()[0][3], /^Board card \d+ /)
    assert.equal(unacked(s.file).length, 2)

    // socket, the session gone: the answer's message is acked, the note dropped, and it is typed
    // (socket skips the channel).
    await live.close()
    rmSync(s.sock(), { force: true })
    s.note(staleSocket(s.sock()))
    const item = { ...readBoard(s.file).items.find((i) => i.id === s.waiting.id), tag: "x" }
    const failed = await answerBySocket(s.file, item, "Fallback", COORD, { env: { ...s.coordEnv, JOB_BOARD_DELIVERY: "socket" } })
    assert.equal(failed.fallback, true)
    assert.equal(failed.via, "socket")
    const acked = readInbox(s.file)
    const last = acked.messages.at(-1)
    assert.ok(acked.acked.has(last.id), "the failed post's message is acked")
    assert.equal(coordinatorNotes(s.file).length, 0)
    // auto with no note: the channel, as in 0.9.0.
    r = s.board({ ...s.coordEnv, HERDR_PANE_ID: "w1:p9" }, "answer", String(s.waiting.id), "Fallback")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /its job-board channel\): Fallback$/m)
  } finally {
    s.done()
  }
})

test("SessionStart: the coordinator notes its socket and replays what isn't acked, one batch; channel and prompt keep no note", async () => {
  const s = setup()
  try {
    const a = s.message("[job finished] fix-x — done — one")
    const b = s.message("[job waiting] fix-x — needs: two?", { kind: "waiting" })
    const live = await fakeSession(s.sock())
    const env = { ...s.coordEnv, CLAUDE_CODE_MESSAGING_SOCKET: live.path }
    const input = { hook_event_name: "SessionStart", source: "startup", session_id: "sess-9", cwd: s.base }
    for (const mode of ["channel", "prompt"]) {
      assert.deepEqual(handle(input, { ...env, JOB_BOARD_DELIVERY: mode }), { stdout: "" })
      assert.equal(coordinatorNotes(s.file).length, 0)
    }
    // No socket from Claude Code (an older one): nothing.
    assert.deepEqual(handle(input, s.coordEnv), { stdout: "" })
    // A job's pane: nothing.
    assert.deepEqual(handle(input, { ...env, HERDR_PANE_ID: WORKER, JOB_AGENT_ROLE: "worker" }), { stdout: "" })

    const r = handle(input, env)
    const context = JSON.parse(r.stdout).hookSpecificOutput
    assert.equal(context.hookEventName, "SessionStart")
    assert.match(context.additionalContext, /\[board answer\] card <id> .*the user pressed that button/)
    assert.match(context.additionalContext, /inbox ack <id>/)
    assert.match(context.additionalContext, /2 not acked yet are being posted now/)
    assert.equal(r.replay.note.session_id, "sess-9")
    assert.equal(coordinatorNoteFor(s.file, COORD).socket, live.path)
    // A compaction: same session, no replay.
    assert.equal(sessionStart(s.file, { ...input, source: "compact" }, env).replay, null)

    const done = await replayInbox(r.replay.file, r.replay.note)
    assert.deepEqual(done, { sent: 2, error: "" })
    await until(() => live.got.length === 1)
    assert.deepEqual(live.texts()[0].split("\n").slice(1), [socketText(a), socketText(b)])
    assert.equal(readPosts(s.file)[a.id].session, "sess-9")
    await live.close()

    // The real hook, end to end: its background replay waits for the socket to listen.
    rmSync(s.sock(), { force: true })
    const later = spawnSync(process.execPath, [HOOK], { cwd: s.base, env: { ...env, JOB_BOARD_REPLAY_DELAY_MS: "0" }, input: JSON.stringify(input), encoding: "utf8" })
    assert.equal(later.status, 0, later.stderr)
    assert.match(later.stdout, /SessionStart/)
    await new Promise((d) => setTimeout(d, 300))
    const again = await fakeSession(s.sock())
    await until(() => again.got.length === 1)
    assert.match(again.texts()[0], /^\[board inbox\] 2 messages not acked yet/)
    await again.close()
  } finally {
    s.done()
  }
})

test("re-post: unacked 10 minutes after the last post, twice at most per session, one batch, once across several panes", async () => {
  const s = setup()
  try {
    const live = await fakeSession(s.sock())
    s.note()
    const t0 = Date.now()
    const a = s.message("[job finished] fix-x — done — one")
    const b = s.message("[job note] fix-x — two", { kind: "note" })
    // A first post: nothing due for 10 minutes.
    assert.equal(await postInbox(s.file, [a, b]), 2)
    await until(() => live.got.length === 1)
    assert.match(live.texts()[0], /^\[board inbox\] 2 messages not acked yet/)
    assert.equal(await repostDue(s.file, { now: new Date(t0 + REPOST_AFTER_MS - 5000) }), 0)
    // Due: two board panes at once post it once, in one batch.
    const at1 = new Date(t0 + REPOST_AFTER_MS + 1000)
    const [x, y] = await Promise.all([repostDue(s.file, { now: at1 }), repostDue(s.file, { now: at1 })])
    assert.equal(x + y, 2)
    await until(() => live.got.length === 2)
    assert.match(live.texts()[1], /^\[board inbox\] 2 messages not acked yet/)
    assert.equal(readPosts(s.file)[a.id].n, 1)
    // Acked: not again.
    spawnSync(process.execPath, [BOARD, "inbox", "ack", b.id], { cwd: s.base, env: s.coordEnv })
    const at2 = new Date(at1.getTime() + REPOST_AFTER_MS + 1000)
    assert.equal(await repostDue(s.file, { now: at2 }), 1)
    await until(() => live.got.length === 3)
    assert.equal(live.texts()[2], socketText(a))
    // Twice at most in this session.
    assert.equal(await repostDue(s.file, { now: new Date(at2.getTime() + 2 * REPOST_AFTER_MS) }), 0)
    // A new session (a restart) counts again.
    s.note(live.path, { sessionId: "sess-2" })
    assert.equal(await repostDue(s.file, { now: new Date(at2.getTime() + 2 * REPOST_AFTER_MS) }), 1)
    // channel or prompt: never.
    assert.equal(await repostDue(s.file, { env: { JOB_BOARD_DELIVERY: "channel" }, now: new Date(at2.getTime() + 9 * REPOST_AFTER_MS) }), 0)
    await live.close()
  } finally {
    s.done()
  }
})

test("the turn-start reminder: no inbox wait asked for while a coordinator note is live; ack with the CLI", async () => {
  const s = setup()
  try {
    s.message("[job finished] fix-x — done — one")
    let text = inboxReminder(s.file, { workspace: "w1", env: {} })
    assert.match(text, /No inbox watcher is running/)
    const live = await fakeSession(s.sock())
    s.note()
    text = inboxReminder(s.file, { workspace: "w1", env: {} })
    assert.doesNotMatch(text, /inbox watcher|inbox wait/)
    assert.match(text, /board\.mjs" inbox ack <id>… \(or --all\)/)
    // With a channel too: still the CLI (it acks the same inbox).
    s.channel()
    assert.match(inboxReminder(s.file, { workspace: "w1", env: {} }), /inbox ack <id>/)
    // The coordinator set to channel: the note isn't its way; the channel's ack tool, as in 0.9.0.
    assert.match(inboxReminder(s.file, { workspace: "w1", env: { JOB_BOARD_DELIVERY: "channel" } }), /the job-board channel's ack tool/)
    await live.close()
  } finally {
    s.done()
  }
})
