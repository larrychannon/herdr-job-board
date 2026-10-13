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
//   job-report <slug> [report.json]
//                           a job's report landed (default: the --report given at job-start):
//                           done → Done; done with needs_user → Waiting, asking needs_user;
//                           blocked / failed → Waiting with the reason
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
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
    throw new Error(`${file} is not valid JSON (${error.message}); fix or remove it`)
  }
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v)
  if (!isObject(state) || !Array.isArray(state.items) || !state.items.every(isObject)) {
    throw new Error(`${file} is not a job board (it needs an "items" list of objects)`)
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
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").replace(CONTROLS, "").trim()
const cleanLines = (text) => String(text ?? "").split(/\r?\n/).map(clean).filter(Boolean).join("\n")
/** Output that echoes stored or reported text: line breaks kept, every other control removed. */
export const safeText = (text) => String(text ?? "").split("\n").map((l) => l.replace(CONTROLS, "")).join("\n")

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

/** needs_user from a report, as a list of plain lines. */
function needsList(needs) {
  const list = Array.isArray(needs) ? needs : needs ? [needs] : []
  return list
    .map((n) => (typeof n === "string" ? n : n?.what || n?.ask || n?.text || n?.command || JSON.stringify(n)))
    .map(clean)
    .filter(Boolean)
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
    const entry = { ...item, live: "", report: "", age: now - new Date(item.since || item.updated || now) }
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
      const status = readJson(item.report)?.status
      if (["done", "blocked", "failed"].includes(status)) entry.report = status
    }
    if (item.column === "doing" && entry.live === "blocked") view.waiting.push(entry)
    else view[item.column]?.push(entry)
  }
  for (const a of agents || []) {
    if (!a.name || onBoard.has(a.name) || a.agent_status !== "blocked") continue
    if (workspace && a.workspace_id !== workspace) continue
    view.waiting.push({ id: null, title: a.name, desc: "", ask: "", job: a.name, live: "blocked", age: null, report: "" })
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

const STYLES = { title: "1", waiting: "1;33", head: "1", selected: "1;7", button: "1", dim: "2", ask: "33", working: "32", blocked: "1;31", done: "36", idle: "33" }
// Wide characters (CJK, emoji) take two cells; combining marks none.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\ufe0f]/u
const cellWidth = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
export const textWidth = (text) => [...text].reduce((w, ch) => w + cellWidth(ch), 0)
// Board text comes from agents and reports: never let it carry escape sequences, newlines or
// bidirectional controls (which would show text in a different order than it is stored).
const printable = (text) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")

/** Segments [{t, s}] cut to `width` cells (an ellipsis marks the cut) and painted. */
function paintLine(segments, width, color) {
  let out = ""
  let used = 0
  for (const { t, s } of segments) {
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
    out += color && s && STYLES[s] && piece ? `\x1b[${STYLES[s]}m${piece}\x1b[0m` : piece
    if (cut) break
  }
  return { text: out, width: used }
}

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
    line.push({ t: text, s: on ? "selected" : "button", button: { key: keyOf(entry), id: entry.id, index: b.index, label: b.label } })
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
  const titles = wrap(entry.title, inner, 2)
  const lines = titles.map((t, i) => [
    i ? indent : { t: `${mark.padStart(idWidth)}${ui.selected ? "▸" : " "}`, s: ui.selected ? "head" : entry.id == null ? "" : "dim" },
    { t, s: blocked ? "blocked" : "title" },
  ])
  if (blocked) {
    lines.push([indent, { t: "blocked", s: "blocked" }, { t: `: answer it in tab ${entry.job}`, s: "dim" }])
  } else if (column === "doing" && (entry.live || entry.report)) {
    const status = entry.live && entry.report ? `${entry.live}, report ${entry.report}` : entry.live || `report ${entry.report}`
    lines.push([indent, { t: status, s: STYLES[entry.live] ? entry.live : entry.report ? "done" : "dim" }])
  }
  for (const t of wrap(entry.desc, inner, descMax)) lines.push([indent, { t }])
  if (column === "waiting" || blocked) {
    const asks = asksOf(entry.ask)
    for (const ask of asks.slice(0, 2)) {
      wrap(ask, inner - 2, 2).forEach((t, i) => lines.push([indent, { t: i ? "  " : "→ ", s: "ask" }, { t, s: "ask" }]))
    }
    if (asks.length > 2) lines.push([indent, { t: `  +${asks.length - 2} more (board.mjs json)`, s: "dim" }])
  }
  if (column === "waiting" && !blocked && entry.id != null && optionsOf(entry).length) {
    if (entry.sent?.label) {
      const at = new Date(entry.sent.at)
      lines.push([indent, { t: `sent: ${entry.sent.label}${Number.isNaN(at.getTime()) ? "" : ` · ${clockOf(at)}`}`, s: "dim" }])
    }
    lines.push(...buttonLines(entry, width, indent, ui.selected ? ui.button : -1))
  }
  if (ui.note) for (const t of wrap(ui.note.t, inner, 2)) lines.push([indent, { t, s: ui.note.s }])
  // The age, dimmed, on the right: of the title's last line, else of the card's last line, else
  // on a line of its own.
  const age = entry.age == null ? "" : formatAge(entry.age)
  if (age) {
    const used = (line) => line.reduce((w, seg) => w + textWidth(printable(seg.t)), 0)
    const room = (line) => width - used(line) - textWidth(age)
    const line = [lines[titles.length - 1], lines.at(-1)].find((l) => room(l) >= 2)
    if (line) line.push({ t: " ".repeat(room(line)) }, { t: age, s: "dim" })
    else lines.push([indent, { t: age, s: "dim" }])
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
function doneCard(entry, width, idWidth) {
  const indent = { t: " ".repeat(idWidth + 1) }
  const inner = Math.max(4, width - idWidth - 1)
  const titles = wrap(entry.title, inner, 2)
  const lines = titles.map((t, i) => [i ? indent : { t: `${String(entry.id).padStart(idWidth)} `, s: "dim" }, { t }])
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
  const draw = (e, w) => (section === "done" ? doneCard(e, w, idWidth) : card(e, section, w, idWidth, DESC_LINES, uiOf(e)))
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
 * "↓ N more" lines at the edges, so no card is ever hidden without saying so. The offset is
 * clamped: the last page is full, not one card and empty space. A card taller than the space
 * is cut, never skipped.
 */
export function viewport(blocks, height, offset = 0) {
  const n = blocks.length
  if (!Number.isFinite(height)) return { lines: linesOf(blocks, 0, n), offset: 0, maxOffset: 0, page: Math.max(1, n), above: 0, below: 0 }
  let maxOffset = 0
  while (maxOffset < n - 1 && heightOf(blocks, maxOffset, n) > height - (maxOffset > 0 ? 1 : 0)) maxOffset++
  const o = Math.max(0, Math.min(offset, maxOffset))
  const top = o > 0 ? 1 : 0
  let shown = n - o
  let bottom = 0
  if (heightOf(blocks, o, n) > height - top) {
    bottom = 1
    shown = 0
    while (o + shown < n && heightOf(blocks, o, o + shown + 1) <= height - top - bottom) shown++
    shown = Math.max(1, Math.min(shown, n - o))
  }
  const above = cardsIn(blocks, 0, o)
  const below = bottom ? cardsIn(blocks, o + shown, n) : 0
  const lines = []
  if (top) lines.push([{ t: `↑ ${above} above`, s: "dim" }])
  lines.push(...linesOf(blocks, o, o + shown).slice(0, Math.max(0, height - top - bottom)))
  if (bottom) lines.push([{ t: `↓ ${below} more`, s: "dim" }])
  return { lines: lines.slice(0, Math.max(0, height)), offset: o, maxOffset, page: Math.max(1, shown), above, below }
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
  segs.push({ t: `${HEADINGS[section]} (${count})`, s: selected ? "selected" : section === "waiting" && count ? "waiting" : "head" })
  if (section === "waiting" && !count) segs.push({ t: "  Nothing needs you", s: "dim" })
  return segs
}

const pad = (painted, width) => painted.text + " ".repeat(Math.max(0, width - painted.width))
const contentHeight = (blocks) => Math.max(1, heightOf(blocks, 0, blocks.length))
export const HINT = "Tab section · ↑↓ scroll · q quit"

/**
 * Lay the board out in `width` × `height` cells (height Infinity: everything, no scrolling).
 * Wide: WAITING ON YOU across the top (two cards a row from 110 cells), DOING | TO DO | DONE in
 * three columns below. Waiting takes what it needs up to half the height (more only when the
 * bottom doesn't need it) and shrinks to one line when empty. Under STACK_BELOW cells the four
 * sections stack. Each section scrolls on its own; `scroll` is { selected, anchors } where an
 * anchor is the first visible card of a section, so the view holds still as cards come and go.
 * Returns { text, sections (per section: blockKeys, offset, maxOffset, page), regions (screen
 * rectangles, 1-based, for the mouse), scroll (with the anchors as drawn) }.
 */
export function renderBoard(view, opts = {}) {
  const { height = Infinity, color = false, now = new Date(), repo = "", error = "", interactive = false } = opts
  const width = Math.max(20, Math.floor(opts.width ?? 100))
  const scroll = { ...(opts.scroll || {}), selected: opts.scroll?.selected || "waiting", anchors: { ...(opts.scroll?.anchors || {}) } }
  const notes = opts.notes || {}
  const finite = Number.isFinite(height)
  const paint = (segs, w = width) => paintLine(segs, w, color)

  const clock = clockOf(now)
  const name = `Job board${repo ? ` · ${repo}` : ""}`
  const out = [pad(paint([{ t: name, s: "title" }], width - clock.length - 1), width - clock.length) + paint([{ t: clock, s: "dim" }], clock.length).text]
  if (error) out.push(paint([{ t: error, s: "blocked" }]).text)
  out.push("")
  const hint = interactive ? paint([{ t: HINT, s: "dim" }]).text : null
  const sections = {}
  const regions = {}
  const buttons = []
  // Where each button lands on the screen (1-based), for clicks.
  const emit = (segs, row, left, w) => {
    let x = left
    for (const seg of segs) {
      const sw = textWidth(printable(seg.t))
      if (seg.button && x < left + w) buttons.push({ ...seg.button, y: row, x0: x, x1: Math.min(x + sw, left + w) - 1 })
      x += sw
    }
    return paint(segs, w).text.trimEnd()
  }
  // The Waiting card that has the keyboard: the one chosen with ↑ ↓, else the first one shown.
  const waitingCards = view.waiting.map((e) => ({ key: keyOf(e), entry: e, buttons: e.id != null && optionsOf(e).length ? optionsOf(e).length + 1 : 0 }))
  const waitingUi = (perRow, w, h) => {
    const plain = sectionBlocks(view, "waiting", w, perRow, (e) => ({ note: notes[keyOf(e)] }))
    if (!interactive || scroll.selected !== "waiting" || !waitingCards.length) return plain
    const anchor = scroll.anchors.waiting
    const at = anchor ? Math.max(0, plain.findIndex((b) => b.keys.includes(anchor.key))) : 0
    const v = viewport(plain, h, at)
    let current = waitingCards.find((c) => c.key === scroll.card)
    if (!current) current = waitingCards.find((c) => c.key === plain[v.offset]?.keys[0]) || waitingCards[0]
    if (scroll.card !== current.key || !(scroll.button >= 0 && scroll.button < current.buttons)) {
      const suggested = optionsOf(current.entry).findIndex((o) => o.suggested)
      scroll.button = current.buttons ? Math.max(0, suggested) : -1
    }
    scroll.card = current.key
    return sectionBlocks(view, "waiting", w, perRow, (e) => ({
      selected: keyOf(e) === current.key,
      button: keyOf(e) === current.key ? scroll.button : -1,
      note: notes[keyOf(e)],
    }))
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
    const v = viewport(blocks, h, offsetOf(section, blocks))
    sections[section] = { blockKeys: blocks.map((b) => b.keys[0]), blockCards: blocks.map((b) => b.keys), offset: v.offset, maxOffset: v.maxOffset, page: v.page }
    if (blocks.length) scroll.anchors[section] = { key: blocks[v.offset].keys[0], index: v.offset }
    else delete scroll.anchors[section]
    return blocks.length ? v.lines : [[{ t: "nothing", s: "dim" }]]
  }
  const header = (section) => headerLine(view, section, interactive && scroll.selected === section)
  const room = finite ? height - out.length - (hint ? 1 : 0) : Infinity

  if (width >= STACK_BELOW) {
    const gap = 3
    const cw = Math.floor((width - 2 * gap) / 3)
    const perRow = width >= 110 ? 2 : 1
    let wBlocks = sectionBlocks(view, "waiting", width, perRow, (e) => ({ note: notes[keyOf(e)] }))
    const bottom = ["doing", "todo", "done"]
    const bBlocks = bottom.map((c) => sectionBlocks(view, c, cw))
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
      wBlocks = waitingUi(perRow, width, wH - 1)
      // Lines Waiting can't fill with whole cards go to the bottom.
      if (finite) {
        wH = used("waiting", wBlocks, wH)
        bH = Math.max(2, room - 1 - wH)
      }
      for (const l of place("waiting", wBlocks, wH - 1)) out.push(emit(l, out.length + 1, 1, width))
    } else place("waiting", wBlocks, 0)
    regions.waiting = { top: wTop, bottom: out.length, left: 1, right: width }
    out.push("")
    const bTop = out.length + 1
    const bodies = bottom.map((c, i) => place(c, bBlocks[i], bH - 1))
    const row = (cells) => cells.map((segs, i) => (i < 2 ? pad(paint(segs, cw), cw + gap) : paint(segs, cw).text)).join("").trimEnd()
    out.push(row(bottom.map(header)))
    const rows = finite ? bH - 1 : Math.max(...bodies.map((b) => b.length))
    for (let r = 0; r < rows; r++) out.push(row(bodies.map((b) => b[r] || [])))
    bottom.forEach((c, i) => {
      regions[c] = { top: bTop, bottom: bTop + rows, left: 1 + i * (cw + gap), right: i * (cw + gap) + cw }
    })
  } else {
    const all = SECTIONS.map((s) => sectionBlocks(view, s, width, 1, (e) => ({ note: notes[keyOf(e)] })))
    const wants = all.map((blocks, i) => (blocks.length ? 1 + contentHeight(blocks) : SECTIONS[i] === "waiting" ? 1 : 2))
    const heights = finite ? share(wants, room - (SECTIONS.length - 1)) : wants
    if (all[0].length) all[0] = waitingUi(1, width, heights[0] - 1)
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
      if (s !== "waiting" || all[i].length) for (const l of place(s, all[i], heights[i] - 1)) out.push(emit(l, out.length + 1, 1, width))
      else place(s, all[i], 0)
      regions[s] = { top: sTop, bottom: out.length, left: 1, right: width }
    })
  }

  const lines = finite ? out.slice(0, height - (hint ? 1 : 0)) : out
  if (hint) {
    if (finite) while (lines.length < height - 1) lines.push("")
    lines.push(hint)
  }
  // The Waiting cards in order, for the keyboard: which block each is in, and its buttons.
  if (sections.waiting) {
    sections.waiting.cards = waitingCards.map((c) => ({
      key: c.key,
      id: c.entry.id,
      buttons: c.buttons,
      labels: optionsOf(c.entry).map((o) => o.label),
      block: Math.max(0, sections.waiting.blockCards.findIndex((keys) => keys.includes(c.key))),
    }))
  }
  return { text: lines.join("\n"), sections, regions, buttons: buttons.filter((b) => b.y <= lines.length), scroll }
}

/** The board as text, everything shown (for `ls`), or as the pane draws it. */
export function render(view, opts = {}) {
  return renderBoard(view, opts).text
}

// --- keys and mouse -------------------------------------------------------------------------

const LETTER_KEYS = { A: "up", B: "down", C: "right", D: "left", Z: "prev", H: "top", F: "bottom" }
const TILDE_KEYS = { 1: "top", 7: "top", 4: "bottom", 8: "bottom", 5: "pageup", 6: "pagedown" }
const CHAR_KEYS = { "\t": "next", j: "down", k: "up", g: "top", G: "bottom", q: "quit", "\x03": "quit", r: "redraw", "\r": "enter", "\n": "enter", o: "other" }

/**
 * Terminal input as events: { type: "key", name } (next and prev for Tab and Shift-Tab, left,
 * right, up, down, pageup, pagedown, top, bottom, enter, other, quit, redraw), { type: "wheel", dir: "up" | "down", x, y } and
 * { type: "click", x, y } from SGR (1006) mouse reports. Anything else is skipped.
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
    m = /^\x1b[[O]([0-9;]*)([@-~])/.exec(rest)
    if (m) {
      const name = m[2] === "~" ? TILDE_KEYS[m[1].split(";")[0]] : LETTER_KEYS[m[2]]
      if (name) events.push({ type: "key", name })
      i += m[0].length
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

/**
 * One input event against the screen the user sees (`drawn`, from renderBoard): the new state
 * ({ selected, anchors, card, button }) and maybe an action for the pane to carry out:
 * { type: "send", id, key, label } or { type: "other", id, key }.
 * - Tab / Shift-Tab, ← → select a section; ↑ ↓ scroll it, PgUp PgDn a page, g G to the ends,
 *   the mouse wheel the section under the pointer. Scrolling stops at the ends.
 * - In Waiting, ↑ ↓ select a card (scrolling to keep it in view), ← → select one of its
 *   buttons, Enter presses it, o is Other…; a click on a button presses it.
 */
export function handleInput(scroll, event, drawn) {
  const next = { ...scroll, selected: scroll.selected || "waiting", anchors: { ...(scroll.anchors || {}) } }
  let action = null
  const scrollTo = (section, to) => {
    const info = drawn.sections[section]
    if (!info || !info.blockKeys.length) return
    const o = Math.max(0, Math.min(to, info.maxOffset))
    next.anchors[section] = { key: info.blockKeys[o], index: o }
    // Scrolling Waiting moves its keyboard to the first card in view.
    if (section === "waiting") {
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
  const s = next.selected
  const cards = drawn.sections.waiting?.cards || []
  const current = s === "waiting" ? cards.find((c) => c.key === next.card) : null
  const name = event.type === "key" ? event.name : event.type

  if (event.type === "click") {
    const hit = (drawn.buttons || []).find((b) => b.y === event.y && event.x >= b.x0 && event.x <= b.x1)
    if (hit) {
      next.selected = "waiting"
      next.card = hit.key
      next.button = hit.index
      action = press(cards.find((c) => c.key === hit.key), hit.index)
    } else next.selected = sectionAt(drawn.regions, event.x, event.y) || next.selected
  } else if (event.type === "wheel") {
    const target = sectionAt(drawn.regions, event.x, event.y)
    if (target) scrollTo(target, at(target) + (event.dir === "up" ? -1 : 1))
  } else if (current && (name === "up" || name === "down")) {
    const i = Math.max(0, Math.min(cards.indexOf(current) + (name === "up" ? -1 : 1), cards.length - 1))
    next.card = cards[i].key
    next.button = -1
    const info = drawn.sections.waiting
    const block = cards[i].block
    if (block < info.offset) scrollTo("waiting", block)
    else if (block >= info.offset + info.page) scrollTo("waiting", block - info.page + 1)
  } else if (current && current.buttons && (name === "left" || name === "right")) {
    next.button = Math.max(0, Math.min((scroll.button ?? 0) + (name === "right" ? 1 : -1), current.buttons - 1))
  } else if (name === "enter") {
    if (current) action = press(current, scroll.button ?? 0)
  } else if (name === "other") {
    if (current?.buttons) action = press(current, current.buttons - 1)
  } else if (name === "next" || name === "right") next.selected = step(1)
  else if (name === "prev" || name === "left") next.selected = step(-1)
  else if (name === "up") scrollTo(s, at(s) - 1)
  else if (name === "down") scrollTo(s, at(s) + 1)
  else if (name === "pageup") scrollTo(s, at(s) - (drawn.sections[s]?.page || 1))
  else if (name === "pagedown") scrollTo(s, at(s) + (drawn.sections[s]?.page || 1))
  else if (name === "top") {
    scrollTo(s, 0)
    if (current) next.card = cards[0].key
  } else if (name === "bottom") {
    scrollTo(s, Infinity)
    if (current) next.card = cards.at(-1).key
  }
  return { scroll: next, action }
}

/** handleInput without the action: the state after the event. */
export const applyInput = (scroll, event, drawn) => handleInput(scroll, event, drawn).scroll

// --- answering from the board -------------------------------------------------------------------

/** Exactly what a button sends to the coordinator: nothing else from the card goes. */
export const answerText = (item, label) => `Board card ${item.id} (${clean(item.title)}): ${clean(label)}`

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
  agent_blocked: "the coordinator is waiting on a question in its pane",
}

/** Run herdr; resolves to null, or to { code, message } when it failed. */
function herdrCall(args, env) {
  return new Promise((done) => {
    execFile(herdrBin(env), args, { env, timeout: 10_000 }, (error, stdout, stderr) => {
      if (!error) return done(null)
      let e = {}
      try {
        e = JSON.parse(stderr || stdout).error || {}
      } catch {}
      const message = clean(HERDR_ERRORS[e.code] || e.message || stderr || error.message).slice(0, 120) || "herdr failed"
      done({ code: e.code || "", message })
    })
  })
}

/** The agent in a pane: { status } when Herdr sees one there, else { error }. */
function agentIn(pane, env) {
  return new Promise((done) => {
    execFile(herdrBin(env), ["agent", "get", pane], { env, timeout: 10_000 }, (error, stdout) => {
      let agent = null
      try {
        agent = JSON.parse(stdout).result?.agent
      } catch {}
      done(!error && agent?.agent ? { status: agent.agent_status || "unknown" } : { error: HERDR_ERRORS.agent_not_found })
    })
  })
}

/**
 * Carry out a button press. "send": `herdr agent prompt <origin> <text>` (argv only, never a
 * shell). Herdr prompts only agents it started by name; a coordinator the user started has
 * none, so then the answer is typed in as the user would (`pane send-text`, then Enter), but
 * only when Herdr sees an agent in that pane (never a shell, where text could run as a command)
 * that isn't waiting on a question (where Enter could approve something). "other": focus the
 * pane and type "Board card <id>: " without Enter. Resolves to an error message, or null.
 */
export async function deliver(action, item, origin, env = process.env) {
  if (!inHerdr(env)) return "not inside Herdr"
  if (!origin) return "no coordinator pane known; open the board with board.mjs open"
  if (action.type === "send") {
    const text = answerText(item, action.label)
    const prompted = await herdrCall(["agent", "prompt", origin, text], env)
    if (!prompted) return null
    if (prompted.code !== "agent_not_ready") return prompted.message
    const agent = await agentIn(origin, env)
    if (agent.error) return agent.error
    if (agent.status === "blocked") return HERDR_ERRORS.agent_blocked
    const typed = (await herdrCall(["pane", "send-text", origin, text], env)) || (await herdrCall(["pane", "send-keys", origin, "enter"], env))
    return typed ? typed.message : null
  }
  const agent = await agentIn(origin, env)
  if (agent.error) return agent.error
  const focused = await herdrCall(["agent", "focus", origin], env)
  if (focused) return focused.message
  if (agent.status === "blocked") return `${HERDR_ERRORS.agent_blocked}; answer that first`
  const typed = await herdrCall(["pane", "send-text", origin, `Board card ${item.id}: `], env)
  return typed ? typed.message : null
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
const SWITCHES = new Set(["clear-options"])
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
        only(opts, [], command)
        if (rest.length < 1 || rest.length > 2) throw usage("usage: board.mjs job-report <slug> [report.json]")
        const [slug, given] = rest
        const items = readBoard(file).items
        const path = given ? resolve(given) : (jobItem(items, slug) || items.findLast((i) => i.job === slug))?.report
        if (!path) throw new Error(`no report path for job ${slug}: pass it, or give --report to job-start`)
        const report = readJson(path)
        if (!report) throw new Error(`can't read the report ${path}`)
        const outcome = reportOutcome(report)
        if (!outcome) {
          err(`report status is "${clean(report.status).slice(0, 40)}", not final; the board is unchanged`)
          return 1
        }
        const [column, ask] = outcome
        const item = change((s) => {
          const it = jobItem(s.items, slug) || addItem(s, column, slug, { job: slug, report: path }, now)
          moveItem(it, column, now)
          // A worker's report never puts answer buttons on the board.
          dropOptions(it)
          it.ask = ask
          it.report = path
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
