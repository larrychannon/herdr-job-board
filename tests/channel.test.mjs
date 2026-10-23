// The job-board channel (0.9.0): channels/<pid>.json notes, a button's answer into the inbox
// for a pane with a live channel (typed in as before without one), the turn-start reminder, and
// the Go binary (channel/) against the same inbox: what it pushes, what its ack writes.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answerMessage, CHANNEL_FRESH_MS, channelFor, channelNotes, createAnswerer, deliver, INBOX_KINDS, readBoard, readInbox, unacked } from "../board.mjs"
import { inboxReminder } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const CHANNEL = join(ROOT, "channel")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const COORD = "w1:p1"
const OTHER = "w1:p9"
const T0 = "2026-10-23T10:00:00.000Z"

/** A scratch store with a fake Herdr (a coordinator pane, COORD) and a Waiting card with buttons. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-channel-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(base, "store")
  mkdirSync(store)
  const fake = join(base, "herdr.json")
  writeFileSync(fake, JSON.stringify({ agents: [{ pane_id: COORD, name: "", agent_status: "idle", interactive_ready: true, workspace_id: "w1", cwd: base }] }))
  const common = { ...process.env, HOME: base, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_WORKSPACE_ID: "w1", TZ: "UTC", NO_COLOR: "1", JOB_BOARD_NOW: T0 }
  const coordEnv = { ...common, HERDR_PANE_ID: COORD }
  const otherEnv = { ...common, HERDR_PANE_ID: OTHER }
  const board = (env, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
  const r = board(coordEnv, "add", "waiting", "Card 304: pick a path", "--ask", "Which?", "--option", "Channel", "--option", "Fallback")
  assert.equal(r.status, 0, r.stderr)
  const file = join(store, "board.json")
  const id = readBoard(file).items[0].id
  const prompts = () => (JSON.parse(readFileSync(fake, "utf8")).log || []).filter((a) => a[0] === "agent" && a[1] === "prompt")
  const note = (fields = {}) => {
    mkdirSync(join(store, "channels"), { recursive: true })
    const n = { pid: process.pid, host: hostname(), at: new Date().toISOString(), started: T0, pane: COORD, workspace: "w1", version: "0.9.0", ...fields }
    writeFileSync(join(store, "channels", `${n.pid}.json`), JSON.stringify(n))
    return n
  }
  return { base, store, file, id, fake, coordEnv, otherEnv, board, prompts, note, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("channelNotes: a live note counts; a dead process's note goes; an old one doesn't count", () => {
  const s = setup()
  try {
    assert.deepEqual(channelNotes(s.file), [])
    s.note()
    assert.equal(channelNotes(s.file).length, 1)
    assert.equal(channelFor(s.file, COORD)?.pane, COORD)
    assert.equal(channelFor(s.file, OTHER), null)
    assert.equal(channelNotes(s.file, { workspace: "w2" }).length, 0)
    assert.equal(channelNotes(s.file, { workspace: "w1" }).length, 1)
    // Not renewed for CHANNEL_FRESH_MS: not live (its process may hang), but its note stays.
    s.note({ at: new Date(Date.now() - CHANNEL_FRESH_MS - 1000).toISOString() })
    assert.equal(channelFor(s.file, COORD), null)
    assert.ok(existsSync(join(s.store, "channels", `${process.pid}.json`)))
    // A process that is gone: its note is removed.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
    const pid = Number(dead.stdout)
    s.note({ pid })
    assert.equal(channelNotes(s.file).length, 0)
    assert.ok(!existsSync(join(s.store, "channels", `${pid}.json`)))
    // Another host's note is left alone, and doesn't count here.
    s.note({ pid: 4242, host: "elsewhere" })
    assert.equal(channelNotes(s.file).length, 0)
    assert.ok(existsSync(join(s.store, "channels", "4242.json")))
  } finally {
    s.done()
  }
})

test("answer: into the inbox for a pane with a live channel (nothing typed), typed in without one", () => {
  const s = setup()
  try {
    assert.ok(INBOX_KINDS.includes("answer"))
    s.note()
    const r = s.board(s.otherEnv, "answer", String(s.id), "1")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /its job-board channel\): Channel$/m)
    assert.deepEqual(s.prompts(), [])
    const [m] = unacked(s.file)
    assert.deepEqual([m.kind, m.card, m.to, m.label, m.workspace], ["answer", s.id, COORD, "Channel", "w1"])
    assert.match(m.text, new RegExp(`^Board card ${s.id} \\(.*Card 304: pick a path\\): Channel$`))
    assert.equal(readBoard(s.file).items[0].sent.label, "Channel")
    // No channel (its note gone): typed in, as before 0.9.0, and no new inbox message.
    rmSync(join(s.store, "channels"), { recursive: true, force: true })
    const again = s.board(s.otherEnv, "answer", String(s.id), "Fallback")
    assert.equal(again.status, 0, again.stderr)
    assert.equal(s.prompts().length, 1)
    assert.equal(s.prompts()[0][2], COORD)
    assert.equal(readInbox(s.file).messages.length, 1)
  } finally {
    s.done()
  }
})

test("a button press: the pane's answerer sends through the channel when the pane has one", async () => {
  const s = setup()
  try {
    s.note()
    const env = { ...s.coordEnv }
    const answers = createAnswerer({ file: s.file, origin: COORD, env, now: () => new Date(T0), agents: () => null })
    await answers.press({ type: "send", id: s.id, label: "Fallback", key: `${s.id}:1` })
    assert.deepEqual(s.prompts(), [])
    const [m] = unacked(s.file)
    assert.deepEqual([m.kind, m.label, m.to], ["answer", "Fallback", COORD])
    assert.equal(readBoard(s.file).items[0].sent.label, "Fallback")
    assert.equal(answers.notes[`${s.id}:1`], undefined)
    // deliver itself: the channel when there is one, Herdr when not.
    const item = readBoard(s.file).items[0]
    assert.equal(await deliver({ type: "send", label: "Channel" }, item, COORD, env, s.file), null)
    assert.equal(unacked(s.file).length, 2)
    // OTHER has no channel: typed in (the fake Herdr knows no agent there, so it fails as Herdr would).
    assert.equal(await deliver({ type: "send", label: "Channel" }, item, OTHER, env, s.file), "coordinator pane not found")
    assert.deepEqual(s.prompts().map((p) => p[2]), [OTHER])
    // Other… only focuses the pane, channel or not.
    assert.equal(await deliver({ type: "other" }, item, COORD, env, s.file), null)
    assert.equal(s.prompts().length, 1)
  } finally {
    s.done()
  }
})

test("answerMessage: what goes into the inbox for a channel", () => {
  const m = answerMessage({ id: 7, project: "p", title: "Ship it?", tag: "p" }, "Go", { pane: COORD, workspace: "w1" }, { from: "telegram", at: new Date(T0) })
  assert.deepEqual([m.kind, m.card, m.to, m.label, m.workspace, m.from, m.at], ["answer", 7, COORD, "Go", "w1", "telegram", T0])
  assert.equal(m.text, "Board card 7 (p · Ship it?): Go (from Telegram)")
})

test("the turn-start reminder: with a live channel, no 'start inbox wait', and ack with its tool", () => {
  const s = setup()
  try {
    s.note()
    assert.equal(s.board(s.otherEnv, "answer", String(s.id), "1").status, 0)
    rmSync(join(s.store, "channels"), { recursive: true, force: true })
    assert.match(inboxReminder(s.file, { workspace: "w1" }), /No inbox watcher is running/)
    s.note()
    const text = inboxReminder(s.file, { workspace: "w1" })
    assert.doesNotMatch(text, /No inbox watcher/)
    assert.match(text, /the job-board channel's ack tool/)
  } finally {
    s.done()
  }
})

// --- the Go binary --------------------------------------------------------------------------

const go = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0
let built = ""
function binary() {
  if (built) return built
  const out = join(realpathSync(mkdtempSync(join(tmpdir(), "board-channel-bin-"))), "job-board-channel")
  const r = spawnSync("go", ["build", "-trimpath", "-o", out, "."], { cwd: CHANNEL, encoding: "utf8", env: { ...process.env, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" } })
  assert.equal(r.status, 0, r.stderr)
  built = out
  return out
}

/** The binary as Claude Code runs it: JSON-RPC lines on stdin and stdout. */
function startChannel(s, pane = COORD) {
  const child = spawn(binary(), [], { env: { PATH: process.env.PATH, HOME: s.base, JOB_BOARD_HOME: s.store, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: pane, JOB_BOARD_TEST_SANDBOX: process.env.JOB_BOARD_TEST_SANDBOX }, stdio: ["pipe", "pipe", "pipe"] })
  const lines = []
  let buf = ""
  child.stdout.on("data", (d) => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)))
      buf = buf.slice(i + 1)
    }
  })
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d))
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
  const events = () => lines.filter((l) => l.method === "notifications/claude/channel").map((l) => l.params)
  const reply = (id) => lines.find((l) => l.id === id)
  const stop = () => new Promise((done) => {
    child.on("exit", done)
    child.stdin.end()
  })
  return { child, send, events, reply, stop, stderr: () => stderr }
}

async function until(check, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail("timed out")
}

test("the Go channel: pushes what came while it was down, then each new message; ack writes the inbox", { skip: !go && "no Go toolchain" }, async () => {
  const s = setup()
  try {
    // An answer written before the channel runs: no channel yet, so it is typed in. Write one
    // straight into the inbox instead, as a job's hook would have.
    s.note()
    s.board(s.otherEnv, "answer", String(s.id), "Channel")
    rmSync(join(s.store, "channels"), { recursive: true, force: true })
    const c = startChannel(s)
    c.send({ id: 0, method: "server/discover" })
    c.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } })
    await until(() => c.reply(1))
    assert.equal(c.reply(0).error.code, -32601)
    const init = c.reply(1).result
    assert.equal(init.protocolVersion, "2025-11-25")
    assert.deepEqual(init.capabilities.experimental, { "claude/channel": {} })
    assert.match(init.instructions, /kind answer/)
    // Its note is there from the start (a button press now goes to the inbox).
    await until(() => channelFor(s.file, COORD))
    // Nothing is pushed before the session says it is initialized, and then after a moment.
    assert.deepEqual(c.events(), [])
    c.send({ method: "notifications/initialized" })
    await until(() => c.events().length === 1)
    const [first] = c.events()
    assert.equal(first.meta.kind, "answer")
    assert.equal(first.meta.card, String(s.id))
    assert.equal(first.meta.label, "Channel")
    assert.match(first.content, /: Channel$/)
    // A new message while it runs: pushed within a poll or two.
    const r = s.board(s.otherEnv, "answer", String(s.id), "Fallback")
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(s.prompts(), [])
    await until(() => c.events().length === 2)
    assert.equal(c.events()[1].meta.label, "Fallback")
    // A message for another workspace, or an answer for another live pane: not this one's.
    const other = { id: "zz1", at: T0, slug: "x", kind: "note", card: null, project: "", workspace: "w2", text: "[job note] x — elsewhere" }
    writeFileSync(join(s.store, "inbox.jsonl"), `${readFileSync(join(s.store, "inbox.jsonl"), "utf8")}${JSON.stringify(other)}\n`)
    // tools: inbox lists, ack acks.
    c.send({ id: 2, method: "tools/list" })
    await until(() => c.reply(2))
    assert.deepEqual(c.reply(2).result.tools.map((t) => t.name), ["ack", "inbox"])
    c.send({ id: 3, method: "tools/call", params: { name: "inbox", arguments: {} } })
    await until(() => c.reply(3))
    const listed = c.reply(3).result.content[0].text.split("\n")
    assert.equal(listed.length, 2)
    assert.match(listed[0], new RegExp(`#${first.meta.id}$`))
    c.send({ id: 4, method: "tools/call", params: { name: "ack", arguments: { ids: [first.meta.id, "nope"] } } })
    await until(() => c.reply(4))
    assert.match(c.reply(4).result.content[0].text, new RegExp(`acked #${first.meta.id}; no such message: #nope`))
    c.send({ id: 5, method: "tools/call", params: { name: "ack", arguments: { all: true } } })
    await until(() => c.reply(5))
    // The board's own reader agrees: nothing unacked for w1; w2's message untouched.
    assert.deepEqual(unacked(s.file, { workspace: "w1" }).map((m) => m.id), [])
    assert.deepEqual(unacked(s.file, { workspace: "w2" }).map((m) => m.id), ["zz1"])
    const acks = readFileSync(join(s.store, "inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.ack)
    assert.deepEqual(acks.map((a) => a.by), [COORD, COORD])
    assert.ok(!existsSync(join(s.store, "inbox.jsonl.lock")))
    // On its way out it removes its note.
    await c.stop()
    assert.deepEqual(readdirSync(join(s.store, "channels")), [])
  } finally {
    s.done()
  }
})

test("the Go channel: an answer for another pane's live channel isn't pushed here; once that one is gone, it is", { skip: !go && "no Go toolchain" }, async () => {
  const s = setup()
  try {
    // A live channel in OTHER (this test process stands in for it): the answer is OTHER's.
    s.note({ pane: OTHER })
    const msg = answerMessage({ id: s.id, project: "", title: "T" }, "Go", { pane: OTHER, workspace: "w1" }, { at: new Date(T0) })
    writeFileSync(join(s.store, "inbox.jsonl"), `${JSON.stringify(msg)}\n`)
    const c = startChannel(s, COORD)
    c.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    c.send({ method: "notifications/initialized" })
    await new Promise((done) => setTimeout(done, 2500))
    assert.deepEqual(c.events(), [])
    // OTHER's coordinator is gone (its note removed): the answer comes here.
    rmSync(join(s.store, "channels", `${process.pid}.json`))
    // The poll looks again when the inbox changes, or at the next beat; touch the inbox.
    writeFileSync(join(s.store, "inbox.jsonl"), `${JSON.stringify(msg)}\n\n`)
    await until(() => c.events().length === 1)
    assert.equal(c.events()[0].meta.id, msg.id)
    await c.stop()
  } finally {
    s.done()
  }
})

test("the Go channel: go test passes (its own unit tests)", { skip: !go && "no Go toolchain" }, () => {
  const r = spawnSync("go", ["test", "./..."], { cwd: CHANNEL, encoding: "utf8", env: { ...process.env, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" } })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})

test("the Go channel builds for macOS too (the board's other platform; compiled, not run)", { skip: !go && "no Go toolchain" }, () => {
  for (const arch of ["arm64", "amd64"]) {
    const r = spawnSync("go", ["build", "-o", "/dev/null", "."], { cwd: CHANNEL, encoding: "utf8", env: { ...process.env, CGO_ENABLED: "0", GOOS: "darwin", GOARCH: arch, GOFLAGS: "-mod=mod" } })
    assert.equal(r.status, 0, `darwin/${arch}: ${r.stderr}`)
  }
})

test("the channel plugin: its manifest and MCP entry, and the version everywhere is the same", () => {
  const manifest = JSON.parse(readFileSync(join(CHANNEL, ".claude-plugin", "plugin.json"), "utf8"))
  const mcp = JSON.parse(readFileSync(join(CHANNEL, ".mcp.json"), "utf8"))
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert.equal(manifest.name, "job-board")
  assert.deepEqual(mcp.mcpServers["job-board"], { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/run.sh"] })
  assert.equal(manifest.version, pkg.version)
  assert.match(readFileSync(join(CHANNEL, "main.go"), "utf8"), new RegExp(`const version = "${pkg.version.replace(/\./g, "\\.")}"`))
  assert.match(readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8"), new RegExp(`^version = "${pkg.version.replace(/\./g, "\\.")}"`, "m"))
})
