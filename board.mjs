#!/usr/bin/env node
// herdr-job-board: what is to do, being done, and waiting on the user, for one repo. The board
// pane (board-pane.mjs) draws it; this script is the only thing that writes it. Agents (a
// coordinator that starts jobs) and people use the same commands.
//
//   node board.mjs <command> …        (installed as a Herdr plugin: "$HERDR_PLUGIN_ROOT/board.mjs")
//
//   add <column> <title> [--desc D] [--job slug] [--ask A] [--option L]… [--suggest L]
//                           add an item; prints its id. --option (up to 4, Waiting only) puts
//                           answer buttons on the card, --suggest marks the suggested one
//   move <ref> <column> [--ask A] [--desc D]                   <ref> is an item id or a job slug
//   edit <ref> [--title T] [--desc D] [--ask A] [--job slug] [--option L]… [--suggest L] [--clear-options]
//   done <ref>                                                 same as move <ref> done
//   rm <ref>
//   ls [--width N]          the board as text: the pane's view, with live agent status
//   json                    the board file as it is
//   job-start <slug> [--id N] [--title T] [--desc D] [--report path]
//                           a job started: its item moves to Doing (--id, else this job's To do or
//                           Doing item, else a new one)
//   job-report <slug> [report.json] [--if-final]
//                           a job's report landed (default: the --report given at job-start):
//                           done → Done; done with needs_user → Waiting, asking needs_user;
//                           blocked / failed → Waiting with the reason. --if-final: a missing,
//                           unreadable or non-final report is a quiet no-op (exit 0), for wait
//                           scripts that call it whenever the report file changes
//   open [--share 0.3]      open the board pane right of this pane, once per tab; its answer
//                           buttons send to this pane
//   token                   print the sidebar text, and report it to Herdr as $board
//   path                    print the board file's path
//
// Columns: todo, doing, waiting (on the user), done. Done items are kept 14 days (the pane's
// Done column shows today's), then dropped.
//
// The board file is $(git rev-parse --git-common-dir)/job-board.json: inside .git, so every
// worktree of the repo shares one board and it is never committed. JOB_BOARD_FILE overrides it.
// Writes take a lock (mkdir <file>.lock, with the owner's pid), then write a temp file (mode
// 0600) and rename it over the board, so readers never see half a file and racing writers don't
// lose each other's items. Text is stored and printed without control characters.
//
// After each change, and from the board pane, the counts go to Herdr as the workspace token
// `board` ("1 doing · 3 need you"); a `$board` entry in the sidebar's Space rows shows it.
//
// Exit: 0 ok, 1 error (unknown item, unreadable board, Herdr failed), 2 bad usage.

import { execFile, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { findUrls, osc8 } from "./links.mjs"

export const COLUMNS = ["todo", "doing", "waiting", "done"]
const HEADINGS = { waiting: "WAITING ON YOU", doing: "DOING", todo: "TO DO", done: "DONE" }
const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const PANE_SCRIPT = join(SCRIPTS, "board-pane.mjs")
export const PANE_LABEL = "board"
export const TOKEN_SOURCE = "job-board"
const SLUG = /^[a-z][a-z0-9_-]{0,31}$/
const LOCK_WAIT_MS = 10_000
// A lock with no owner written yet (or one from another host) counts as stale after this long.
const LOCK_STALE_MS = 10_000
const KEEP_DONE_MS = 14 * 24 * 3600_000
// Under this width the board pane stacks its columns.
export const STACK_BELOW = 70

// --- the board file -----------------------------------------------------------------------

export function boardPath(cwd = process.cwd(), env = process.env) {
  if (env.JOB_BOARD_FILE) return resolve(cwd, env.JOB_BOARD_FILE)
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" })
  if (r.status !== 0) return null
  return join(resolve(cwd, r.stdout.trim()), "job-board.json")
}

/** The repo's folder name, for the pane's title line. */
export function repoName(file) {
  const dir = dirname(file)
  return basename(dir) === ".git" ? basename(dirname(dir)) : basename(dir)
}

export const emptyBoard = () => ({ version: 1, next_id: 1, items: [], panes: {} })

export function readBoard(file) {
  if (!existsSync(file)) return emptyBoard()
  let state
  try {
    state = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`board file is not valid JSON (${error.message}); fix or remove ${file}`)
  }
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v)
  if (!isObject(state) || !Array.isArray(state.items) || !state.items.every(isObject)) {
    throw new Error(`board file is not a job board (it needs an "items" list of objects): ${file}`)
  }
  // An id goes into what a button sends: only positive whole numbers.
  if (!state.items.every((i) => Number.isSafeInteger(i.id) && i.id > 0)) {
    throw new Error(`board file is not a job board (every item id must be a positive whole number): ${file}`)
  }
  // Text fields are text: a hand-edited value of another type becomes asText's version of it
  // (numbers written out, anything else "(not text)"), so nothing downstream stringifies an
  // object or array.
  for (const item of state.items) {
    for (const key of ["title", "desc", "ask", "job", "column", "since", "updated", "created", "report", "reported"]) {
      if (item[key] != null && typeof item[key] !== "string") item[key] = asText(item[key])
    }
    if (item.sent != null && !(isObject(item.sent) && typeof item.sent.label === "string")) delete item.sent
  }
  state.next_id = Math.max(Number(state.next_id) || 1, ...state.items.map((i) => Number(i.id) + 1 || 1))
  if (!isObject(state.panes)) state.panes = {}
  return state
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

/** The lock directory's inode, age and owner ("<pid> <host> <random>"), or null when there is none. */
function lockInfo(lock) {
  try {
    const { ino, mtimeMs } = statSync(lock)
    let owner = ""
    try {
      owner = readFileSync(join(lock, "owner"), "utf8").trim()
    } catch {}
    return { ino, mtimeMs, owner }
  } catch {
    return null
  }
}

/**
 * A lock is stale when its owner process on this host is gone. A live owner keeps it, even a
 * stalled one, so a slow writer is never cut off. With no owner written yet, or an owner on
 * another host, it is stale only after LOCK_STALE_MS.
 */
function isStale(info) {
  const [pid, host] = info.owner.split(" ")
  if (Number(pid) > 0 && host === hostname()) return !alive(Number(pid))
  return Date.now() - info.mtimeMs > LOCK_STALE_MS
}

/**
 * Remove the lock judged stale, and only that one: move it aside (one waiter wins the rename),
 * check it is the same directory (inode), then delete it. A lock taken in between goes back.
 */
function reap(lock, info) {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.stale`
  try {
    renameSync(lock, aside)
  } catch {
    return
  }
  let same = false
  try {
    same = statSync(aside).ino === info.ino
  } catch {}
  if (!same) {
    try {
      renameSync(aside, lock)
      return
    } catch {}
  }
  rmSync(aside, { recursive: true, force: true })
}

function withLock(file, fn) {
  const lock = `${file}.lock`
  const token = `${process.pid} ${hostname()} ${randomBytes(6).toString("hex")}`
  const wait = Number(process.env.JOB_BOARD_LOCK_WAIT_MS) || LOCK_WAIT_MS
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, "owner"), token)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    const info = lockInfo(lock)
    if (!info) continue
    if (isStale(info)) {
      reap(lock, info)
      continue
    }
    if (Date.now() - start > wait) {
      const by = info.owner ? ` by process ${info.owner.split(" ")[0]}` : ""
      throw new Error(`the board is locked${by} (${lock}); remove that directory if no board command is running`)
    }
    sleep(5 + Math.random() * 30)
  }
  try {
    return fn()
  } finally {
    // Release only our own lock.
    if (lockInfo(lock)?.owner === token) rmSync(lock, { recursive: true, force: true })
  }
}

function writeBoard(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/** Read, change and write the board under its lock. Returns what `change` returns. */
export function updateBoard(file, change, now = new Date()) {
  return withLock(file, () => {
    const state = readBoard(file)
    const result = change(state)
    state.items = state.items.filter((i) => i.column !== "done" || !(now - new Date(i.since) >= KEEP_DONE_MS))
    writeBoard(file, state)
    return result
  })
}

// --- items ----------------------------------------------------------------------------------

// Text from people, agents and reports is stored without control characters (escape sequences,
// BEL, C1 codes) or bidirectional controls, so nothing that prints it can drive a terminal.
// `clean` makes one line; `cleanLines` keeps line breaks (an ask has one line per thing to do).
// Format characters (Unicode Cf: zero-width spaces and joiners, word joiner, BOM, soft hyphen,
// bidirectional controls) are invisible: they go too, so nothing can hide in a title or a link.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu
/**
 * A value as text: strings as they are, numbers and booleans written out, nothing for null,
 * and "(not text)" for anything else. It never calls String() on an object or array, whose
 * toString can recurse without end (a report nested thousands of arrays deep).
 */
export const asText = (value) =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : value == null ? "" : "(not text)"
// Format characters go first (JavaScript counts U+FEFF as whitespace), then whitespace becomes
// single spaces, then any control character left goes.
const clean = (text) => asText(text).replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").replace(CONTROLS, "").trim()
const cleanLines = (text) => asText(text).split(/\r?\n/).map(clean).filter(Boolean).join("\n")
/** Output that echoes stored or reported text: line breaks kept, every other control removed. */
export const safeText = (text) => asText(text).split("\n").map((l) => l.replace(CONTROLS, "")).join("\n")

export function columnOf(name) {
  const column = String(name ?? "").toLowerCase()
  if (!COLUMNS.includes(column)) throw usage(`unknown column "${name}" (use ${COLUMNS.join(", ")})`)
  return column
}

/** A job's open item: the one in Doing first, else the latest one not done. */
const jobItem = (items, slug) =>
  items.findLast((i) => i.job === slug && i.column === "doing") || items.findLast((i) => i.job === slug && i.column !== "done")

export function findItem(state, ref) {
  const text = String(ref ?? "")
  if (/^\d+$/.test(text)) {
    const item = state.items.find((i) => i.id === Number(text))
    if (!item) throw new Error(`no item ${text} on the board`)
    return item
  }
  const item = jobItem(state.items, text) || state.items.findLast((i) => i.job === text)
  if (!item) throw new Error(`no item ${text === "" ? "given" : `with id or job "${text}"`} on the board`)
  return item
}

export const MAX_OPTIONS = 4
export const MAX_LABEL = 24

/**
 * Answer buttons for a Waiting card from --option labels and --suggest: cleaned like every other
 * field, at most MAX_OPTIONS of at most MAX_LABEL characters, all different. "Other…" is built
 * in and never stored.
 */
export function makeOptions(labels, suggest) {
  const list = labels.map(clean)
  if (list.some((l) => !l)) throw usage("an --option needs a label")
  if (list.length > MAX_OPTIONS) throw usage(`at most ${MAX_OPTIONS} --option (Other… is added by itself)`)
  const long = list.find((l) => [...l].length > MAX_LABEL)
  if (long) throw usage(`--option "${long}" is longer than ${MAX_LABEL} characters`)
  if (new Set(list.map((l) => l.toLowerCase())).size !== list.length) throw usage("each --option must be different")
  const suggested = suggest === undefined ? undefined : clean(suggest)
  if (suggested !== undefined && !list.includes(suggested)) throw usage(`--suggest "${suggested}" is not one of the --option labels`)
  return list.map((label) => (label === suggested ? { label, suggested: true } : { label }))
}

/** A card's buttons as stored, checked again: anything that can write the board file could add them. */
export function optionsOf(item) {
  if (!Array.isArray(item?.options)) return []
  return item.options
    .map((o) => ({ label: [...clean(o?.label)].slice(0, MAX_LABEL).join(""), suggested: o?.suggested === true }))
    .filter((o) => o.label)
    .slice(0, MAX_OPTIONS)
}

/**
 * The buttons a card shows, and so the only ones that can be chosen or pressed: a Waiting card's
 * own, unless it has no id or its job is blocked (that card says "answer it in its tab" instead).
 */
export function shownOptions(entry, column = entry?.column) {
  return column === "waiting" && entry?.id != null && entry.live !== "blocked" ? optionsOf(entry) : []
}

function setOptions(item, opts) {
  if (opts["clear-options"]) {
    delete item.options
    delete item.sent
  }
  if (opts.option === undefined && opts.suggest === undefined) return
  if (item.column !== "waiting") throw usage("answer buttons (--option) are for Waiting cards")
  const labels = opts.option ?? optionsOf(item).map((o) => o.label)
  if (!labels.length) throw usage("--suggest needs --option labels")
  item.options = makeOptions(labels, opts.suggest ?? optionsOf(item).find((o) => o.suggested)?.label)
  // A new question: nothing has been sent for it yet.
  if (opts.option !== undefined) delete item.sent
}

/** Cards that come from a job (job-start, job-report) never carry buttons. */
function dropOptions(item) {
  delete item.options
  delete item.sent
}

function addItem(state, column, title, opts, now) {
  if (!clean(title)) throw usage("an item needs a title")
  const at = now.toISOString()
  const item = {
    id: state.next_id++,
    title: clean(title),
    desc: clean(opts.desc),
    column,
    job: clean(opts.job),
    ask: cleanLines(opts.ask),
    created: at,
    since: at,
    updated: at,
  }
  if (opts.report) item.report = resolve(opts.report)
  setOptions(item, opts)
  state.items.push(item)
  return item
}

function moveItem(item, column, now) {
  const at = now.toISOString()
  if (item.column !== column) {
    item.column = column
    item.since = at
    // A question, and its buttons, are only open while the item waits on the user.
    if (column !== "waiting") {
      item.ask = ""
      dropOptions(item)
    }
  }
  item.updated = at
  return item
}

function editItem(item, opts, now) {
  if (opts.title !== undefined) {
    if (!clean(opts.title)) throw usage("an item needs a title")
    item.title = clean(opts.title)
  }
  if (opts.desc !== undefined) item.desc = clean(opts.desc)
  if (opts.ask !== undefined) item.ask = cleanLines(opts.ask)
  if (opts.job !== undefined) item.job = clean(opts.job)
  if (opts.report !== undefined) item.report = resolve(opts.report)
  setOptions(item, opts)
  item.updated = now.toISOString()
  return item
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
// An entry of a report's list may be an object ({ "question": …, "suggested_answer": … }): its
// first text field among these is the entry.
const TEXT_FIELDS = ["what", "question", "ask", "text", "title", "summary", "finding", "check", "reason", "description", "command"]
const SUGGEST_FIELDS = ["suggested_answer", "suggested", "suggestion", "default"]
const firstText = (o, fields) => fields.map((k) => o[k]).find((v) => typeof v === "string" && v.trim())
/** One entry of a report's list as text: text, a number or true/false as it is, an object by its text field, else "(not text)". */
const itemText = (n) => (isRecord(n) ? (firstText(n, TEXT_FIELDS) ?? "(not text)") : asText(n))

/** needs_user from a report, as a list of plain lines. */
function needsList(needs) {
  const list = Array.isArray(needs) ? needs : needs ? [needs] : []
  return list.slice(0, 100).map(itemText).map(clean).filter(Boolean)
}

/** Where a job's report puts its board item: [column, ask], or null for a non-final report. */
export function reportOutcome(report) {
  const status = String(report?.status ?? "").trim().toLowerCase()
  const needs = needsList(report?.needs_user)
  if (status === "done") return needs.length ? ["waiting", needs.join("\n")] : ["done", ""]
  if (status === "blocked" || status === "failed") {
    const reason = clean(report?.summary) || "no summary in the report"
    return ["waiting", [`${status}: ${reason}`, ...needs].join("\n")]
  }
  return null
}

// Parsed reports by path, kept while the file's mtime and size stay the same: the pane redraws
// every few seconds and on every key, and the details panel shouldn't re-read the file each time.
const reportCache = new Map()
const REPORT_CACHE_MAX = 64
export const reportCacheStats = { hits: 0, reads: 0 }

/** A job report, parsed, through the cache. Same rules as readJson. */
function readReport(path) {
  if (!path) return { report: null, entry: null }
  let stat
  try {
    stat = statSync(path)
  } catch {
    reportCache.delete(path)
    return { report: null, entry: null }
  }
  const known = reportCache.get(path)
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    reportCacheStats.hits++
    return { report: known.report, entry: known }
  }
  reportCacheStats.reads++
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, report: readJson(path) }
  reportCache.delete(path)
  reportCache.set(path, entry)
  if (reportCache.size > REPORT_CACHE_MAX) reportCache.delete(reportCache.keys().next().value)
  return { report: entry.report, entry }
}

/** A job report: a regular file of at most 1 MB, else null (a FIFO would block the pane). */
function readJson(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 1 << 20) return null
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// --- Herdr ----------------------------------------------------------------------------------

const herdrBin = (env) => env.HERDR_BIN_PATH || "herdr"
const inHerdr = (env) => env.HERDR_ENV === "1"

function herdr(args, env, { quiet = false } = {}) {
  const r = spawnSync(herdrBin(env), args, { encoding: "utf8", env, timeout: 10_000 })
  let json = null
  try {
    json = JSON.parse(r.stdout)
  } catch {}
  if (r.status !== 0 && !quiet) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`)
  }
  return r.status === 0 ? json : null
}

/** Live agents from `herdr agent list`, or null outside Herdr or when it can't be read. */
export function listAgents(env = process.env) {
  if (!inHerdr(env)) return null
  return herdr(["agent", "list"], env, { quiet: true })?.result?.agents ?? null
}

export function listAgentsAsync(env = process.env) {
  if (!inHerdr(env)) return Promise.resolve(null)
  return new Promise((done) => {
    execFile(herdrBin(env), ["agent", "list"], { env, timeout: 5000 }, (error, stdout) => {
      try {
        done(error ? null : (JSON.parse(stdout).result?.agents ?? null))
      } catch {
        done(null)
      }
    })
  })
}

/** Tab labels in a workspace, { tab_id: label }, from `herdr tab list`; {} when unavailable. */
export function listTabsAsync(env = process.env) {
  if (!inHerdr(env) || !env.HERDR_WORKSPACE_ID) return Promise.resolve({})
  return new Promise((done) => {
    execFile(herdrBin(env), ["tab", "list", "--workspace", env.HERDR_WORKSPACE_ID], { env, timeout: 5000 }, (error, stdout) => {
      try {
        const tabs = error ? [] : JSON.parse(stdout).result?.tabs || []
        done(Object.fromEntries(tabs.filter((t) => t?.tab_id).map((t) => [t.tab_id, String(t.label ?? "")])))
      } catch {
        done({})
      }
    })
  })
}

/** Switch the user's view to a job's agent (its tab): `herdr agent focus <name>`, argv only. */
export function focusAgent(name, env = process.env) {
  if (!inHerdr(env)) return Promise.resolve("not inside Herdr")
  return herdrCall(["agent", "focus", name], env)
}

/** Report the sidebar token, or clear it when the text is empty. Returns whether it ran. */
export function reportToken(text, env = process.env, { wait = true } = {}) {
  if (!inHerdr(env) || !env.HERDR_WORKSPACE_ID) return false
  const args = ["workspace", "report-metadata", env.HERDR_WORKSPACE_ID, "--source", TOKEN_SOURCE]
  args.push(...(text ? ["--token", `board=${text}`] : ["--clear-token", "board"]))
  if (wait) spawnSync(herdrBin(env), args, { env, stdio: "ignore", timeout: 5000 })
  else execFile(herdrBin(env), args, { env, timeout: 5000 }, () => {})
  return true
}

// --- the view: the board plus live agent status ----------------------------------------------

/**
 * What the pane shows. Doing items get their agent's live status; a blocked agent moves its item
 * to Waiting, and a blocked named agent in this workspace that isn't on the board shows up there
 * too. `agents` null means Herdr couldn't be asked, so no live status at all.
 */
export function buildView(state, agents, { now = new Date(), workspace = "" } = {}) {
  const byName = new Map()
  for (const a of agents || []) {
    // In a workspace, only its own agents: another workspace may run an agent with the same name.
    if (a.name && (!workspace || a.workspace_id === workspace)) byName.set(a.name, a)
  }
  const view = { waiting: [], doing: [], todo: [], doneToday: [], counts: {} }
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const onBoard = new Set()
  const sorted = [...state.items].sort((a, b) => a.id - b.id)
  for (const item of sorted) {
    // `report` stays the report's path; `reportStatus` is what it says, when final.
    const entry = { ...item, live: "", reportStatus: "", age: now - new Date(item.since || item.updated || now) }
    if (item.column === "done") {
      if (new Date(item.since) >= startOfDay) view.doneToday.push(entry)
      continue
    }
    if (item.job) onBoard.add(item.job)
    if (item.job && agents && (item.column === "doing" || item.column === "waiting")) {
      const agent = byName.get(item.job)
      entry.live = agent ? agent.agent_status || "unknown" : item.column === "doing" ? "no agent" : ""
    }
    if (item.column === "doing" && item.report) {
      const status = readReport(item.report).report?.status
      if (["done", "blocked", "failed"].includes(status)) entry.reportStatus = status
    }
    if (item.column === "doing" && entry.live === "blocked") view.waiting.push(entry)
    else view[item.column]?.push(entry)
  }
  for (const a of agents || []) {
    if (!a.name || onBoard.has(a.name) || a.agent_status !== "blocked") continue
    if (workspace && a.workspace_id !== workspace) continue
    view.waiting.push({ id: null, title: a.name, desc: "", ask: "", job: a.name, live: "blocked", age: null, reportStatus: "" })
  }
  view.doneToday.sort((a, b) => new Date(b.since) - new Date(a.since))
  // Blocked agents first: a job is stuck until the user answers it.
  view.waiting.sort((a, b) => (b.live === "blocked") - (a.live === "blocked") || (a.id ?? 1e9) - (b.id ?? 1e9))
  for (const column of ["waiting", "doing", "todo"]) view.counts[column] = view[column].length
  view.counts.doneToday = view.doneToday.length
  return view
}

/** The sidebar text, e.g. "1 doing · 3 need you · 4 to do"; empty when nothing is open. */
export function tokenText(view) {
  const { doing, waiting, todo } = view.counts
  const parts = []
  if (doing) parts.push(`${doing} doing`)
  if (waiting) parts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`)
  if (todo) parts.push(`${todo} to do`)
  return parts.join(" · ")
}

// --- drawing ----------------------------------------------------------------------------------

// Only the standard 16-colour palette, so it follows the terminal's theme, dark or light; and only
// SGR codes the renderer writes itself, never text from the board.
const STYLES = {
  title: "1",
  dim: "2",
  head: "1",
  ask: "33",
  button: "1",
  suggested: "1;33",
  selected: "1;7",
  link: "4",
  old: "31",
  blocked: "1;31",
  // Section headers, and the same when selected (reverse video).
  waiting: "1;33",
  doing: "1;34",
  todo: "1",
  done: "2;32",
  "sel-waiting": "1;7;33",
  "sel-doing": "1;7;34",
  "sel-todo": "1;7",
  "sel-done": "7;32",
  // A job's agent.
  working: "32",
  idle: "36",
  finished: "36",
  gone: "90",
}
const STATUS_STYLE = { working: "working", blocked: "blocked", idle: "idle", done: "finished", "no agent": "gone", unknown: "gone" }
// Wide characters (CJK, emoji) take two cells; combining marks none.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\ufe0f]/u
const cellWidth = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
export const textWidth = (text) => [...text].reduce((w, ch) => w + cellWidth(ch), 0)
// Board text comes from agents and reports: never let it carry escape sequences, newlines or
// bidirectional controls (which would show text in a different order than it is stored).
const printable = (text) =>
  asText(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\p{Cf}/gu, "")

/**
 * Segments [{t, s, link}] cut to `width` cells (an ellipsis marks the cut) and painted. With
 * `links`, a link segment shown whole becomes a terminal hyperlink whose visible text is the URL.
 */
function paintLine(segments, width, color, links = false) {
  let out = ""
  let used = 0
  for (const { t, s, link } of segments) {
    const text = printable(t)
    if (!text) continue
    let piece = ""
    let cut = false
    for (const ch of text) {
      const w = cellWidth(ch)
      if (used + w > width) {
        cut = true
        break
      }
      piece += ch
      used += w
    }
    if (cut) {
      // Make room for the ellipsis.
      while (used + 1 > width && piece) {
        const last = [...piece].at(-1)
        piece = piece.slice(0, -last.length)
        used -= cellWidth(last)
      }
      if (used + 1 <= width) {
        piece += "…"
        used += 1
      }
    }
    const shown = links && link && !cut && piece === link ? osc8(link) : piece
    out += color && s && STYLES[s] && piece ? `\x1b[${STYLES[s]}m${shown}\x1b[0m` : shown
    if (cut) break
  }
  return { text: out, width: used }
}

/**
 * Text as segments in style `s`, with each URL that also appears whole in the source (`urls`)
 * as its own link segment. A URL cut by wrapping or an ellipsis is plain text.
 */
function linkify(text, s, urls) {
  const segs = []
  let at = 0
  for (const { url, index } of findUrls(text)) {
    if (!urls.has(url)) continue
    if (index > at) segs.push({ t: text.slice(at, index), s })
    segs.push({ t: url, s: "link", link: url })
    at = index + url.length
  }
  if (at < text.length) segs.push({ t: text.slice(at), s })
  return segs.length ? segs : [{ t: text, s }]
}
const urlsIn = (...texts) => new Set(texts.flatMap((t) => findUrls(t).map((u) => u.url)))

export function formatAge(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 10) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} days`
}

/** Cut `text` to `width` cells, ending in "…". */
function ellipsize(text, width) {
  let out = ""
  let used = 0
  for (const ch of text) {
    if (used + cellWidth(ch) > width - 1) break
    out += ch
    used += cellWidth(ch)
  }
  return `${out}…`
}

/**
 * Word-wrap `text` into lines of at most `width` cells, at most `max` of them; when it needs more,
 * the last line ends in "…". A word longer than a line is broken.
 */
export function wrap(text, width, max) {
  if (max <= 0 || width < 2) return []
  const lines = []
  let line = ""
  for (let word of printable(text).split(" ").filter(Boolean)) {
    while (textWidth(word) > width) {
      if (line) lines.push(line)
      line = ""
      let head = ""
      for (const ch of word) {
        if (textWidth(head + ch) > width) break
        head += ch
      }
      lines.push(head)
      word = word.slice(head.length)
    }
    const next = line ? `${line} ${word}` : word
    if (textWidth(next) <= width) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  kept[max - 1] = ellipsize(`${kept[max - 1]} ${lines[max]}`, width)
  return kept
}

const asksOf = (text) =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * One card, as lines of segments that already fit `width` cells: the title (bold, up to 2 lines);
 * the live status for Doing; the description wrapped over up to
 * `descMax` lines; for Waiting, what the user should do ("→ …"); the age.
 */
/**
 * The buttons of a Waiting card: its options, then the built-in "Other…". With `selected`, the
 * selected one shows as < … > (and in reverse video), the rest as [ … ]: the same width, so the
 * card doesn't move. Each button segment carries what a click on it means.
 */
function buttonLines(entry, width, indent, selected) {
  const options = optionsOf(entry)
  const all = [...options.map((o, i) => ({ text: o.suggested ? `${o.label} ✓` : o.label, index: i, label: o.label })), { text: "Other…", index: options.length, label: null }]
  const lines = []
  let line = [indent]
  let used = textWidth(indent.t)
  for (const b of all) {
    const on = selected === b.index
    const suggested = b.index < options.length && options[b.index].suggested
    const text = on ? `< ${b.text} >` : `[ ${b.text} ]`
    const w = textWidth(text)
    if (line.length > 1 && used + 2 + w > width) {
      lines.push(line)
      line = [indent]
      used = textWidth(indent.t)
    }
    if (line.length > 1) {
      line.push({ t: "  " })
      used += 2
    }
    line.push({ t: text, s: on ? "selected" : suggested ? "suggested" : "button", button: { key: keyOf(entry), id: entry.id, index: b.index, label: b.label } })
    used += w
  }
  lines.push(line)
  return lines
}

/**
 * One card, as lines of segments that already fit `width` cells: the title (bold, up to 2 lines);
 * the live status for Doing; the description wrapped over up to `descMax` lines; for Waiting,
 * what the user should do ("→ …") and its answer buttons; a note (sent, send again?, couldn't
 * send); the age. `ui`: { selected (this card has the keyboard), button (selected button), note }.
 */
function card(entry, column, width, idWidth, descMax, ui = {}) {
  const indent = { t: " ".repeat(idWidth + 1) }
  const inner = Math.max(4, width - idWidth - 1)
  const blocked = entry.live === "blocked"
  const mark = entry.id == null ? "•" : String(entry.id)
  const urls = urlsIn(entry.title, entry.desc, entry.ask)
  const titles = wrap(entry.title, inner, 2)
  const lines = titles.map((t, i) => [
    i ? indent : { t: `${mark.padStart(idWidth)}${ui.selected ? "▸" : " "}`, s: ui.selected ? "head" : entry.id == null ? "" : "dim" },
    ...linkify(t, blocked ? "blocked" : "title", urls),
  ])
  if (blocked) {
    lines.push([indent, { t: "blocked", s: "blocked" }, { t: `: answer it in tab ${entry.job}`, s: "dim" }])
  } else if (column === "doing" && (entry.live || entry.reportStatus)) {
    const status = entry.live && entry.reportStatus ? `${entry.live}, report ${entry.reportStatus}` : entry.live || `report ${entry.reportStatus}`
    lines.push([indent, { t: status, s: entry.live ? STATUS_STYLE[entry.live] || "gone" : "finished" }])
  }
  for (const t of wrap(entry.desc, inner, descMax)) lines.push([indent, ...linkify(t, "", urls)])
  if (column === "waiting" || blocked) {
    const asks = asksOf(entry.ask)
    for (const ask of asks.slice(0, 2)) {
      wrap(ask, inner - 2, 2).forEach((t, i) => lines.push([indent, { t: i ? "  " : "→ ", s: "ask" }, ...linkify(t, "ask", urls)]))
    }
    if (asks.length > 2) lines.push([indent, { t: `  +${asks.length - 2} more (board.mjs json)`, s: "dim" }])
  }
  if (shownOptions(entry, column).length) {
    if (entry.sent?.label) {
      const at = new Date(entry.sent.at)
      lines.push([indent, { t: `sent: ${entry.sent.label}${Number.isNaN(at.getTime()) ? "" : ` · ${clockOf(at)}`}`, s: "dim" }])
    }
    lines.push(...buttonLines(entry, width, indent, ui.selected ? ui.button : -1))
  }
  if (ui.note) for (const t of wrap(ui.note.t, inner, 2)) lines.push([indent, { t, s: ui.note.s }])
  // The age, dimmed (red on a Waiting card older than a day), on the right: of the title's last
  // line, else of the card's last line, else on a line of its own.
  const age = entry.age == null ? "" : formatAge(entry.age)
  if (age) {
    const style = column === "waiting" && entry.age > 24 * 3600_000 ? "old" : "dim"
    const used = (line) => line.reduce((w, seg) => w + textWidth(printable(seg.t)), 0)
    const room = (line) => width - used(line) - textWidth(age)
    const line = [lines[titles.length - 1], lines.at(-1)].find((l) => room(l) >= 2)
    if (line) line.push({ t: " ".repeat(room(line)) }, { t: age, s: style })
    else lines.push([indent, { t: age, s: style }])
  }
  return lines
}

const DESC_LINES = 3
/** The board's sections, in the order Tab moves through them. */
export const SECTIONS = ["waiting", "doing", "todo", "done"]
const clockOf = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
const segWidth = (segs) => segs.reduce((w, seg) => w + textWidth(printable(seg.t)), 0)
const keyOf = (entry) => (entry.id == null ? `agent:${entry.job}` : `#${entry.id}`)
const entriesOf = (view, section) => (section === "done" ? view.doneToday : view[section])

/** A finished card: the title, with the time it was finished on the right. */
function doneCard(entry, width, idWidth, ui = {}) {
  const indent = { t: " ".repeat(idWidth + 1) }
  const inner = Math.max(4, width - idWidth - 1)
  const titles = wrap(entry.title, inner, 2)
  const urls = urlsIn(entry.title)
  const lines = titles.map((t, i) => [i ? indent : { t: `${String(entry.id).padStart(idWidth)}${ui.selected ? "▸" : " "}`, s: ui.selected ? "head" : "dim" }, ...linkify(t, "", urls)])
  const at = clockOf(new Date(entry.since))
  const room = inner - textWidth(titles.at(-1) || "") - at.length
  if (room >= 2) lines.at(-1).push({ t: " ".repeat(room) }, { t: at, s: "dim" })
  else lines.push([indent, { t: at, s: "dim" }])
  return lines
}

/**
 * A section's cards as blocks, a block being what one scroll step moves: one card, or with
 * `perRow` > 1 a row of cards side by side. [{ keys, lines }]
 */
export function sectionBlocks(view, section, width, perRow = 1, uiOf = () => ({})) {
  const entries = entriesOf(view, section)
  const idWidth = Math.max(1, ...entries.map((e) => (e.id == null ? 1 : String(e.id).length)))
  // Every segment of a card knows its card, so a click can find it.
  const draw = (e, w) =>
    (section === "done" ? doneCard(e, w, idWidth, uiOf(e)) : card(e, section, w, idWidth, DESC_LINES, uiOf(e))).map((l) => l.map((seg) => ({ ...seg, card: keyOf(e) })))
  if (perRow <= 1) return entries.map((e) => ({ keys: [keyOf(e)], lines: draw(e, width) }))
  const gap = 3
  const cw = Math.floor((width - gap * (perRow - 1)) / perRow)
  const blocks = []
  for (let i = 0; i < entries.length; i += perRow) {
    const row = entries.slice(i, i + perRow)
    const cards = row.map((e) => draw(e, cw))
    const height = Math.max(...cards.map((c) => c.length))
    const lines = Array.from({ length: height }, (_, r) =>
      cards.flatMap((c, j) => {
        const segs = c[r] || []
        return j < cards.length - 1 ? [...segs, { t: " ".repeat(Math.max(0, cw - segWidth(segs)) + gap) }] : segs
      }),
    )
    blocks.push({ keys: row.map(keyOf), lines })
  }
  return blocks
}

const heightOf = (blocks, from, to) => blocks.slice(from, to).reduce((h, b, i) => h + b.lines.length + (i ? 1 : 0), 0)
const linesOf = (blocks, from, to) => blocks.slice(from, to).flatMap((b, i) => (i ? [[], ...b.lines] : b.lines))
const cardsIn = (blocks, from, to) => blocks.slice(from, to).reduce((n, b) => n + b.keys.length, 0)

/**
 * The blocks that show in `height` lines starting at block `offset`, with "↑ N above" and
 * "↓ N more" lines at the edges, so no card is ever hidden without being counted. The offset is
 * clamped: the last page is full, not one card and empty space. When no card fits whole, the
 * first one is shown cut; when not even that fits, it is counted in "↓ N more". Every card is
 * either above, shown or below: above + shown cards + below is always the total.
 */
export function viewport(blocks, height, offset = 0) {
  const n = blocks.length
  if (!Number.isFinite(height)) return { lines: linesOf(blocks, 0, n), offset: 0, maxOffset: 0, page: Math.max(1, n), shown: n, above: 0, below: 0 }
  let maxOffset = 0
  while (maxOffset < n - 1 && heightOf(blocks, maxOffset, n) > height - (maxOffset > 0 ? 1 : 0)) maxOffset++
  const o = Math.max(0, Math.min(offset, maxOffset))
  const top = o > 0 ? 1 : 0
  let shown = n - o
  if (heightOf(blocks, o, n) > height - top) {
    // Whole cards, keeping a line for "↓ N more"; else the first one cut, if a line is left for it.
    shown = 0
    while (o + shown < n && heightOf(blocks, o, o + shown + 1) <= height - top - 1) shown++
    if (shown === 0 && o < n && height - top - (o + 1 < n ? 1 : 0) > 0) shown = 1
  }
  const bottom = o + shown < n ? 1 : 0
  const above = cardsIn(blocks, 0, o)
  const below = cardsIn(blocks, o + shown, n)
  const result = { offset: o, maxOffset, page: Math.max(1, shown), shown: cardsIn(blocks, o, o + shown), above, below }
  if (height <= 0) return { ...result, lines: [], shown: 0, below: cardsIn(blocks, o, n) }
  // Too short for both markers: one line that says both.
  if (top + bottom > height) {
    const both = [above ? `↑ ${above} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean).join(" · ")
    return { ...result, lines: [[{ t: both, s: "dim" }]] }
  }
  const lines = []
  if (top) lines.push([{ t: `↑ ${above} above`, s: "dim" }])
  lines.push(...linesOf(blocks, o, o + shown).slice(0, height - top - bottom))
  if (bottom) lines.push([{ t: `↓ ${below} more`, s: "dim" }])
  return { ...result, lines }
}

/** Share `total` lines between sections that want `wants` lines: a fair share each, any spare to who needs it. */
function share(wants, total) {
  const got = wants.map((w) => Math.min(w, 2))
  let left = total - got.reduce((a, b) => a + b, 0)
  for (;;) {
    const open = wants.map((w, i) => (got[i] < w ? i : -1)).filter((i) => i >= 0)
    if (left <= 0 || !open.length) break
    const each = Math.max(1, Math.floor(left / open.length))
    for (const i of open) {
      const add = Math.min(each, wants[i] - got[i], left)
      got[i] += add
      left -= add
      if (left <= 0) break
    }
  }
  return got
}

function headerLine(view, section, selected) {
  const count = entriesOf(view, section).length
  const segs = []
  if (selected) segs.push({ t: "▸ ", s: "head" })
  segs.push({ t: `${HEADINGS[section]} (${count})`, s: selected ? `sel-${section}` : section === "waiting" && !count ? "head" : section })
  if (section === "waiting" && !count) segs.push({ t: "  Nothing needs you", s: "dim" })
  return segs
}

const pad = (painted, width) => painted.text + " ".repeat(Math.max(0, width - painted.width))
const contentHeight = (blocks) => Math.max(1, heightOf(blocks, 0, blocks.length))
const HINT = (mouse) => `Tab section · ↑↓ card · Enter details · c copy · m mouse: ${mouse} · q quit`
const HINT_NARROW = (mouse) => `Tab · ↑↓ · Enter · c copy · mouse: ${mouse} · q`
// The key line with a card's details open: ← → only when the card has buttons, f only when
// there is more to show.
const detailHint = (wide, buttons, more) =>
  wide
    ? ["Esc close", "↑↓ scroll", buttons && "←→ choose", more && "f more", "c copy", "t go to tab", "q quit"].filter(Boolean).join(" · ")
    : ["Esc", "↑↓", buttons && "←→", more && "f more", "c copy", "t tab", "q"].filter(Boolean).join(" · ")

// --- card details -------------------------------------------------------------------------

const capText = (text, max) => {
  const chars = [...clean(text)]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}
const own = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : undefined)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * A short local time: "03:17" today, "Mon 03:17" in the last week, "12 Oct 03:17" this year,
 * else "12 Oct 2025"; "" when it isn't a date.
 */
export function shortTime(iso, now = new Date()) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ""
  const days = Math.round((dayOf(now) - dayOf(d)) / 86_400_000)
  if (days === 0) return clockOf(d)
  if (days > 0 && days < 7) return `${WEEKDAYS[d.getDay()]} ${clockOf(d)}`
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? `${date} ${clockOf(d)}` : `${date} ${d.getFullYear()}`
}

// A dot after one of these doesn't end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|incl|approx|cf|no|nr|fig|mr|mrs|ms|dr|st)\.$/i

/**
 * The first one or two sentences of `text`, at most about `max` characters: { text, cut }, `cut`
 * meaning there is more. A first sentence longer than that is cut at a word and ends in "…".
 */
export function firstSentences(text, max = 300) {
  const full = text.trim()
  const ends = []
  for (const m of full.matchAll(/[.!?…]["')\]]*(?=\s+["'(\[]?[\p{Lu}\p{N}])/gu)) {
    if (!ABBREVIATION.test(full.slice(Math.max(0, m.index - 8), m.index + 1))) ends.push(m.index + m[0].length)
  }
  ends.push(full.length)
  let shown = full.slice(0, ends[0])
  if (ends.length > 1 && [...full.slice(0, ends[1])].length <= max) shown = full.slice(0, ends[1])
  if ([...shown].length > max) {
    const head = [...shown].slice(0, max - 1).join("")
    const space = head.lastIndexOf(" ")
    shown = `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`
  }
  return { text: shown, cut: shown !== full }
}

/** A report's list (verified, skipped, findings) as lines of text, cut to fixed lengths. */
const listOf = (value, max = 50) =>
  (Array.isArray(value) ? value.slice(0, max) : value == null || value === "" ? [] : [value]).map((v) => capText(itemText(v), 600)).filter(Boolean)
const countOf = (value) => (Array.isArray(value) ? value.length : listOf(value).length)

// Pull or merge requests, issues and commits by the shape of their path, on any host:
// …/<repo>/pull/12, …/<repo>/pull-requests/12, …/<repo>/-/merge_requests/12.
const PR_URL = /^https?:\/\/[^/?#]+\/(?:[^/?#]+\/)*?([^/?#]+)\/(?:-\/)?(?:pull|pulls|pull-requests|merge_requests)\/(\d+)(?=$|[/?#])/i
const ISSUE_URL = /^https?:\/\/[^/?#]+\/(?:[^/?#]+\/)+(?:-\/)?issues\/(\d+)(?=$|[/?#])/i
const COMMIT_URL = /^https?:\/\/[^/?#]+\/(?:[^/?#]+\/)+(?:-\/)?commits?\/([0-9a-f]{7,40})(?=$|[/?#])/i
const MAX_LINKS = 10

/** An id's name in words, letters and digits only: "dev_server" → "Dev server", "repo_url" → "Repo". */
function humanKey(key) {
  const words = clean(key)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s*\b(?:url|link|href)$/i, "")
    .trim()
    .toLowerCase()
  return capText(words.charAt(0).toUpperCase() + words.slice(1), 24)
}

/**
 * The links in a report, labelled for people: the URLs in its ids (in order), then those in its
 * text, each once. "PR #21" (with the repo when PRs come from more than one), "Issue #4",
 * "Commit abc1234", "Design canvas" (an id named for a canvas or design, or an artifact when the
 * ids name a canvas), else the id's name in words, else the host. A PR known only by its number
 * is listed without a URL.
 */
function reportLinks(ids, texts) {
  const found = []
  const add = (url, key) => {
    if (found.length < MAX_LINKS && !found.some((l) => l.url === url)) found.push({ url, key })
  }
  const entries = Object.entries(ids).slice(0, 100)
  for (const [key, value] of entries) {
    for (const v of Array.isArray(value) ? value.slice(0, 50) : [value]) for (const { url } of findUrls(capText(v, 2000))) add(url, key)
  }
  for (const text of texts) for (const { url } of findUrls(text)) add(url, "")
  const canvas = entries.some(([k]) => /canvas/i.test(k))
  const repos = new Set(found.map(({ url }) => PR_URL.exec(url)?.[1]).filter(Boolean))
  const links = found.map(({ url, key }) => {
    let m
    if ((m = PR_URL.exec(url))) return { label: `PR #${m[2]}${repos.size > 1 ? ` · ${capText(m[1], 24)}` : ""}`, url }
    if ((m = ISSUE_URL.exec(url))) return { label: `Issue #${m[1]}`, url }
    if ((m = COMMIT_URL.exec(url))) return { label: `Commit ${m[1].slice(0, 7)}`, url }
    if (/canvas|design/i.test(key) || (canvas && /artifact/i.test(key))) return { label: "Design canvas", url }
    return { label: humanKey(key) || capText(/^https?:\/\/([^/?#]+)/i.exec(url)[1], 32), url }
  })
  const number = [ids.pr, ids.pr_number]
    .map((v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/^#/, "") : ""))
    .find((v) => /^\d{1,7}$/.test(v))
  if (number && !links.some((l) => l.label === `PR #${number}` || l.label.startsWith(`PR #${number} `))) links.unshift({ label: `PR #${number}`, url: "" })
  return links
}

/**
 * What a card's report says, for the details panel: null when the card has no report;
 * { unavailable, missing } when there is no file yet, { unavailable } when it can't be read as a
 * JSON object; else the job's own words, cleaned like card text and cut to fixed lengths:
 * status, summary and brief (its first sentences, { text, cut }), needs ([{ text, suggested }]),
 * links ([{ label, url }]), findings, verified and skipped (lists) with their counts, next,
 * branch and commit. Nothing in it is run or followed: values are only ever shown as text.
 */
export function reportFacts(path) {
  if (!path) return null
  const { report: r, entry } = readReport(path)
  if (!isRecord(r)) return entry ? { unavailable: true } : { unavailable: true, missing: true }
  if (entry?.facts) return entry.facts
  // Only text, numbers and booleans are shown; anything else reads "(not text)" (asText).
  let facts
  try {
    const ids = isRecord(r.ids) ? r.ids : {}
    const summary = capText(r.summary, 4000)
    const needs = (Array.isArray(r.needs_user) ? r.needs_user : r.needs_user ? [r.needs_user] : [])
      .slice(0, 20)
      .map((n) => ({ text: capText(itemText(n), 600), suggested: isRecord(n) ? capText(firstText(n, SUGGEST_FIELDS), 600) : "" }))
      .filter((n) => n.text)
    const next = capText(r.next, 2000)
    facts = {
      status: capText(r.status, 40).toLowerCase(),
      summary,
      brief: firstSentences(summary),
      needs,
      links: reportLinks(ids, [summary, next, ...needs.flatMap((n) => [n.text, n.suggested])]),
      findings: listOf(r.findings),
      verified: listOf(r.verified),
      skipped: listOf(r.skipped),
      counts: { findings: countOf(r.findings), verified: countOf(r.verified), skipped: countOf(r.skipped) },
      next,
      branch: capText(ids.branch, 200),
      commit: capText(ids.commit, 80),
    }
  } catch {
    facts = { unavailable: true }
  }
  if (entry) entry.facts = facts
  return facts
}

/** The agent behind a job card in this workspace, from Herdr's list. */
function agentOf(entry, agents, workspace) {
  if (!entry.job || !Array.isArray(agents)) return null
  return agents.find((a) => a.name === entry.job && (!workspace || a.workspace_id === workspace)) || null
}

const PLACE = { waiting: "Waiting on you", doing: "Doing", todo: "In To do" }

/** The line under the title: where the card is and for how long, in words. */
function statusLine(entry, now) {
  if (entry.live === "blocked") return "Waiting on you: its job is blocked"
  if (entry.column === "done") {
    const at = shortTime(entry.since, now)
    return at ? `Done ${/^\d\d:\d\d$/.test(at) ? "at " : ""}${at}` : "Done"
  }
  const age = entry.age == null ? "" : formatAge(entry.age)
  return `${own(PLACE, entry.column) ?? "Waiting on you"}${age === "just now" ? " since just now" : age ? ` for ${age}` : ""}`
}

const JOB_WORDS = { working: "is working", idle: "is idle at its prompt", blocked: "is blocked: it needs you in its tab", done: "finished", unknown: "is in an unknown state" }
const REPORT_WORDS = { done: "finished", blocked: "is blocked", failed: "failed" }

/**
 * The job in one line, as segments: "Job search-ui finished · its tab: search-ui (press t)",
 * "Job docs-links is working · 12 min". From the agent's live state, else what its report says.
 */
function jobLines(entry, agents, tabs, workspace, facts, width) {
  const agent = agentOf(entry, agents, workspace)
  const live = entry.live || (agent ? clean(agent.agent_status) : agents ? "no agent" : "")
  const said = own(REPORT_WORDS, facts?.status)
  const words = live === "no agent" ? (said ? `${said}; its agent is closed` : "has no agent running") : (own(JOB_WORDS, live) ?? said ?? "")
  const style = own(STATUS_STYLE, live) || (facts?.status === "done" ? "finished" : said ? "blocked" : "")
  const head = [{ t: "  " }, { t: `Job ${capText(entry.job, 40)}` }]
  if (words) head.push({ t: " " }, { t: words, s: style })
  if (live === "working" && entry.column === "doing" && entry.age != null) head.push({ t: ` · ${formatAge(entry.age)}`, s: "dim" })
  if (!agent) return [head]
  const label = capText(own(tabs, agent.tab_id), 60)
  const tab = label ? `its tab: ${label} (press t)` : "press t for its tab"
  if (segWidth(head) + 3 + textWidth(tab) <= width) return [[...head, { t: ` · ${tab}`, s: "dim" }]]
  return [head, [{ t: "  " }, { t: tab, s: "dim" }]]
}

/** Writers for the details panel's lines: they append to `out`, wrapped to `inner` cells, with whole URLs in `urls` as links. */
function writer(out, inner, urls) {
  const ind = { t: "  " }
  const blank = () => out.length && out.at(-1).length && out.push([])
  return {
    blank,
    heading(t) {
      blank()
      out.push([ind, { t, s: "head" }])
    },
    para(text, s = "") {
      for (const t of wrap(text, inner, Infinity)) out.push([ind, ...linkify(t, s, urls)])
    },
    // Each item from a "• ", over at most `max` lines (the last ends in "…" when cut).
    bullets(list, max = Infinity) {
      for (const text of list) wrap(text, inner - 2, max).forEach((t, i) => out.push([ind, { t: i ? "  " : "• ", s: "dim" }, ...linkify(t, "", urls)]))
    },
  }
}

// More… can run to a thousand lines on a maximal report, and the pane paints on every key and
// every few seconds: its lines are built once per report (its facts, cached while the file is
// unchanged), width and needs setting, then reused.
const moreBlocks = new WeakMap()

/** The rest of a report, under More…: the full summary, needs with suggested answers, findings, checks, skips, next, branch. */
function moreBlock(facts, width, needsInFull) {
  const key = `${width} ${needsInFull}`
  const known = moreBlocks.get(facts)
  if (known?.key === key) return known.lines
  const inner = Math.max(10, width - 2)
  const ind = { t: "  " }
  const urls = urlsIn(facts.summary, facts.next, ...facts.needs.flatMap((n) => [n.text, n.suggested]), ...facts.findings, ...facts.verified, ...facts.skipped)
  // It follows the More… line: it starts with a blank line.
  const out = [[]]
  const { blank, heading, para, bullets } = writer(out, inner, urls)
  if (facts.brief.cut) {
    heading("Full summary")
    para(facts.summary)
  }
  if (needsInFull) {
    heading("Needs you, in full")
    for (const n of facts.needs) {
      bullets([n.text])
      if (n.suggested) for (const t of wrap(`suggested: ${n.suggested}`, inner - 2, Infinity)) out.push([ind, { t: "  " }, ...linkify(t, "dim", urls)])
    }
  }
  for (const [title, list, count] of [
    ["Findings", facts.findings, facts.counts.findings],
    ["What was checked", facts.verified, facts.counts.verified],
    ["What was skipped", facts.skipped, facts.counts.skipped],
  ]) {
    if (!list.length) continue
    heading(title)
    bullets(list)
    if (count > list.length) out.push([ind, { t: `  +${count - list.length} more in the report`, s: "dim" }])
  }
  if (facts.next) {
    heading("What's next")
    para(facts.next)
  }
  if (facts.branch || facts.commit) {
    blank()
    out.push([ind, { t: [facts.branch && `Branch ${facts.branch}`, facts.commit && `commit ${facts.commit}`].filter(Boolean).join(" · "), s: "dim" }])
  }
  moreBlocks.set(facts, { key, lines: out })
  return out
}

/**
 * The details panel, in words, top to bottom: the title and where the card is; "What it is"
 * (the description); "What you need to do" (the ask, and the buttons as on the card); "From the
 * job" (its state and tab); "What the job reported", rewritten (its first sentences, what it
 * needs from you, its links, how much was checked); "More…" for the rest of the report; and when
 * the card was added and last changed. Never the report's path or field names.
 * `more` shows the rest; `button` is the chosen button (-1: none, and Enter is "More…");
 * `note` is the card's note from the answerer. Returns { lines, hasMore }.
 */
export function detailLines(entry, width, { agents = null, tabs = {}, workspace = "", now = new Date(), more = false, button = -1, note = null } = {}) {
  const inner = Math.max(10, width - 2)
  const ind = { t: "  " }
  const report = reportFacts(entry.report)
  const facts = report && !report.unavailable ? report : null
  const asks = asksOf(entry.ask)
  const urls = urlsIn(
    entry.title,
    entry.desc,
    entry.ask,
    ...(facts ? [facts.summary, facts.brief.text, facts.next, ...facts.needs.flatMap((n) => [n.text, n.suggested]), ...facts.findings, ...facts.verified, ...facts.skipped] : []),
  )
  const lines = []
  const { blank, heading, para, bullets } = writer(lines, inner, urls)

  for (const t of wrap(capText(entry.title, 400), width, Infinity)) lines.push(linkify(t, "title", urls))
  lines.push([ind, { t: statusLine(entry, now), s: "dim" }])

  if (clean(entry.desc)) {
    heading("What it is")
    para(capText(entry.desc, 4000))
  }

  const blocked = entry.live === "blocked"
  const options = shownOptions(entry)
  if (asks.length || options.length || blocked) {
    heading("What you need to do")
    if (blocked && !asks.length) lines.push([ind, { t: "→ answer it in its tab (press t)", s: "ask" }])
    for (const ask of asks) wrap(capText(ask, 2000), inner - 2, Infinity).forEach((t, i) => lines.push([ind, { t: i ? "  " : "→ ", s: "ask" }, ...linkify(t, "ask", urls)]))
    if (options.length) {
      const at = shortTime(entry.sent?.at, now)
      if (entry.sent?.label) lines.push([ind, { t: `sent: ${capText(entry.sent.label, 60)}${at ? ` · ${at}` : ""}`, s: "dim" }])
      // The card's own buttons; marked as the panel's, so a click on them works over the board.
      for (const l of buttonLines(entry, width, ind, button)) lines.push(l.map((seg) => (seg.button ? { ...seg, button: { ...seg.button, panel: true } } : seg)))
    }
    if (note) for (const t of wrap(note.t, inner, 3)) lines.push([ind, { t, s: note.s }])
  }

  if (entry.job) {
    heading("From the job")
    lines.push(...jobLines(entry, agents, tabs, workspace, facts, width))
  }

  // What the report adds beyond the ask: its needs, unless the ask already says them (job-report
  // copies needs_user into the ask).
  const asked = asks.map(clean)
  const needs = facts ? facts.needs.filter((n) => !asked.some((a) => a === n.text || (n.text.endsWith("…") && a.startsWith(n.text.slice(0, -1))))) : []
  const needsInFull = facts && (needs.length > 5 || facts.needs.some((n) => n.suggested) || needs.some((n) => wrap(n.text, inner - 2, Infinity).length > 2))
  if (entry.report) {
    heading("What the job reported")
    if (!facts) lines.push([ind, { t: report?.missing ? "Nothing yet: the job hasn't written its report." : "The report can't be read: it isn't a JSON object of at most 1 MB.", s: "dim" }])
    else {
      if (facts.status === "blocked" || facts.status === "failed") lines.push([ind, { t: facts.status === "failed" ? "The job failed." : "The job is blocked.", s: "blocked" }])
      else if (facts.status !== "done") lines.push([ind, { t: "Not final yet: the job may still change it.", s: "dim" }])
      if (facts.brief.text) para(facts.brief.text)
      if (needs.length) {
        lines.push([ind, { t: "Needs you:", s: "head" }])
        bullets(needs.slice(0, 5).map((n) => n.text), 2)
        if (needs.length > 5) lines.push([ind, { t: `  +${needs.length - 5} more under More…`, s: "dim" }])
      }
      if (facts.links.length) {
        lines.push([ind, { t: "Links:", s: "head" }])
        const w = Math.min(24, Math.max(...facts.links.map((l) => textWidth(l.label))))
        for (const { label, url } of facts.links) {
          // The URL is the link's visible text (OSC 8); on its own line when the label leaves no room.
          const link = { t: url, s: "link", link: url }
          if (!url) lines.push([ind, { t: label }])
          else if (2 + w + 2 + textWidth(url) <= width) lines.push([ind, { t: label }, { t: " ".repeat(Math.max(0, w - textWidth(label)) + 2) }, link])
          else lines.push([ind, { t: label }], [ind, { t: "  " }, link])
        }
      }
      const { verified, skipped, findings } = facts.counts
      const counts = [verified && `${verified} thing${verified === 1 ? "" : "s"} checked`, skipped && `${skipped} skipped`, findings && `${findings} finding${findings === 1 ? "" : "s"}`]
      if (counts.some(Boolean)) lines.push([ind, { t: counts.filter(Boolean).join(" · "), s: "dim" }])
    }
  }

  // "More…": the rest of the report, for whoever wants it.
  const rest = facts
    ? [
        facts.brief.cut && "full summary",
        needsInFull && (facts.needs.some((n) => n.suggested) ? "suggested answers" : "every need"),
        facts.findings.length && "findings",
        facts.verified.length && "checks",
        facts.skipped.length && "skips",
        facts.next && "next steps",
        (facts.branch || facts.commit) && "branch",
      ].filter(Boolean)
    : []
  const hasMore = rest.length > 0
  if (hasMore) {
    blank()
    // The keys first: a narrow pane cuts the end of the line.
    const keys = button < 0 ? "f or Enter" : "f"
    lines.push([ind, { t: more ? "▾ Less" : "▸ More…", s: button < 0 ? "selected" : "button", more: true }, { t: more ? ` (${keys})` : ` (${keys})  ${rest.join(", ")}`, s: "dim", more: true }])
    if (more) lines.push(...moreBlock(facts, width, needsInFull))
  }

  const added = shortTime(entry.created, now)
  const changed = entry.updated && entry.updated !== entry.created ? shortTime(entry.updated, now) : ""
  const times = [added && `Added ${added}`, changed && `${added ? "last" : "Last"} changed ${changed}`].filter(Boolean).join(" · ")
  if (times) {
    blank()
    lines.push([ind, { t: times, s: "dim" }])
  }
  return { lines, hasMore }
}

/**
 * What c copies for a card: its first link (in the title, description, ask, then the report's
 * links, summary and needs), else the card as plain text. { text, what: "link" | "card" }.
 */
export function copyPayload(entry) {
  const report = reportFacts(entry.report)
  const facts = report && !report.unavailable ? report : null
  const sources = [entry.title, entry.desc, entry.ask, ...(facts ? [...facts.links.map((l) => l.url), facts.summary, ...facts.needs.map((n) => n.text)] : [])]
  for (const text of sources) {
    const [first] = findUrls(text)
    if (first) return { text: first.url, what: "link" }
  }
  const parts = [`#${entry.id ?? entry.job} ${clean(entry.title)}`, clean(entry.desc), asksOf(entry.ask).map((a) => `→ ${clean(a)}`).join("\n")]
  const options = optionsOf(entry).map((o) => o.label)
  if (options.length) parts.push(`buttons: ${options.join(" · ")}`)
  return { text: parts.filter(Boolean).join("\n\n"), what: "card" }
}

// --- the board -----------------------------------------------------------------------------

/**
 * Lay the board out in `width` × `height` cells (height Infinity: everything, no scrolling).
 * Wide: WAITING ON YOU across the top (two cards a row from 110 cells), DOING | TO DO | DONE in
 * three columns below. Waiting takes what it needs up to half the height (more only when the
 * bottom doesn't need it) and shrinks to one line when empty. Under STACK_BELOW cells the four
 * sections stack. Each section scrolls on its own and has a selected card; `scroll` is
 * { selected, anchors, card, button, detail } where an anchor is a section's first visible card,
 * so the view holds still as cards come and go, and `detail` ({ key, offset, more }) opens a
 * card's details over the lower half: an opaque panel from the middle down to the key line,
 * between a "── card N ──" rule and a closing rule, with nothing of the board inside it. `links`
 * turns whole URLs into terminal hyperlinks; `footer` ({ message, mouse }) adds to the key hint
 * line.
 * Returns { text, sections (per section: blockKeys, offset, maxOffset, page, cards), regions
 * (screen rectangles, 1-based), buttons, cardHits and moreHits (where each button, card and the
 * details' "More…" line is, for the mouse), entries (by key), scroll (as drawn) }.
 */
export function renderBoard(view, opts = {}) {
  const { height = Infinity, color = false, links = false, now = new Date(), repo = "", error = "", interactive = false } = opts
  const width = Math.max(20, Math.floor(opts.width ?? 100))
  const scroll = { ...(opts.scroll || {}), selected: opts.scroll?.selected || "waiting", anchors: { ...(opts.scroll?.anchors || {}) } }
  const notes = opts.notes || {}
  const finite = Number.isFinite(height)
  const paint = (segs, w = width) => paintLine(segs, w, color, links)

  const clock = clockOf(now)
  const name = `Job board${repo ? ` · ${repo}` : ""}`
  const out = [pad(paint([{ t: name, s: "title" }], width - clock.length - 1), width - clock.length) + paint([{ t: clock, s: "dim" }], clock.length).text]
  if (error) out.push(paint([{ t: error, s: "blocked" }]).text)
  out.push("")
  const sections = {}
  const regions = {}
  const buttons = []
  const cardHits = []
  const moreHits = []
  const entries = Object.fromEntries(SECTIONS.flatMap((s) => entriesOf(view, s).map((e) => [keyOf(e), { ...e, column: e.column ?? s }])))
  // Paint a line at screen row `row` from column `left`, noting where its buttons and cards are.
  const emit = (segs, row, left, w) => {
    let x = left
    for (const seg of segs) {
      const sw = textWidth(printable(seg.t))
      const x1 = Math.min(x + sw, left + w) - 1
      if (sw && x < left + w) {
        if (seg.button) buttons.push({ ...seg.button, y: row, x0: x, x1 })
        if (seg.more) moreHits.push({ y: row, x0: x, x1 })
        if (seg.card) {
          const last = cardHits.at(-1)
          if (last && last.key === seg.card && last.y === row && last.x1 >= x - 1) last.x1 = x1
          else cardHits.push({ key: seg.card, y: row, x0: x, x1 })
        }
      }
      x += sw
    }
    return paint(segs, w)
  }

  // Cards carry their notes everywhere, so heights are the same before and after selection.
  const noted = (e) => ({ note: notes[keyOf(e)] })
  // The selected section's selected card: the one chosen, else the first one in view. Its
  // button is chosen only with ← →, never in advance.
  const uiFor = (section, perRow, w, h) => {
    const plain = sectionBlocks(view, section, w, perRow, noted)
    const list = entriesOf(view, section)
    if (!interactive || scroll.selected !== section || !list.length) return plain
    const anchor = scroll.anchors[section]
    const at = anchor ? Math.max(0, plain.findIndex((b) => b.keys.includes(anchor.key))) : 0
    const v = viewport(plain, h, at)
    let current = list.find((e) => keyOf(e) === scroll.card)
    if (!current) current = list.find((e) => keyOf(e) === plain[v.offset]?.keys[0]) || list[0]
    const shown = shownOptions(current, section)
    const count = shown.length ? shown.length + 1 : 0
    if (scroll.card !== keyOf(current) || !(scroll.button >= 0 && scroll.button < count)) scroll.button = -1
    scroll.card = keyOf(current)
    return sectionBlocks(view, section, w, perRow, (e) => ({ ...noted(e), selected: keyOf(e) === scroll.card, button: keyOf(e) === scroll.card ? scroll.button : -1 }))
  }

  // Where a section's anchor (its first visible card) is now.
  const offsetOf = (section, blocks) => {
    const anchor = scroll.anchors[section]
    if (!anchor) return 0
    const i = blocks.findIndex((b) => b.keys.includes(anchor.key))
    return i >= 0 ? i : Math.min(anchor.index ?? 0, Math.max(0, blocks.length - 1))
  }
  // Lines a section really uses in `h` lines (whole cards only, so often fewer).
  const used = (section, blocks, h) => (blocks.length ? 1 + viewport(blocks, h - 1, offsetOf(section, blocks)).lines.length : Math.min(h, section === "waiting" ? 1 : 2))
  const place = (section, blocks, h) => {
    let v = viewport(blocks, h, offsetOf(section, blocks))
    // The selected card stays in view: scroll the least that shows it.
    if (interactive && section === scroll.selected && scroll.card && Number.isFinite(h)) {
      const b = blocks.findIndex((x) => x.keys.includes(scroll.card))
      if (b >= 0 && b < v.offset) v = viewport(blocks, h, b)
      while (b >= 0 && b >= v.offset + v.page && v.offset < v.maxOffset) v = viewport(blocks, h, v.offset + 1)
    }
    const blockCards = blocks.map((b) => b.keys)
    sections[section] = {
      blockKeys: blocks.map((b) => b.keys[0]),
      blockCards,
      offset: v.offset,
      maxOffset: v.maxOffset,
      page: v.page,
      cards: entriesOf(view, section).map((e) => ({
        key: keyOf(e),
        id: e.id,
        // Only buttons on screen count: a card whose buttons are hidden has none to choose or press.
        buttons: shownOptions(e, section).length ? shownOptions(e, section).length + 1 : 0,
        labels: shownOptions(e, section).map((o) => o.label),
        suggested: Math.max(0, shownOptions(e, section).findIndex((o) => o.suggested)),
        block: Math.max(0, blockCards.findIndex((keys) => keys.includes(keyOf(e)))),
      })),
    }
    if (blocks.length) scroll.anchors[section] = { key: blocks[v.offset].keys[0], index: v.offset }
    else delete scroll.anchors[section]
    return blocks.length ? v.lines : [[{ t: "nothing", s: "dim" }]]
  }
  const header = (section) => headerLine(view, section, interactive && scroll.selected === section)
  const room = finite ? height - out.length - (interactive ? 1 : 0) : Infinity

  if (width >= STACK_BELOW) {
    const gap = 3
    const cw = Math.floor((width - 2 * gap) / 3)
    const perRow = width >= 110 ? 2 : 1
    let wBlocks = sectionBlocks(view, "waiting", width, perRow, noted)
    const bottom = ["doing", "todo", "done"]
    const bBlocks = bottom.map((c) => sectionBlocks(view, c, cw, 1, noted))
    const wWant = wBlocks.length ? 1 + contentHeight(wBlocks) : 1
    const bWant = 1 + Math.max(...bBlocks.map(contentHeight))
    let wH = wWant
    let bH = bWant
    if (finite) {
      const r = room - 1
      if (wBlocks.length) wH = Math.max(Math.min(wWant, 2), Math.min(wWant, Math.max(r - bWant, Math.floor(r / 2))))
      bH = Math.max(2, r - wH)
    }
    const wTop = out.length + 1
    out.push(paint(header("waiting")).text)
    if (wBlocks.length) {
      wBlocks = uiFor("waiting", perRow, width, wH - 1)
      // Lines Waiting can't fill with whole cards go to the bottom.
      if (finite) {
        wH = used("waiting", wBlocks, wH)
        bH = Math.max(2, room - 1 - wH)
      }
      for (const l of place("waiting", wBlocks, wH - 1)) out.push(emit(l, out.length + 1, 1, width).text.trimEnd())
    } else place("waiting", wBlocks, 0)
    regions.waiting = { top: wTop, bottom: out.length, left: 1, right: width }
    out.push("")
    const bTop = out.length + 1
    const bodies = bottom.map((c, i) => place(c, uiFor(c, 1, cw, bH - 1), bH - 1))
    const row = (cells, y) => cells.map((segs, i) => (i < 2 ? pad(emit(segs, y, 1 + i * (cw + gap), cw), cw + gap) : emit(segs, y, 1 + i * (cw + gap), cw).text)).join("").trimEnd()
    out.push(row(bottom.map(header), out.length + 1))
    const rows = finite ? bH - 1 : Math.max(...bodies.map((b) => b.length))
    for (let r = 0; r < rows; r++) out.push(row(bodies.map((b) => b[r] || []), out.length + 1))
    bottom.forEach((c, i) => {
      regions[c] = { top: bTop, bottom: bTop + rows, left: 1 + i * (cw + gap), right: i * (cw + gap) + cw }
    })
  } else {
    let all = SECTIONS.map((s) => sectionBlocks(view, s, width, 1, noted))
    const wants = all.map((blocks, i) => (blocks.length ? 1 + contentHeight(blocks) : SECTIONS[i] === "waiting" ? 1 : 2))
    const heights = finite ? share(wants, room - (SECTIONS.length - 1)) : wants
    all = all.map((blocks, i) => (blocks.length ? uiFor(SECTIONS[i], 1, width, heights[i] - 1) : blocks))
    if (finite) {
      // Each section keeps the lines it fills with whole cards; the rest goes to the first one
      // (Waiting, then Doing, To do, Done) that shows more cards with it.
      let spare = 0
      SECTIONS.forEach((s, i) => {
        const u = used(s, all[i], heights[i])
        spare += heights[i] - u
        heights[i] = u
      })
      SECTIONS.forEach((s, i) => {
        if (spare <= 0 || !all[i].length) return
        const u = used(s, all[i], heights[i] + spare)
        if (u > heights[i]) {
          spare -= u - heights[i]
          heights[i] = u
        }
      })
    }
    SECTIONS.forEach((s, i) => {
      if (i) out.push("")
      const sTop = out.length + 1
      out.push(paint(header(s)).text)
      if (s !== "waiting" || all[i].length) for (const l of place(s, all[i], heights[i] - 1)) out.push(emit(l, out.length + 1, 1, width).text.trimEnd())
      else place(s, all[i], 0)
      regions[s] = { top: sTop, bottom: out.length, left: 1, right: width }
    })
  }

  const lines = finite ? out.slice(0, height - (interactive ? 1 : 0)) : out

  // A card's details, over the lower half: every row from the middle to the key line is the
  // panel's, blank where it has nothing, so no card shows through; a rule closes it.
  const detailEntry = interactive && scroll.detail ? entries[scroll.detail.key] : null
  if (scroll.detail && !detailEntry) delete scroll.detail
  let detailInfo = null
  if (detailEntry) {
    if (finite) while (lines.length < height - 1) lines.push("")
    const top = finite ? Math.max(0, Math.min(Math.floor(height / 2), height - 4)) : lines.length
    const key = scroll.detail.key
    const chosen = scroll.card === key ? (scroll.button ?? -1) : -1
    let body
    let hasMore = false
    try {
      ;({ lines: body, hasMore } = detailLines(detailEntry, width, {
        agents: opts.agents,
        tabs: opts.tabs,
        workspace: opts.workspace,
        now,
        more: scroll.detail.more === true,
        button: chosen,
        note: notes[key],
      }))
    } catch (e) {
      body = [[{ t: "  " }, { t: `details unavailable: ${clean(e?.message).slice(0, 120)}`, s: "blocked" }]]
    }
    // Rows for the body: all but the two rules.
    const room2 = finite ? Math.max(1, height - 1 - top - 2) : body.length
    const maxOffset = Math.max(0, body.length - room2)
    const offset = Math.max(0, Math.min(scroll.detail.offset || 0, maxOffset))
    scroll.detail = { key, offset, maxOffset, page: Math.max(1, room2 - 1), more: hasMore && scroll.detail.more === true, hasMore }
    const name = detailEntry.id ?? detailEntry.job
    const rule = (label) => [{ t: "──", s: "dim" }, { t: label, s: "head" }, { t: "─".repeat(Math.max(0, width - 2 - textWidth(label))), s: "dim" }]
    const below = maxOffset - offset
    const panel = [rule(` card ${name} ${offset ? `· ↑ ${offset} line${offset === 1 ? "" : "s"} above ` : ""}`), ...body.slice(offset, offset + room2)]
    while (panel.length < 1 + room2) panel.push([])
    panel.push(rule(below ? ` ↓ ${below} more line${below === 1 ? "" : "s"} ` : ` end of card ${name} `))
    for (let i = 0; i < panel.length; i++) lines[top + i] = emit(panel[i], top + i + 1, 1, width).text.trimEnd()
    if (finite) lines.length = height - 1
    regions.detail = { top: top + 1, bottom: Math.min(top + panel.length, lines.length), left: 1, right: width }
    detailInfo = { buttons: shownOptions(detailEntry).length > 0, more: hasMore }
  }
  // Nothing of the board under the details panel can be clicked; the panel's own buttons can.
  const covered = (y) => regions.detail && y >= regions.detail.top
  if (interactive) {
    if (finite) while (lines.length < height - 1) lines.push("")
    const mouse = opts.footer?.mouse || "board"
    const wide = width >= 80
    const keys = detailInfo ? detailHint(wide, detailInfo.buttons, detailInfo.more) : wide ? HINT(mouse) : HINT_NARROW(mouse)
    const message = opts.footer?.message
    lines.push(paint([...(message ? [{ t: message, s: "ask" }, { t: " · ", s: "dim" }] : []), { t: keys, s: "dim" }]).text)
  }
  return {
    text: lines.join("\n"),
    sections,
    regions,
    buttons: buttons.filter((b) => b.y <= lines.length && (b.panel || !covered(b.y))),
    cardHits: cardHits.filter((c) => c.y <= lines.length && !covered(c.y)),
    moreHits: moreHits.filter((m) => m.y <= lines.length),
    entries,
    scroll,
  }
}

/** The board as text, everything shown (for `ls`), or as the pane draws it. */
export function render(view, opts = {}) {
  return renderBoard(view, opts).text
}

// --- keys and mouse -------------------------------------------------------------------------

const LETTER_KEYS = { A: "up", B: "down", C: "right", D: "left", Z: "prev", H: "top", F: "bottom" }
const TILDE_KEYS = { 1: "top", 7: "top", 4: "bottom", 8: "bottom", 5: "pageup", 6: "pagedown" }
const CHAR_KEYS = {
  "\t": "next",
  j: "down",
  k: "up",
  g: "top",
  G: "bottom",
  q: "quit",
  "\x03": "quit",
  r: "redraw",
  "\r": "enter",
  "\n": "enter",
  o: "other",
  c: "copy",
  f: "more",
  t: "tab",
  m: "mouse",
}

/**
 * Terminal input as events: { type: "key", name } (next and prev for Tab and Shift-Tab, left,
 * right, up, down, pageup, pagedown, top, bottom, enter, escape, other, copy, more, tab, mouse,
 * quit, redraw), { type: "wheel", dir: "up" | "down", x, y } and { type: "click", x, y } from SGR
 * (1006) mouse reports. Anything else is skipped.
 */
export function parseInput(text) {
  const events = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
    if (m) {
      const [b, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
      if (b & 64) events.push({ type: "wheel", dir: b & 1 ? "down" : "up", x, y })
      else if (m[4] === "M" && !(b & 32) && (b & 3) === 0) events.push({ type: "click", x, y })
      i += m[0].length
      continue
    }
    // Keys are CSI or SS3 sequences with plain numeric parameters. Anything else that starts
    // a control sequence (a terminal's replies such as ESC [?1;2c or ESC ]11;…BEL, other
    // private sequences) is skipped whole, so none of its characters is read as a key.
    m = /^\x1b(?:\[([0-9;?<>=]*)[ -\/]*([@-~])|O([@-~]))/.exec(rest)
    if (m) {
      const params = m[1] ?? ""
      const final = m[2] ?? m[3]
      const name = /[?<>=]/.test(params) ? null : final === "~" ? TILDE_KEYS[params.split(";")[0]] : LETTER_KEYS[final]
      if (name) events.push({ type: "key", name })
      i += m[0].length
      continue
    }
    m = /^\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/.exec(rest)
    if (m && rest.length > 1) {
      i += m[0].length
      continue
    }
    // Escape followed by another character in the same read is an Alt chord (Alt+c is ESC c):
    // skipped whole, so it never acts as that key. Escape on its own, or before another
    // escape, is the Esc key.
    if (text[i] === "\x1b") {
      if (i + 1 < text.length && text[i + 1] !== "\x1b") {
        i += [...text.slice(i + 1, i + 3)][0].length + 1
        continue
      }
      events.push({ type: "key", name: "escape" })
      i += 1
      continue
    }
    const name = CHAR_KEYS[text[i]]
    if (name) events.push({ type: "key", name })
    i += 1
  }
  return events
}

const sectionAt = (regions, x, y) =>
  SECTIONS.find((s) => regions[s] && y >= regions[s].top && y <= regions[s].bottom && x >= regions[s].left && x <= regions[s].right)
const DOUBLE_CLICK_MS = 400

/**
 * One input event against the screen the user sees (`drawn`, from renderBoard): the new state
 * and maybe an action for the pane to carry out: { type: "send", id, key, label },
 * { type: "other", id, key }, { type: "copy", key }, { type: "tab", key } or { type: "mouse" }.
 * - Tab / Shift-Tab select a section, as do ← → unless a card's buttons take them; ↑ ↓ select a
 *   card in the section, scrolling to keep it in view; PgUp PgDn scroll a page, g G go to the
 *   ends; the mouse wheel scrolls the section under the pointer.
 * - Enter opens the selected card's details (Esc closes them), or, once ← → chose one of its
 *   buttons, presses that button; o is Other…; c copies, t goes to the job's tab, m toggles
 *   mouse capture. A click selects a card, a double click opens it, a click on a button
 *   presses it.
 * - In the details: ↑ ↓ PgUp PgDn g G and the wheel scroll them; ← → choose one of the card's
 *   buttons and Enter presses it, as on the card; with no button chosen, Enter (or f, or a
 *   click on the line) shows or hides "More…", and when there is no more, Enter closes them.
 *   A click on the panel's buttons presses them; a click elsewhere on the panel does nothing,
 *   and above it closes the panel.
 * Events may carry `at` (ms), used for double clicks.
 */
export function handleInput(scroll, event, drawn) {
  const next = { ...scroll, selected: scroll.selected || "waiting", anchors: { ...(scroll.anchors || {}) } }
  let action = null
  const name = event.type === "key" ? event.name : event.type
  const s = next.selected
  const cards = drawn.sections[s]?.cards || []
  const current = cards.find((c) => c.key === next.card) || null
  const scrollTo = (section, to) => {
    const info = drawn.sections[section]
    if (!info || !info.blockKeys.length) return
    const o = Math.max(0, Math.min(to, info.maxOffset))
    next.anchors[section] = { key: info.blockKeys[o], index: o }
    // Scrolling the selected section moves its selection to the first card in view.
    if (section === next.selected) {
      delete next.card
      next.button = -1
    }
  }
  const at = (section) => drawn.sections[section]?.offset ?? 0
  const step = (dir) => SECTIONS[(SECTIONS.indexOf(next.selected) + dir + SECTIONS.length) % SECTIONS.length]
  const press = (card, index) => {
    if (!card || card.id == null || !card.buttons) return null
    const label = index < card.labels.length ? card.labels[index] : null
    return label === null ? { type: "other", id: card.id, key: card.key } : { type: "send", id: card.id, key: card.key, label }
  }
  const selectSection = (section) => {
    if (section !== next.selected) {
      next.selected = section
      delete next.card
      next.button = -1
    }
  }
  const detail = next.detail ? { ...next.detail } : null
  // The card shown in the details, as a Waiting card with buttons (else null), and its chosen button.
  const shownCard = detail ? (drawn.sections.waiting?.cards || []).find((c) => c.key === detail.key && c.buttons) || null : null
  const chosen = detail && next.card === detail.key ? (next.button ?? -1) : -1
  const toggleMore = () => {
    if (detail.hasMore) next.detail = { ...detail, more: !detail.more }
  }
  const choose = (index) => {
    selectSection("waiting")
    next.card = detail.key
    next.button = index
  }

  // With the details open, keys work on them.
  if (detail && event.type === "key") {
    const page = detail.page || 1
    if (name === "escape") {
      delete next.detail
      next.button = -1
    } else if (name === "enter") {
      if (shownCard && chosen >= 0) action = press(shownCard, chosen)
      else if (detail.hasMore) toggleMore()
      else delete next.detail
    } else if (name === "more") toggleMore()
    else if ((name === "left" || name === "right") && shownCard) {
      choose(chosen < 0 ? shownCard.suggested || 0 : Math.max(0, Math.min(chosen + (name === "right" ? 1 : -1), shownCard.buttons - 1)))
    } else if (name === "other") {
      if (shownCard) action = press(shownCard, shownCard.buttons - 1)
    } else if (name === "up") next.detail = { ...detail, offset: Math.max(0, detail.offset - 1) }
    else if (name === "down") next.detail = { ...detail, offset: Math.min(detail.maxOffset ?? 0, detail.offset + 1) }
    else if (name === "pageup") next.detail = { ...detail, offset: Math.max(0, detail.offset - page) }
    else if (name === "pagedown") next.detail = { ...detail, offset: Math.min(detail.maxOffset ?? 0, detail.offset + page) }
    else if (name === "top") next.detail = { ...detail, offset: 0 }
    else if (name === "bottom") next.detail = { ...detail, offset: detail.maxOffset ?? 0 }
    else if (name === "copy") action = { type: "copy", key: detail.key }
    else if (name === "tab") action = { type: "tab", key: detail.key }
    else if (name === "mouse") action = { type: "mouse" }
    return { scroll: next, action }
  }
  if (detail && event.type === "wheel" && drawn.regions.detail && event.y >= drawn.regions.detail.top) {
    const offset = Math.max(0, Math.min(detail.maxOffset ?? 0, detail.offset + (event.dir === "up" ? -1 : 1)))
    return { scroll: { ...next, detail: { ...detail, offset } }, action }
  }
  if (detail && event.type === "click") {
    if (drawn.regions.detail && event.y >= drawn.regions.detail.top) {
      const within = (h) => h.y === event.y && event.x >= h.x0 && event.x <= h.x1
      const hit = (drawn.buttons || []).find((b) => b.panel && within(b))
      if (hit && shownCard && hit.key === detail.key) {
        choose(hit.index)
        action = press(shownCard, hit.index)
      } else if ((drawn.moreHits || []).some(within)) toggleMore()
      return { scroll: next, action }
    }
    delete next.detail
  }

  if (event.type === "click") {
    const hit = (drawn.buttons || []).find((b) => b.y === event.y && event.x >= b.x0 && event.x <= b.x1)
    const onCard = (drawn.cardHits || []).find((c) => c.y === event.y && event.x >= c.x0 && event.x <= c.x1)
    const section = sectionAt(drawn.regions, event.x, event.y)
    if (hit) {
      selectSection("waiting")
      next.card = hit.key
      next.button = hit.index
      action = press((drawn.sections.waiting?.cards || []).find((c) => c.key === hit.key), hit.index)
    } else if (onCard && section) {
      selectSection(section)
      const double = next.lastClick && next.lastClick.key === onCard.key && (event.at ?? 0) - (next.lastClick.at ?? 0) <= DOUBLE_CLICK_MS
      if (next.card !== onCard.key) next.button = -1
      next.card = onCard.key
      // Details always open with no button chosen: Enter there is never a send until ← → choose.
      if (double) {
        next.detail = { key: onCard.key, offset: 0 }
        next.button = -1
      }
    } else if (section) selectSection(section)
    next.lastClick = onCard && !hit ? { key: onCard.key, at: event.at ?? 0 } : null
  } else if (event.type === "wheel") {
    const target = sectionAt(drawn.regions, event.x, event.y)
    if (target) scrollTo(target, at(target) + (event.dir === "up" ? -1 : 1))
  } else if (current && (name === "up" || name === "down")) {
    // The view follows the selection (renderBoard keeps the selected card in view).
    const i = Math.max(0, Math.min(cards.indexOf(current) + (name === "up" ? -1 : 1), cards.length - 1))
    next.card = cards[i].key
    next.button = -1
  } else if (current && current.buttons && (name === "left" || name === "right")) {
    // The first ← or → chooses the suggested button (or the first); then they move.
    const b = scroll.button ?? -1
    next.button = b < 0 ? current.suggested || 0 : Math.max(0, Math.min(b + (name === "right" ? 1 : -1), current.buttons - 1))
  } else if (name === "enter") {
    if (current && current.buttons && (scroll.button ?? -1) >= 0) action = press(current, scroll.button)
    else if (current) {
      next.detail = { key: current.key, offset: 0 }
      next.button = -1
    }
  } else if (name === "escape") {
    next.button = -1
  } else if (name === "other") {
    if (current?.buttons) action = press(current, current.buttons - 1)
  } else if (name === "copy") {
    if (current) action = { type: "copy", key: current.key }
  } else if (name === "tab") {
    if (current) action = { type: "tab", key: current.key }
  } else if (name === "mouse") action = { type: "mouse" }
  else if (name === "next" || name === "right") selectSection(step(1))
  else if (name === "prev" || name === "left") selectSection(step(-1))
  else if (name === "up") scrollTo(s, at(s) - 1)
  else if (name === "down") scrollTo(s, at(s) + 1)
  else if (name === "pageup") scrollTo(s, at(s) - (drawn.sections[s]?.page || 1))
  else if (name === "pagedown") scrollTo(s, at(s) + (drawn.sections[s]?.page || 1))
  else if (name === "top") {
    scrollTo(s, 0)
    if (cards.length) next.card = cards[0].key
  } else if (name === "bottom") {
    scrollTo(s, Infinity)
    if (cards.length) next.card = cards.at(-1).key
  }
  return { scroll: next, action }
}

/** handleInput without the action: the state after the event. */
export const applyInput = (scroll, event, drawn) => handleInput(scroll, event, drawn).scroll

// --- answering from the board -------------------------------------------------------------------

/** Exactly what a button sends to the coordinator: nothing else from the card goes. */
export function answerText(item, label) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0) throw new Error("the card has no valid id")
  return `Board card ${item.id} (${clean(item.title)}): ${clean(label)}`
}

/**
 * Whether pressing `label` on `item` sends now. A card already answered asks first ("send
 * again?"); a second press of the same button within 10 s sends. Returns
 * { send, confirm (to keep for the next press), note (to show on the card) }.
 */
export function sendDecision(item, label, confirm, nowMs) {
  if (!item?.sent?.label) return { send: true, confirm: null, note: null }
  if (confirm && confirm.id === item.id && confirm.label === label && nowMs - confirm.at < 10_000) return { send: true, confirm: null, note: null }
  return {
    send: false,
    confirm: { id: item.id, label, at: nowMs },
    note: { t: `send again? "${item.sent.label}" was sent already; press ${label} again to send it`, s: "ask" },
  }
}

const HERDR_ERRORS = {
  agent_not_found: "coordinator pane not found",
  pane_not_found: "coordinator pane not found",
  agent_blocked: "the coordinator is waiting on a question in its pane; answer it there, then press again",
  // Herdr declines while the agent shows a prompt or is otherwise not ready for input.
  agent_not_ready: "the coordinator isn't taking input right now (a prompt may be open in its pane); press again in a moment, or type the answer there",
}

/** Run herdr; resolves to null, or to an error message when it failed. */
function herdrCall(args, env) {
  return new Promise((done) => {
    execFile(herdrBin(env), args, { env, timeout: 10_000 }, (error, stdout, stderr) => {
      if (!error) return done(null)
      let e = {}
      try {
        e = JSON.parse(stderr || stdout).error || {}
      } catch {}
      done(clean(HERDR_ERRORS[e.code] || e.message || stderr || error.message).slice(0, 160) || "herdr failed")
    })
  })
}

/**
 * Carry out a button press. "send": `herdr agent prompt <origin> <text>` (argv only, never a
 * shell), and nothing else: Herdr checks the agent's state itself and refuses an agent that is
 * waiting on a question, so a button can never press Enter on someone else's prompt. "other":
 * `herdr agent focus <origin>`, so the user can type the answer; nothing is typed for them.
 * Resolves to an error message, or null.
 */
export async function deliver(action, item, origin, env = process.env) {
  if (!inHerdr(env)) return "not inside Herdr"
  if (!origin) return "no coordinator pane known; open the board with board.mjs open"
  if (action.type === "send") return herdrCall(["agent", "prompt", origin, answerText(item, action.label)], env)
  return herdrCall(["agent", "focus", origin], env)
}

/**
 * Button presses, one at a time. A press on a card that is still sending is ignored, so a
 * double click sends once; a card answered already asks "send again?" first (sendDecision).
 * Every failure becomes a note on the card; nothing here can stop the pane. `notes` maps a
 * card's key to the line shown on it.
 */
export function createAnswerer({ file, origin = "", env = process.env, now = () => new Date(), send = deliver, onChange = () => {} }) {
  const notes = {}
  const sending = new Set()
  let confirm = null
  let chain = Promise.resolve()
  const run = async (action) => {
    const item = readBoard(file).items.find((i) => i.id === action.id)
    if (!item || item.column !== "waiting") return
    if (action.type === "send") {
      const decision = sendDecision(item, action.label, confirm, now().getTime())
      confirm = decision.confirm
      if (!decision.send) {
        notes[action.key] = decision.note
        return
      }
    }
    notes[action.key] = { t: action.type === "send" ? `sending: ${clean(action.label)}…` : "opening the chat…", s: "dim" }
    onChange()
    const error = await send(action, item, origin, env)
    if (error) {
      notes[action.key] = { t: `${action.type === "send" ? "couldn't send" : "couldn't open the chat"}: ${error}`, s: "blocked" }
      return
    }
    if (action.type === "other") {
      notes[action.key] = { t: `type your answer for card ${item.id} in the coordinator's chat`, s: "dim" }
      return
    }
    delete notes[action.key]
    try {
      markSent(file, item.id, action.label, now())
    } catch (e) {
      notes[action.key] = { t: `sent, but couldn't note it on the card: ${clean(e.message)}`, s: "blocked" }
    }
  }
  return {
    notes,
    press(action) {
      if (sending.has(action.key)) return chain
      sending.add(action.key)
      chain = chain
        .then(() => run(action))
        .catch((e) => {
          notes[action.key] = { t: `couldn't send: ${clean(e?.message || e)}`, s: "blocked" }
        })
        .finally(() => {
          sending.delete(action.key)
          onChange()
        })
      return chain
    },
  }
}

/** Note on the card that `label` was sent, so it isn't sent twice by accident. */
export function markSent(file, id, label, now = new Date()) {
  updateBoard(file, (s) => {
    const item = s.items.find((i) => i.id === id)
    if (item && item.column === "waiting") item.sent = { label: clean(label), at: now.toISOString() }
  }, now)
}

// --- opening the pane (`open`) ----------------------------------------------------------------

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

/** The board's command line. `origin` is the pane that opened it: answer buttons send there. */
function paneCommand(file, origin) {
  return `node ${shellQuote(PANE_SCRIPT)} --board ${shellQuote(file)} --origin ${shellQuote(origin)}`
}

/**
 * What runs in the board's pane: "board" (with the path of its script and its --origin),
 * "shell" (the user quit it) or "busy" (anything else).
 */
function paneState(pane, env) {
  const info = herdr(["pane", "process-info", "--pane", pane], env, { quiet: true })
  const procs = info?.result?.process_info?.foreground_processes || []
  for (const p of procs) {
    const argv = (p.argv || []).map(String)
    const script = argv.find((a) => a.endsWith("board-pane.mjs"))
    const o = argv.indexOf("--origin")
    if (script) return { state: "board", script: resolve(p.cwd || "/", script), origin: o >= 0 ? argv[o + 1] : "" }
  }
  const shell = (p) => /^-?(ba|z|da|fi|k)?sh$/.test(basename(String(p.name || p.argv?.[0] || "")))
  return { state: procs.length && procs.every(shell) ? "shell" : "busy" }
}

const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Open the board in a split right of the calling pane, or reuse the one already in its tab. */
function openPane(fileArg, opts, env, out) {
  if (!inHerdr(env) || !env.HERDR_PANE_ID) {
    throw new Error("the board pane needs Herdr (HERDR_ENV=1); use `board.mjs ls` to print the board")
  }
  const target = env.HERDR_PANE_ID
  const me = herdr(["pane", "get", target], env)?.result?.pane
  if (!me) throw new Error(`herdr pane get ${target} returned nothing`)
  // A plugin action runs in the plugin's folder: the board belongs to the pane it was called from.
  const file = fileArg || boardPath(env.HERDR_PLUGIN_ID ? me.foreground_cwd || me.cwd : process.cwd(), env)
  if (!file) throw new Error("not inside a git repo; set JOB_BOARD_FILE")
  const tab = me.tab_id
  const share = Number(opts.share ?? 0.3)
  if (!(share > 0.05 && share < 0.95)) throw usage("--share is the board's part of the width, e.g. 0.3")

  const remembered = readBoard(file).panes?.[tab]
  const alive = (id) => {
    const pane = id && herdr(["pane", "get", id], env, { quiet: true })?.result?.pane
    return pane && pane.tab_id === tab && pane.label === PANE_LABEL && id !== target ? id : null
  }
  let pane = alive(remembered)
  if (!pane) {
    const panes = herdr(["pane", "list", "--workspace", me.workspace_id], env, { quiet: true })?.result?.panes || []
    pane = panes.find((p) => p.tab_id === tab && p.label === PANE_LABEL && p.pane_id !== target)?.pane_id || null
  }
  if (pane) {
    let { state, script, origin } = paneState(pane, env)
    // Another copy of the board runs there (an older install, a moved checkout), or one that
    // sends its answers to another pane: quit it with its `q` key and start this one, so one
    // `open` switches the pane over.
    const otherCopy = state === "board" && !sameFile(script, PANE_SCRIPT)
    const otherOrigin = state === "board" && !otherCopy && origin !== target
    if (otherCopy || otherOrigin) {
      herdr(["pane", "send-text", pane, "q"], env, { quiet: true })
      for (let i = 0; i < 30 && state !== "shell"; i++) {
        sleep(100)
        ;({ state } = paneState(pane, env))
      }
    }
    if (state === "shell") herdr(["pane", "run", pane, paneCommand(file, target)], env)
    out(
      state === "busy"
        ? `pane ${pane} is the board's, but something else runs in it now; left alone`
        : state === "board"
          ? `board already open in pane ${pane}${otherCopy || otherOrigin ? ` (the running board, ${script}, did not quit)` : ""}`
          : otherCopy
            ? `board switched to this copy in pane ${pane}`
            : otherOrigin
              ? `board restarted in pane ${pane}; its answers now go to ${target}`
              : `board restarted in pane ${pane}`,
    )
  } else {
    const split = herdr(
      ["pane", "split", "--pane", target, "--direction", "right", "--ratio", String(1 - share), "--cwd", me.foreground_cwd || me.cwd || process.cwd(), "--no-focus"],
      env,
    )
    pane = split?.result?.pane?.pane_id
    if (!pane) throw new Error("herdr pane split returned no pane id")
    herdr(["pane", "rename", pane, PANE_LABEL], env, { quiet: true })
    herdr(["pane", "run", pane, paneCommand(file, target)], env)
    out(`board opened in pane ${pane}, right of ${target}`)
  }
  if (remembered !== pane) updateBoard(file, (s) => void (s.panes[tab] = pane))
  return file
}

// --- the command line -----------------------------------------------------------------------

function usage(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

const FLAGS = new Set(["desc", "job", "ask", "title", "id", "report", "width", "share", "option", "suggest"])
const SWITCHES = new Set(["clear-options", "if-final"])
// Flags that can be given more than once; they collect into a list.
const REPEATED = new Set(["option"])

function parse(argv) {
  const args = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(a)
    if (!m) {
      args.push(a)
      continue
    }
    if (SWITCHES.has(m[1])) {
      if (m[2] !== undefined) throw usage(`${a.split("=")[0]} takes no value`)
      opts[m[1]] = true
      continue
    }
    if (!FLAGS.has(m[1])) throw usage(`unknown option ${a}`)
    let value
    if (m[2] !== undefined) value = m[2]
    else if (i + 1 < argv.length) value = argv[++i]
    else throw usage(`${a} needs a value`)
    if (REPEATED.has(m[1])) (opts[m[1]] ||= []).push(value)
    else opts[m[1]] = value
  }
  return { args, opts }
}

function only(opts, allowed, command) {
  for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw usage(`${command} does not take --${key}`)
}

const label = (column) => (column === "waiting" ? "waiting on you" : column === "todo" ? "to do" : column)

export function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  // Everything printed goes through safeText, except `ls` (already made printable, and coloured).
  const raw = io.out || ((line) => process.stdout.write(`${line}\n`))
  const out = (line) => raw(safeText(line))
  const err = (line) => (io.err || ((l) => process.stderr.write(`${l}\n`)))(safeText(line))
  const now = env.JOB_BOARD_NOW ? new Date(env.JOB_BOARD_NOW) : new Date()
  try {
    const { args, opts } = parse(argv)
    const [command, ...rest] = args
    if (!command || command === "help" || command === "--help") {
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1)
      out(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"))
      return command ? 0 : 2
    }
    if (command === "open") {
      only(opts, ["share"], command)
      const file = openPane(env.JOB_BOARD_FILE ? boardPath(process.cwd(), env) : null, opts, env, out)
      syncToken(file, env)
      return 0
    }
    const file = boardPath(process.cwd(), env)
    if (!file) throw new Error("not inside a git repo; run this from the repo, or set JOB_BOARD_FILE")
    const change = (fn) => {
      const result = updateBoard(file, fn, now)
      syncToken(file, env)
      return result
    }
    const need = (n, what) => {
      if (rest.length !== n) throw usage(`usage: board.mjs ${command} ${what}`)
    }

    switch (command) {
      case "add": {
        only(opts, ["desc", "job", "ask", "option", "suggest"], command)
        need(2, "<column> <title> [--desc D] [--job slug] [--ask A] [--option L]… [--suggest L]")
        const column = columnOf(rest[0])
        const item = change((s) => addItem(s, column, rest[1], opts, now))
        out(`added ${item.id} (${label(column)}): ${item.title}`)
        hint(err, item)
        return 0
      }
      case "move":
      case "done": {
        only(opts, command === "move" ? ["ask", "desc"] : [], command)
        need(command === "move" ? 2 : 1, command === "move" ? "<id|job> <column> [--ask A] [--desc D]" : "<id|job>")
        const column = command === "done" ? "done" : columnOf(rest[1])
        const item = change((s) => {
          const it = moveItem(findItem(s, rest[0]), column, now)
          return opts.ask !== undefined || opts.desc !== undefined ? editItem(it, opts, now) : it
        })
        out(`${item.id} → ${label(column)}: ${item.title}`)
        return 0
      }
      case "edit": {
        only(opts, ["title", "desc", "ask", "job", "report", "option", "suggest", "clear-options"], command)
        need(1, "<id|job> [--title T] [--desc D] [--ask A] [--job slug] [--option L]… [--suggest L] [--clear-options]")
        const item = change((s) => editItem(findItem(s, rest[0]), opts, now))
        out(`${item.id} edited: ${item.title}`)
        return 0
      }
      case "rm": {
        only(opts, [], command)
        need(1, "<id|job>")
        const item = change((s) => {
          const it = findItem(s, rest[0])
          s.items = s.items.filter((i) => i !== it)
          return it
        })
        out(`${item.id} removed: ${item.title}`)
        return 0
      }
      case "job-start": {
        only(opts, ["id", "title", "desc", "report"], command)
        need(1, "<slug> [--id N] [--title T] [--desc D] [--report path]")
        const slug = rest[0]
        if (!SLUG.test(slug)) throw usage(`job slug "${slug}" must match ${SLUG}`)
        const item = change((s) => {
          // A Waiting item of the same job stays: it is the user's open question from its last run.
          const open = (i) => i.job === slug && (i.column === "todo" || i.column === "doing")
          const it = opts.id ? findItem(s, String(opts.id)) : s.items.findLast(open)
          if (!it) return addItem(s, "doing", opts.title || slug, { ...opts, job: slug }, now)
          moveItem(it, "doing", now)
          dropOptions(it)
          return editItem(it, { ...opts, job: slug, id: undefined }, now)
        })
        out(`${item.id} → doing: ${item.title} (job ${slug})`)
        hint(err, item)
        return 0
      }
      case "job-report": {
        only(opts, ["if-final"], command)
        if (rest.length < 1 || rest.length > 2) throw usage("usage: board.mjs job-report <slug> [report.json] [--if-final]")
        const [slug, given] = rest
        const quiet = Boolean(opts["if-final"])
        const items = readBoard(file).items
        const path = given ? resolve(given) : (jobItem(items, slug) || items.findLast((i) => i.job === slug))?.report
        if (!path) {
          if (quiet) return 0
          throw new Error(`no report path for job ${slug}: pass it, or give --report to job-start`)
        }
        const report = readJson(path)
        if (!report) {
          if (quiet) return 0
          throw new Error(`can't read the report ${path}`)
        }
        const outcome = reportOutcome(report)
        if (!outcome) {
          if (quiet) return 0
          err(`report status is "${clean(report.status).slice(0, 40)}", not final; the board is unchanged`)
          return 1
        }
        const [column, ask] = outcome
        // The job's card: its open one, else the one this report file already moved. A card
        // remembers which outcome it got (`reported`), so a repeat call (a watcher firing twice,
        // the same report read again) changes nothing, not even the coordinator's later edits;
        // a report rewritten with a different outcome applies again, to the same card.
        const reported = createHash("sha256").update(JSON.stringify([path, column, ask])).digest("hex").slice(0, 16)
        const cardFor = (list) => jobItem(list, slug) || list.findLast((i) => i.job === slug && i.report === path)
        const settled = (it) => it && it.reported === reported
        const before = cardFor(readBoard(file).items)
        if (settled(before)) {
          // Already where this report puts it: nothing is written, `updated` stays.
          if (!quiet) out(`${before.id} unchanged (${label(column)}): ${before.title}`)
          return 0
        }
        const item = change((s) => {
          const found = cardFor(s.items)
          if (settled(found)) return found
          const it = found || addItem(s, column, slug, { job: slug, report: path }, now)
          moveItem(it, column, now)
          // A worker's report never puts answer buttons on the board.
          dropOptions(it)
          it.ask = ask
          it.report = path
          it.reported = reported
          it.updated = now.toISOString()
          return it
        })
        out(`${item.id} → ${label(column)}: ${item.title}${ask ? `\n  ask: ${ask.replace(/\n/g, "\n  ask: ")}` : ""}`)
        return 0
      }
      case "ls": {
        only(opts, ["width"], command)
        const view = buildView(readBoard(file), listAgents(env), { now, workspace: env.HERDR_WORKSPACE_ID || "" })
        const width = Number(opts.width) || process.stdout.columns || 100
        const color = !env.NO_COLOR && Boolean(process.stdout.isTTY) && !io.out
        raw(render(view, { width, color, now, repo: repoName(file) }))
        return 0
      }
      case "json": {
        only(opts, [], command)
        // JSON escapes C0 controls itself; escape C1 and bidirectional controls too.
        const json = JSON.stringify(readBoard(file), null, 2)
        raw(json.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))
        return 0
      }
      case "token": {
        only(opts, [], command)
        out(syncToken(file, env) || "(nothing open: token cleared)")
        return 0
      }
      case "path": {
        out(file)
        return 0
      }
      default:
        throw usage(`unknown command "${command}" (add, move, edit, done, rm, ls, json, job-start, job-report, open, token, path)`)
    }
  } catch (error) {
    err(`board: ${error.message}`)
    return error.usage ? 2 : 1
  }
}

/** Nudge the writer when a card won't make sense on its own (see README, "Writing cards"). */
function hint(err, item) {
  if (!item.desc) err(`board: tip: add --desc "<what it is and why it matters>" (board.mjs edit ${item.id} --desc …)`)
  if (item.column === "waiting" && !item.ask) err(`board: tip: add --ask "<exactly what the user should do>"`)
}

/** Recompute the sidebar text and report it to Herdr. Returns the text. */
function syncToken(file, env) {
  const view = buildView(readBoard(file), listAgents(env), { workspace: env.HERDR_WORKSPACE_ID || "" })
  const text = tokenText(view)
  reportToken(text, env)
  return text
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) process.exitCode = main()
