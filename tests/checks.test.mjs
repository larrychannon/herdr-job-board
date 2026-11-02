// Run: node --test (from the repo root)
// Checks that keep the user's view whole (0.16.0): `<command> --help` prints that command's
// usage; edit and move that change a card's question also say where it stands ("Now:" in the
// description, same call); a parent with no job or question of its own builds its status line
// from the cards under it, so it is never out of date; and the Stop hook's question check skips
// "Sources:" and "Memory read:" trailers, hears "waiting for your yes", and reads this turn's
// Telegram replies from the transcript.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { COMMAND_FLAGS, builtStatus, buildView, commandHelp, detailLines, readBoard, render } from "../board.mjs"
import { asksUser, blockReason, handle, questionOf, staleReminder, telegramReplies } from "../hooks/board-hook.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(ROOT, "board.mjs")
const PANE = "w1:p1"

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-checks-")))
  spawnSync("git", ["-C", base, "init", "-q"])
  const state = join(base, ".git", "board-state")
  const home = join(base, ".git", "home")
  const env = (now) => ({ ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: state, HOME: home, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" })
  const run = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
  const ok = (now, ...args) => {
    const r = run(now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(state, "board.json")
  const item = (id) => readBoard(file).items.find((i) => i.id === id)
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex")
  const own = (...ids) => {
    const s = JSON.parse(readFileSync(file, "utf8"))
    for (const i of s.items) if (ids.includes(i.id)) i.origin = PANE
    writeFileSync(file, JSON.stringify(s))
  }
  return { base, state, file, run, ok, item, hash, own, done: () => rmSync(base, { recursive: true, force: true }) }
}

const T = "2026-11-02T10:00:00Z"

// --- per-command help ----------------------------------------------------------------------------

test("<command> --help prints that command's usage and flags, for every command; help <command> too", () => {
  const t = setup()
  try {
    for (const command of Object.keys(COMMAND_FLAGS)) {
      const r = t.run(T, command, "--help")
      assert.equal(r.status, 0, `${command} --help: ${r.stderr}`)
      assert.match(r.stdout, new RegExp(`^  ${command.replace(/[-]/g, "\\-")}\\b`, "m"), `${command} --help names it`)
      assert.match(r.stdout, new RegExp(`^${command.replace(/[-]/g, "\\-")} takes`, "m"))
    }
    const edit = t.run(T, "edit", "--help").stdout
    assert.match(edit, /^ {2}edit <ref> \[--title T\]/m)
    assert.match(edit, /--clear-options/)
    assert.match(edit, /line that starts "Now:"/, "the question rule is in edit's help")
    assert.match(edit, /never only in the chat/, "and the command-on-the-card rule")
    assert.doesNotMatch(edit, /^ {2}add </m, "no other command's lines")
    assert.equal(t.run(T, "help", "edit").stdout, edit)
    const move = t.run(T, "move", "--help").stdout
    assert.match(move, /^ {2}move <ref> <column>/m)
    assert.match(move, /line that starts "Now:"/, "the question rule is in move's help too")
    assert.match(move, /a command\s+the user must run goes on the card/)
    assert.doesNotMatch(move, /^ {2}edit </m)
    assert.equal(commandHelp("edit"), edit.trimEnd())
    // A command with several entries gets them all, and only its own: inbox, not inbox's neighbours.
    const inbox = t.run(T, "inbox", "--help").stdout
    for (const sub of ["wait", "ls", "ack", "get"]) assert.match(inbox, new RegExp(`^ {2}inbox ${sub}\\b`, "m"))
    assert.doesNotMatch(inbox, /^ {2}front\b/m)
    // project is not projects.
    assert.doesNotMatch(t.run(T, "project", "--help").stdout, /^ {2}projects\b/m)
    // Bare --help: the whole list, exit 0 (no command at all is still exit 2).
    const all = t.run(T, "--help")
    assert.equal(all.status, 0)
    assert.match(all.stdout, /^ {2}add <column>/m)
    assert.equal(t.run(T, "help", "--help").status, 0)
    assert.equal(t.run(T).status, 2)
    // An unknown command: exit 2, and nothing written.
    const bad = t.run(T, "nosuch", "--help")
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /unknown command nosuch/)
    // --help as a flag's value is that value, not a request for help.
    t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops.")
    t.ok(T, "edit", "1", "--desc", "--help")
    assert.equal(t.item(1).desc, "--help")
  } finally {
    t.done()
  }
})

// --- a new question says where it stands ---------------------------------------------------------

test("edit and move that change the question need a 'Now:' line in --desc, in the same call; nothing is written otherwise", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Login page: fix the redirect", "--desc", "It loops after sign-in.")
    const before = t.hash()
    // edit --ask alone: refused, exit 2, the board as it was.
    let r = t.run(T, "edit", "1", "--ask", "Fix it before the release?")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /card 1: a new question needs its explanation in the same call, so nothing was written/)
    assert.match(r.stderr, /line that starts "Now:"/)
    assert.match(r.stderr, /A command the user must run \(a line starting "! ", or a code line\) goes on the card too/)
    assert.equal(t.hash(), before)
    // A description without a "Now:" line, or with "Now:" only mid-line: refused too.
    assert.equal(t.run(T, "edit", "1", "--ask", "Fix it before the release?", "--desc", "It loops after sign-in.").status, 2)
    assert.equal(t.run(T, "edit", "1", "--ask", "Fix it before the release?", "--desc", "It loops. Now: ready.").status, 2)
    // --allow-wording is for the word check, not this one.
    assert.equal(t.run(T, "edit", "1", "--ask", "Fix it before the release?", "--allow-wording").status, 2)
    assert.equal(t.hash(), before)

    // With the line: written. Markdown around "Now:" is fine.
    t.ok(T, "edit", "1", "--ask", "Fix it before the release?", "--desc", "It loops after sign-in.\n**Now:** the fix is ready; yes ships it with the release.")
    assert.equal(t.item(1).ask, "Fix it before the release?")
    assert.match(t.item(1).desc, /Now:\*\* the fix is ready/)
    // A literal \n (a shell's one-line --desc) is a line break there too.
    t.ok(T, "edit", "1", "--ask", "Ship the fix today?", "--desc", "It loops after sign-in.\\nNow: the fix is ready.")
    assert.equal(t.item(1).desc, "It loops after sign-in.\nNow: the fix is ready.")
    t.ok(T, "edit", "1", "--ask", "Fix it before the release?", "--desc", "It loops after sign-in.\nNow: the fix is ready; yes ships it with the release.")
    // The same question again, or clearing it, asks nothing new.
    t.ok(T, "edit", "1", "--ask", "Fix it before the release?")
    t.ok(T, "edit", "1", "--title", "Login page: fix the redirect first")
    t.ok(T, "edit", "1", "--ask", "")
    assert.equal(t.item(1).ask, "")

    // move … waiting --ask: the same rule, before the word check.
    t.ok(T, "add", "todo", "Docs: tidy the old pages", "--desc", "Old pages.")
    const moved = t.hash()
    r = t.run(T, "move", "2", "waiting", "--ask", "Tidy the docs now?")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /card 2: a new question needs its explanation/)
    assert.equal(t.hash(), moved)
    assert.equal(t.item(2).column, "todo")
    // With the line it reaches the word check (no buttons: refused there, for its own reason).
    r = t.run(T, "move", "2", "waiting", "--ask", "Tidy the docs now?", "--desc", "Old pages.\nNow: nothing started; yes starts a job.")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no answer buttons/)
    assert.doesNotMatch(r.stderr, /needs its explanation/)
    // A move with no new question is untouched by it.
    t.ok(T, "move", "2", "doing")
  } finally {
    t.done()
  }
})

// --- a parent's status line built from its cards ------------------------------------------------

/** 1 Release (no job) ← 2 check (job), 3 fix (job), 4 docs; 5 apart. */
function family(t) {
  t.ok(T, "add", "doing", "Login fix: release", "--desc", "Ship the login fix.")
  t.ok(T, "add", "doing", "Login fix: check", "--parent", "1", "--job", "login-check", "--desc", "A fresh check.")
  t.ok(T, "add", "doing", "Login fix: fix the redirect", "--parent", "1", "--job", "login-redirect", "--desc", "The loop.")
  t.ok(T, "add", "todo", "Login fix docs: write", "--parent", "1", "--desc", "The help page.")
  t.ok(T, "add", "todo", "Export to CSV", "--desc", "Another thing.")
}

test("a parent with no job or question of its own shows a line built from its cards, never out of date", () => {
  const t = setup()
  try {
    family(t)
    const now = new Date("2026-11-02T10:05:00Z")
    // No line written yet: the parent keeps its "Waiting on: …" list alone.
    assert.equal(builtStatus(readBoard(t.file), t.item(1)), "")
    // A line written on a card under it goes up to it (now writes the lineage) …
    t.ok("2026-11-02T10:01:00Z", "now", "2", "the check is running")
    assert.equal(t.item(1).now.text, "the check is running")
    // … and the parent shows the line built from its cards instead.
    let state = readBoard(t.file)
    assert.equal(builtStatus(state, t.item(1)), "#2 doing · #3 doing · #4 to do")
    const agents = [{ name: "login-check", agent_status: "working", workspace_id: "", pane_id: "w1:p2" }, { name: "login-redirect", agent_status: "blocked", workspace_id: "", pane_id: "w1:p3" }]
    let view = buildView(state, agents, { now })
    let one = view.doing.find((e) => e.id === 1)
    assert.equal(one.now.text, "#2 working · #3 waiting on you · #4 to do")
    assert.equal(one.stale, false)
    const details = detailLines(one, 100, { now }).lines.map((l) => l.map((s) => s.t ?? "").join("")).join("\n")
    assert.match(details, /Now: #2 working · #3 waiting on you · #4 to do/)

    // An event under it (a card done) would put a written line out of date: not this one.
    t.ok("2026-11-02T10:02:00Z", "done", "4")
    state = readBoard(t.file)
    assert.equal(builtStatus(state, t.item(1)), "#2 doing · #3 doing · 1 done")
    view = buildView(state, null, { now })
    one = view.doing.find((e) => e.id === 1)
    assert.equal(one.stale, false)
    assert.doesNotMatch(render(view, { width: 130, height: 30, color: false, now }), /status out of date|Now \(out of date/)
    // Its stored line is out of date by the old rule, but the built parent is never listed.
    assert.equal(t.item(1).now.text, "the check is running")
    assert.doesNotMatch(staleReminder(state), /#1 /)

    // `now` on the parent itself says its line is built, and keeps what was written.
    const r = t.ok("2026-11-02T10:03:00Z", "now", "1", "waiting for the check", "--only")
    assert.match(r.stderr, /#1 has no job or question of its own, so it shows the line built from the cards under it \("#2 doing · #3 doing · 1 done"\)/)
    assert.equal(t.item(1).now.text, "waiting for the check")

    // A parent with a job of its own writes its line as before.
    t.ok("2026-11-02T10:04:00Z", "edit", "1", "--job", "login-release")
    assert.equal(builtStatus(readBoard(t.file), t.item(1)), "")
    // Every card under it done: nothing to build from (the parent is ready to resume).
    t.ok("2026-11-02T10:04:00Z", "edit", "1", "--job", "")
    for (const id of ["2", "3"]) t.ok("2026-11-02T10:04:30Z", "done", id)
    assert.equal(builtStatus(readBoard(t.file), t.item(1)), "")
  } finally {
    t.done()
  }
})

test("a built line fits the status line's length: the first cards, then '+N more'", () => {
  const items = [{ id: 1, title: "Big: release", column: "doing", now: { text: "x", at: T } }]
  for (let id = 2; id < 60; id++) items.push({ id, title: `Part ${id}: do`, column: "todo", parent: 1 })
  const line = builtStatus({ items }, items[0])
  assert.ok(line.length <= 200, line)
  assert.match(line, /^#2 to do · #3 to do · .* · \+\d+ more$/)
})

test("Stop and the turn reminder skip a parent whose line is built; a parent with a job is still asked", () => {
  const t = setup()
  try {
    family(t)
    t.ok("2026-11-02T10:01:00Z", "now", "2", "the check is running")
    t.own(1, 2, 3, 4)
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: PANE, JOB_BOARD_HOME: t.state, HOME: join(t.base, ".git", "home") }
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.base, prompt: "hi" }
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: t.base, stop_hook_active: false, last_assistant_message: "Done. Tests pass." }
    handle(prompt, env)
    // The docs card done: an event on #1 (built: skipped) and on #1's lineage only, not #2 (a sibling).
    t.ok("2026-11-02T10:02:00Z", "done", "4")
    assert.equal(staleReminder(readBoard(t.file)), "")
    assert.equal(handle(stop, env).stdout, "", "nothing to ask: the parent's line is built")
    // With a job of its own the same parent is asked again.
    t.ok("2026-11-02T10:03:00Z", "edit", "1", "--job", "login-release")
    t.own(1)
    t.ok("2026-11-02T10:04:00Z", "done", "3")
    const r = JSON.parse(handle({ ...stop, session_id: "s2" }, env).stdout)
    assert.equal(r.decision, "block")
    assert.match(r.reason, /#1 "Login fix: release"/)
  } finally {
    t.done()
  }
})

// --- the question check: trailers, "waiting for your yes", Telegram -------------------------------

// The 1 Nov reply that slipped through: the question went out on Telegram, the chat ended with
// "I'm waiting for your yes", then a Sources list and the Memory line.
const NOV_1 =
  "The bug is a local privilege escalation in the kernel's networking code. Several security sites describe it; the fixed versions differ by branch.\n\n" +
  "I offered to open a read-only job to check our exposure, and I'm waiting for your yes.\n\n" +
  "Sources:\n- [Kernel advisory](https://example.com/advisory)\n- [Distro tracker](https://example.com/tracker)\n\n" +
  "Memory read: SessionStart digest; memory not updated."

test("asksUser: trailing Sources and Memory read paragraphs are skipped; 'waiting for your yes / OK / pick' asks", () => {
  assert.equal(asksUser(NOV_1), true)
  const yes = [
    "Built.\n\nShip the fix now?\n\nSources:\n\n- [a](https://a.test)\n- [b](https://b.test)\n\nMemory read: digest.",
    "Built.\n\nWant me to merge it.\n\n**Sources:**\n- https://a.test\n\n**Memory read:** digest; not updated.",
    "Built.\n\nMerge it?\n\n## Sources\n\n1. https://a.test",
    "Ready. Waiting for your OK to deploy.",
    "Three ways to go, listed on the card. I'll wait for your pick.",
    "The draft is up. Your yes is still pending.",
  ]
  const no = [
    "Deployed and verified.\n\nSources:\n- [Why does it fail?](https://a.test)\n\nMemory read: digest.",
    "Done. The job is waiting for its tests.",
    "Merged. I waited for your OK earlier and got it.",
    "Sources: the kernel's own record.\n\nMemory read: digest.",
  ]
  for (const text of yes) assert.equal(asksUser(text), true, text)
  for (const text of no) assert.equal(asksUser(text), false, text)
  // A worker's "[job waiting]" line quotes the question, not the Memory line.
  assert.equal(questionOf("Built.\n\nShip the fix now?\n\nMemory read: digest; not updated."), "Ship the fix now?")
})

const line = (o) => JSON.stringify(o)
const user = (text) => line({ type: "user", message: { role: "user", content: text } })
const toolResult = () => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sent" }] } })
const assistant = (...content) => line({ type: "assistant", message: { role: "assistant", content } })
const telegram = (text) => ({ type: "tool_use", id: "t1", name: "mcp__plugin_telegram_telegram__reply", input: { chat_id: "1", text } })

test("telegramReplies: this turn's Telegram reply texts, after the transcript's last prompt", () => {
  const t = setup()
  try {
    const path = join(t.base, "transcript.jsonl")
    const last = assistant(telegram("Want me to put a check of our exposure on the board as a read-only job?"))
    writeFileSync(
      path,
      [
        user("first question"),
        assistant(telegram("An old turn: want me to deploy it?")),
        toolResult(),
        user('<channel source="telegram">What is it?</channel>'),
        assistant({ type: "text", text: "Looking." }, { type: "tool_use", id: "t0", name: "WebSearch", input: { query: "x" } }),
        toolResult(),
        line({ type: "user", isMeta: true, message: { role: "user", content: "a meta line" } }),
        assistant(telegram("It is a kernel bug.")),
        toolResult(),
        last,
        "not json",
        "",
      ].join("\n"),
    )
    assert.deepEqual(telegramReplies(path), ["It is a kernel bug.", "Want me to put a check of our exposure on the board as a read-only job?"])
    // Only the file's end is read: the line cut in the middle (a tool result here) is skipped, not misread.
    assert.deepEqual(telegramReplies(path, { maxBytes: Buffer.byteLength(`${last}\nnot json\n`) + 10 }), ["Want me to put a check of our exposure on the board as a read-only job?"])
    assert.deepEqual(telegramReplies(join(t.base, "missing.jsonl")), [])
    assert.deepEqual(telegramReplies(undefined), [])
  } finally {
    t.done()
  }
})

test("Stop: a question sent on Telegram this turn needs a Waiting card too; an older turn's doesn't count", () => {
  const t = setup()
  try {
    t.ok(T, "add", "todo", "Kernel bug: check our exposure", "--desc", "A local privilege escalation.")
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: PANE, JOB_BOARD_HOME: t.state, HOME: join(t.base, ".git", "home") }
    const path = join(t.base, "transcript.jsonl")
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.base, prompt: "hi" }
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: t.base, stop_hook_active: false, transcript_path: path, last_assistant_message: "Answered on Telegram. Done." }

    // The chat reply asks nothing; the Telegram reply this turn does: blocked, once, saying where.
    writeFileSync(path, [user("<channel>What is it?</channel>"), assistant(telegram("Want me to put a check of our exposure on the board as a read-only job?")), toolResult()].join("\n"))
    handle(prompt, env)
    const first = JSON.parse(handle(stop, env).stdout)
    assert.equal(first.decision, "block")
    assert.equal(first.reason, blockReason(undefined, { telegram: true }))
    assert.match(first.reason, /^You asked the user something \(on Telegram\), but no Waiting card/)
    assert.equal(handle(stop, env).stdout, "", "once a turn")

    // A new turn: the question was in the turn before; this turn's Telegram reply asks nothing.
    writeFileSync(path, [user("<channel>What is it?</channel>"), assistant(telegram("Want me to check it?")), toolResult(), user("thanks"), assistant(telegram("You're welcome."))].join("\n"))
    handle(prompt, env)
    assert.equal(handle(stop, env).stdout, "")
    // No transcript, or an unreadable one: no block.
    handle(prompt, env)
    assert.equal(handle({ ...stop, transcript_path: join(t.base, "missing.jsonl") }, env).stdout, "")

    // The question asked on Telegram, with the Waiting card made this turn: passes.
    writeFileSync(path, [user("<channel>What is it?</channel>"), assistant(telegram("Want me to check our exposure?"))].join("\n"))
    handle(prompt, env)
    t.ok(T, "add", "waiting", "Kernel bug: check our exposure", "--desc", "A local privilege escalation.\nNow: nothing checked yet.")
    assert.equal(handle(stop, env).stdout, "")
  } finally {
    t.done()
  }
})
