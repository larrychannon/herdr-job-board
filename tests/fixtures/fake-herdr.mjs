#!/usr/bin/env node
// A stand-in for the `herdr` CLI in the board tests (HERDR_BIN_PATH points here). It keeps its
// state in the JSON file $FAKE_HERDR_STATE: { agents, panes, log }, logs every call, and answers
// only the commands board.mjs uses.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

// The pane runs several herdr calls at once: each call holds a lock while it reads, logs and
// writes the state, and writes it with a temp file and a rename.
const file = process.env.FAKE_HERDR_STATE
const lock = `${file}.lock`
for (let i = 0; ; i++) {
  try {
    mkdirSync(lock)
    break
  } catch {
    if (i > 500) rmSync(lock, { recursive: true, force: true })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
process.on("exit", () => rmSync(lock, { recursive: true, force: true }))
const state = JSON.parse(readFileSync(file, "utf8"))
state.panes ||= []
state.log ||= []
const args = process.argv.slice(2)
state.log.push(args)
const save = () => {
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${file}.${process.pid}.tmp`, file)
}
const ok = (result) => {
  save()
  process.stdout.write(JSON.stringify({ id: "fake", result }))
  process.exit(0)
}
const fail = (message, code = "fake_error") => {
  save()
  process.stderr.write(JSON.stringify({ error: { code, message } }))
  process.exit(1)
}
const flag = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const pane = (id) => state.panes.find((p) => p.pane_id === id)

if (args[0] === "--version") {
  save()
  process.stdout.write(`herdr ${state.version || "0.9.3"}\n`)
  process.exit(0)
}
const [group, command, target] = args
const key = `${group} ${command}`
// FAKE_HERDR_DELAY_MS slows `agent prompt` down, to test presses that overlap a send.
if (key === "agent prompt" && process.env.FAKE_HERDR_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_HERDR_DELAY_MS))
if (key === "agent list") ok({ agents: state.agents || [], type: "agent_list" })
if (key === "workspace report-metadata") ok({ type: "ok" })
if (key === "pane get") pane(target) ? ok({ pane: pane(target), type: "pane_info" }) : fail(`pane ${target} not found`)
if (key === "tab list") ok({ tabs: (state.tabs || []).filter((t) => t.workspace_id === flag("--workspace")), type: "tab_list" })
if (key === "pane list") ok({ panes: state.panes.filter((p) => p.workspace_id === flag("--workspace")), type: "pane_list" })
if (key === "pane split") {
  const from = pane(flag("--pane"))
  if (!from) fail("no such pane")
  const id = `${from.workspace_id}:p${state.panes.length + 100}`
  state.panes.push({ pane_id: id, tab_id: from.tab_id, workspace_id: from.workspace_id, cwd: flag("--cwd") })
  ok({ pane: pane(id), type: "pane_info" })
}
if (key === "pane rename") {
  pane(target).label = args[3]
  ok({ type: "ok" })
}
if (key === "pane run") {
  // refuse_run: Herdr fails the command (a pane-restart that can't start the new board).
  if (pane(target)?.refuse_run) fail(`pane ${target} refused the command`)
  // run_becomes: what runs there after the command instead of it (null: the shell again, e.g. a
  // board that exits at once; text: something slow that isn't a board yet).
  if (pane(target) && "run_becomes" in pane(target)) {
    if (pane(target).run_becomes == null) delete pane(target).running
    else pane(target).running = pane(target).run_becomes
  } else pane(target).running = args[3]
  // run_then: what process-info shows from then on, one entry a call (see `next`).
  if (pane(target)?.run_then) pane(target).next = [...pane(target).run_then]
  ok({ type: "ok" })
}
if (key === "agent prompt" || key === "agent focus" || key === "agent get") {
  // A target is an agent's name or the pane that hosts it. Like Herdr 0.9.3, `agent prompt`
  // refuses a blocked agent first, then any agent `agent start` didn't start (interactive_ready).
  const host = (state.agents || []).find((a) => a.pane_id === target || (a.name && a.name === target))
  if (!host) fail(`agent target ${target} not found`, "agent_not_found")
  if (key === "agent get") ok({ agent: { agent: host.agent || "dummy", ...host }, type: "agent_info" })
  if (key === "agent prompt" && host.agent_status === "blocked") fail("agent is blocked", "agent_blocked")
  if (key === "agent prompt" && !host.interactive_ready) fail(`agent ${target} is not an active named agent`, "agent_not_ready")
  ok({ type: "ok" })
}
if (key === "pane send-keys") ok({ type: "ok" })
if (key === "workspace list") ok({ workspaces: [...new Set(state.panes.map((p) => p.workspace_id))].map((workspace_id) => ({ workspace_id })), type: "workspace_list" })
if (key === "plugin list") ok({ plugins: state.plugins || [], type: "plugin_list" })
if (key === "session list") {
  save()
  process.stdout.write(JSON.stringify({ sessions: state.sessions || [] }))
  process.exit(0)
}
if (key === "pane send-text") {
  // The board quits on "q".
  if (args[3] === "q" && pane(target)?.running?.includes("board-pane.mjs")) delete pane(target).running
  ok({ type: "ok" })
}
if (key === "pane process-info") {
  const p = pane(flag("--pane"))
  const argv = p?.running ? p.running.split(" ").map((a) => a.replace(/'/g, "")) : ["/bin/bash"]
  // `next`: what runs there from the next call on (null: a shell), for a pane that changes
  // between two looks (quit, or restarted by itself).
  if (p?.next?.length) {
    const n = p.next.shift()
    if (n) p.running = n
    else delete p.running
  }
  ok({ process_info: { foreground_processes: [{ argv, name: argv[0].split("/").pop() }] }, type: "pane_process_info" })
}
fail(`fake herdr: unsupported command: ${args.join(" ")}`)
