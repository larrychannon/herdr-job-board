// Run: node --test (from the repo root)
// find (0.19.0): which card holds these words, across every project, Done and archived cards
// too; ranked by how many words match, then the newest; each with its column, project, parent
// and the line that matches; read-only.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { findCards, findSnippet } from "../board.mjs"

const BOARD = fileURLToPath(new URL("../board.mjs", import.meta.url))

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-find-")))
  const repo = (name) => {
    const dir = join(root, name)
    mkdirSync(dir)
    spawnSync("git", ["-C", dir, "init", "-q"])
    return dir
  }
  const sfc = repo("sfc-integration")
  const ai = repo("ai-config")
  const store = join(root, "store")
  const env = (now) => ({ ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HOME: root, JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" })
  const run = (cwd, now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd, env: env(now), encoding: "utf8" })
  const ok = (cwd, now, ...args) => {
    const r = run(cwd, now, ...args)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  return { root, sfc, ai, store, run, ok, done: () => rmSync(root, { recursive: true, force: true }) }
}

test("find: every project's cards, Done and archived too, most words first; the column, project, parent and matching line; exit 1 for none", () => {
  const t = setup()
  try {
    const D = "2026-11-03T16:00:00Z"
    t.ok(t.sfc, D, "add", "doing", "Peplink SNMP questions: answer them", "--desc", "Five questions from Peplink about the nodes.")
    t.ok(t.sfc, D, "add", "todo", "SNMP walk on LON-021: check", "--parent", "1", "--desc", "Walked LON-021 with snmpwalk; the node answers v2c only.\nNothing else changed.")
    t.ok(t.sfc, D, "add", "todo", "Node health page: build", "--desc", "The node panel.")
    t.ok(t.ai, D, "add", "todo", "Guard update: install", "--desc", "Nothing about SNMP here.\nNow: waiting for the snmpwalk docs")
    // A job report's summary is searched too, and a secret in it never shows.
    const report = join(t.root, "report.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Ran snmpwalk against the sfc node pool.", notes: [["pass", "word: Xk29", "fLq8w snmpwalk"].join("")] }))
    t.ok(t.sfc, D, "job-start", "snmp-docs", "--title", "SNMP docs: write", "--report", report, "--desc", "Docs.")
    t.ok(t.sfc, D, "done", "2")
    // An archived month (cards older than 7 days move there).
    mkdirSync(join(t.store, "archive"), { recursive: true })
    const sfcProject = JSON.parse(readFileSync(join(t.store, "board.json"), "utf8")).items[0].project
    writeFileSync(join(t.store, "archive", "2026-10.jsonl"), `${JSON.stringify({ id: 99, project: sfcProject, title: "Old snmpwalk test on the sfc node", desc: "From October.", column: "done", since: "2026-10-01T10:00:00Z", updated: "2026-10-01T10:00:00Z" })}\n`)
    const before = readFileSync(join(t.store, "board.json"), "utf8")

    // From another project's folder: every project's cards.
    const out = t.ok(t.ai, "2026-11-04T16:05:00Z", "find", "snmpwalk", "sfc", "node")
    const lines = out.trimEnd().split("\n")
    const heads = lines.filter((l) => l.startsWith("#"))
    assert.match(heads[0], /^#5 · doing · sfc · SNMP docs: write {2}\[3 of 3 words\]$/)
    assert.match(heads[1], /^#2 \(1-check\) · done Tue 16:00 · sfc · for #1 Peplink SNMP questions · SNMP walk on LON-021: check {2}\[3 of 3 words\]$/)
    assert.match(heads[2], /^#99 · done 1 Oct 10:00, archived · sfc · Old snmpwalk test on the sfc node {2}\[3 of 3 words\]$/)
    assert.match(out, /^#5 [^\n]*\n {4}report: Ran snmpwalk against the sfc node pool\.$/m)
    assert.match(out, /^#2 [^\n]*\n {4}description: Walked LON-021 with snmpwalk; the node answers v2c only\.$/m)
    assert.match(out, /^#4 · to do · ai · Guard update: install {2}\[1 of 3 words\]\n {4}status line: waiting for the snmpwalk docs$/m)
    assert.doesNotMatch(out, /Xk29fLq8w/)
    // At a word's start only: "node" is not in "anode"; any case.
    assert.deepEqual(findCards([{ id: 1, title: "an anode test" }, { id: 2, title: "NODE list" }], ["node"]).map((h) => h.item.id), [2])
    // --project narrows it; nothing found: exit 1, said.
    assert.doesNotMatch(t.ok(t.ai, "2026-11-04T16:05:00Z", "find", "snmpwalk", "--project", "sfc-integration"), /^#4 /m)
    const none = t.run(t.ai, "2026-11-04T16:05:00Z", "find", "kubernetes")
    assert.equal(none.status, 1)
    assert.match(none.stdout, /^no card has this word: kubernetes$/m)
    assert.equal(t.run(t.ai, "2026-11-04T16:05:00Z", "find").status, 2)
    // Read-only: the board is unchanged.
    assert.equal(readFileSync(join(t.store, "board.json"), "utf8"), before)
  } finally {
    t.done()
  }
})

test("find: at most 20 cards, then how many more; a long line is cut around its match", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `Card ${i + 1}: snmp`, updated: `2026-11-0${1 + (i % 3)}T10:00:00Z` }))
  const hits = findCards(items, ["snmp"])
  assert.equal(hits.length, 25)
  assert.equal(hits[0].item.updated, "2026-11-03T10:00:00Z", "the newest first among equals")
  const long = `${"a".repeat(150)} snmpwalk ${"b".repeat(150)}`
  const cut = findSnippet(long, long.indexOf("snmpwalk"))
  assert.match(cut, /^…a+ snmpwalk b+…$/)
  assert.ok([...cut].length <= 100)
})
