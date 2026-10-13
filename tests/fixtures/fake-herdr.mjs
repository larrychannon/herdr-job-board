#!/usr/bin/env node
// A stand-in for the `herdr` CLI in the board tests (HERDR_BIN_PATH points here). It keeps its
// state in the JSON file $FAKE_HERDR_STATE: { agents, panes, log }, logs every call, and answers
// only the commands board.mjs uses.
import { readFileSync, writeFileSync } from "node:fs"

const file = process.env.FAKE_HERDR_STATE
const state = JSON.parse(readFileSync(file, "utf8"))
state.panes ||= []
state.log ||= []
const args = process.argv.slice(2)
state.log.push(args)
const save = () => writeFileSync(file, JSON.stringify(state, null, 2))
const ok = (result) => {
  save()
  process.stdout.write(JSON.stringify({ id: "fake", result }))
  process.exit(0)
}
const fail = (message) => {
  save()
  process.stderr.write(JSON.stringify({ error: { message } }))
  process.exit(1)
}
const flag = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const pane = (id) => state.panes.find((p) => p.pane_id === id)

const [group, command, target] = args
const key = `${group} ${command}`
if (key === "agent list") ok({ agents: state.agents || [], type: "agent_list" })
if (key === "workspace report-metadata") ok({ type: "ok" })
if (key === "pane get") pane(target) ? ok({ pane: pane(target), type: "pane_info" }) : fail(`pane ${target} not found`)
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
  pane(target).running = args[3]
  ok({ type: "ok" })
}
if (key === "pane send-text") {
  // The board quits on "q".
  if (args[3] === "q" && pane(target)?.running?.includes("board-pane.mjs")) delete pane(target).running
  ok({ type: "ok" })
}
if (key === "pane process-info") {
  const p = pane(flag("--pane"))
  const argv = p?.running ? p.running.split(" ").map((a) => a.replace(/'/g, "")) : ["/bin/bash"]
  ok({ process_info: { foreground_processes: [{ argv, name: argv[0].split("/").pop() }] }, type: "pane_process_info" })
}
fail(`fake herdr: unsupported command: ${args.join(" ")}`)
