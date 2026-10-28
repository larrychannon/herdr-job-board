// The inbox socket against a real Claude Code session (opt-in: JOB_BOARD_SMOKE=1). The wire
// format (board.mjs wireLines) is Claude Code's own and undocumented, so run this after every
// `claude update`:
//
//   S=$(mktemp -d /tmp/jb.XXXX); HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp \
//     JOB_BOARD_SMOKE=1 node --test tests/socket-smoke.test.mjs
//
// It starts one throw-away `claude -p` (Haiku; JOB_BOARD_SMOKE_MODEL for another) in a scratch
// folder, with only the project's settings (none) and one SessionStart hook, the board's own,
// pointed at a scratch board. The session is kept busy with a few `sleep` calls while:
// 1. the hook notes the session's socket and replays the scratch inbox's unacked message into it;
// 2. this test posts a "[board answer] …" line into the same socket.
// The session must answer with both code words. It runs with your real HOME (Claude Code needs
// its login) but touches no board there: every board file is in the scratch folder, and no
// HERDR_* or CLAUDE_CODE_MESSAGING_* of this shell reaches it. Tested with Claude Code
// SOCKET_TESTED_WITH.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { appendInbox, coordinatorNotes, emptyBoard, inboxMessage, postToSession, readPosts, SOCKET_TESTED_WITH, unacked } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const HOOK = join(ROOT, "hooks", "board-hook.mjs")
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
const on = process.env.JOB_BOARD_SMOKE === "1"

test(`a real claude -p session (tested with ${SOCKET_TESTED_WITH}) gets the SessionStart replay and a posted [board answer]`, { skip: on ? false : "opt-in: JOB_BOARD_SMOKE=1", timeout: 240_000 }, async () => {
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown"
  const base = realpathSync(mkdtempSync(join(tmpdir(), "smoke-")))
  const store = join(base, "store")
  mkdirSync(store)
  const work = join(base, "work")
  mkdirSync(work)
  spawnSync("git", ["-C", work, "init", "-q"])
  const fake = join(base, "herdr.json")
  spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(fake)}, JSON.stringify({ agents: [] }))`])
  const workspace = "smoke"
  const pane = "smoke:p1"
  const boardEnv = { ...process.env, JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_WORKSPACE_ID: workspace, HERDR_PANE_ID: pane }
  let child = null
  try {
    // A scratch board with one unacked job message for the workspace.
    const add = spawnSync(process.execPath, [BOARD, "add", "doing", "Smoke: the inbox socket"], { cwd: work, env: boardEnv, encoding: "utf8" })
    assert.equal(add.status, 0, add.stderr)
    const file = join(store, "board.json")
    const words = [`TANGERINE-${process.pid}`, `JUNIPER-${Date.now() % 100000}`]
    const replayed = inboxMessage(emptyBoard(), null, { slug: "smoke", kind: "note", text: `[job note] smoke — the first code word is ${words[0]}`, workspace })
    appendInbox(file, [replayed])

    // The session: Claude Code's login needs the real HOME; nothing else of this shell's.
    // JOB_BOARD_DELIVERY=socket: what a coordinator's start script exports, so the hook registers.
    const env = { ...boardEnv, HOME: userInfo().homedir, JOB_BOARD_DELIVERY: "socket", JOB_BOARD_REPLAY_DELAY_MS: "500" }
    delete env.JOB_BOARD_TEST_SANDBOX
    delete env.TMPDIR
    const settings = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(HOOK)}`, timeout: 10 }] }] } }
    const prompt =
      "Run the Bash command `sleep 4` five times, one call at a time, nothing else. Other sessions will send you messages meanwhile; " +
      "each holds a code word (an uppercase word, a dash and digits). When the sleeps are done, reply with only the code words you received, space-separated, or NONE."
    let stdout = ""
    let stderr = ""
    child = spawn("claude", ["-p", prompt, "--model", process.env.JOB_BOARD_SMOKE_MODEL || "haiku", "--setting-sources", "project", "--settings", JSON.stringify(settings), "--allowedTools", "Bash(sleep *)"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const exited = new Promise((done) => child.on("exit", (code) => done(code)))

    // 1. The hook's note: this session's socket.
    let note = null
    for (let i = 0; i < 120 && !note; i++) {
      note = coordinatorNotes(file).find((n) => n.pane === pane) || null
      if (!note) await new Promise((d) => setTimeout(d, 250))
    }
    assert.ok(note, `no coordinator note from the SessionStart hook (stderr: ${stderr})`)
    assert.equal(note.workspace, workspace)
    // 2. Post the answer into it. The socket is outside the test sandbox: allowed for this one
    // socket's folder, the one the scratch board's note names.
    for (let i = 0; i < 40 && !existsSync(note.socket); i++) await new Promise((d) => setTimeout(d, 250))
    await new Promise((d) => setTimeout(d, 2000))
    const sandbox = process.env.JOB_BOARD_TEST_SANDBOX
    process.env.JOB_BOARD_TEST_SANDBOX = `${sandbox}:${dirname(note.socket)}`
    let posted
    try {
      posted = await postToSession(note.socket, `[board answer] card 1 (smoke · Smoke: the inbox socket): the second code word is ${words[1]} #smoke1`, { msgId: "smoke1" })
    } finally {
      process.env.JOB_BOARD_TEST_SANDBOX = sandbox
    }
    assert.deepEqual(posted, { ok: true, error: "", code: "" })

    const code = await exited
    child = null
    assert.equal(code, 0, stderr)
    // The replay was recorded, and stays unacked (nobody acked it).
    assert.equal(readPosts(file)[replayed.id]?.session, note.session_id)
    assert.equal(unacked(file).length, 1)
    for (const word of words) assert.match(stdout, new RegExp(word), `claude ${version} answered: ${stdout.trim()}`)
    process.stderr.write(`socket smoke: claude ${version} got both posts: ${stdout.trim()}\n`)
  } finally {
    child?.kill("SIGTERM")
    if (existsSync(base)) rmSync(base, { recursive: true, force: true })
  }
})
