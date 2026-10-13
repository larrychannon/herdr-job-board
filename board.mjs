#!/usr/bin/env node
// herdr-job-board: what is to do, being done, and waiting on the user, for one repo. The board
// pane (board-pane.mjs) draws it; this script is the only thing that writes it. Agents (a
// coordinator that starts jobs) and people use the same commands.
//
//   node board.mjs <command> …        (installed as a Herdr plugin: "$HERDR_PLUGIN_ROOT/board.mjs")
//
//   add <column> <title> [--desc D] [--job slug] [--ask A]   add an item; prints its id
//   move <ref> <column> [--ask A] [--desc D]                   <ref> is an item id or a job slug
//   edit <ref> [--title T] [--desc D] [--ask A] [--job slug]
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
//   open [--share 0.3]      open the board pane right of this pane, once per tab
//   token                   print the sidebar text, and report it to Herdr as $board
//   path                    print the board file's path
//
// Columns: todo, doing, waiting (on the user), done. Done items are kept 14 days for the
// "Done today" line, then dropped.
//
// The board file is $(git rev-parse --git-common-dir)/job-board.json: inside .git, so every
// worktree of the repo shares one board and it is never committed. JOB_BOARD_FILE overrides it.
// Writes take a lock (mkdir <file>.lock), then write a temp file and rename it over the board, so
// readers never see half a file and racing writers don't lose each other's items.
//
// After each change, and from the board pane, the counts go to Herdr as the workspace token
// `board` ("1 doing · 3 need you"); a `$board` entry in the sidebar's Space rows shows it.
//
// Exit: 0 ok, 1 error (unknown item, unreadable board, Herdr failed), 2 bad usage.

import { execFile, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const COLUMNS = ["todo", "doing", "waiting", "done"]
const HEADINGS = { waiting: "WAITING ON YOU", doing: "DOING", todo: "TO DO" }
const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const PANE_SCRIPT = join(SCRIPTS, "board-pane.mjs")
export const PANE_LABEL = "board"
export const TOKEN_SOURCE = "job-board"
const SLUG = /^[a-z][a-z0-9_-]{0,31}$/
const LOCK_WAIT_MS = 10_000
// A write holds the lock for milliseconds; an older lock is left by a killed process.
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
  if (!state || !Array.isArray(state.items)) throw new Error(`${file} is not a job board (no "items" list)`)
  state.next_id = Math.max(Number(state.next_id) || 1, ...state.items.map((i) => Number(i.id) + 1 || 1))
  state.panes ||= {}
  return state
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function withLock(file, fn) {
  const lock = `${file}.lock`
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
    } catch {
      continue
    }
    if (Date.now() - start > LOCK_WAIT_MS) {
      throw new Error(`the board is locked (${lock}); remove that directory if no board command is running`)
    }
    sleep(5 + Math.random() * 30)
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function writeBoard(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
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

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim()

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

function addItem(state, column, title, opts, now) {
  if (!clean(title)) throw usage("an item needs a title")
  const at = now.toISOString()
  const item = {
    id: state.next_id++,
    title: clean(title),
    desc: clean(opts.desc),
    column,
    job: clean(opts.job),
    ask: String(opts.ask ?? "").trim(),
    since: at,
    updated: at,
  }
  if (opts.report) item.report = resolve(opts.report)
  state.items.push(item)
  return item
}

function moveItem(item, column, now) {
  const at = now.toISOString()
  if (item.column !== column) {
    item.column = column
    item.since = at
    // A question is only open while the item waits on the user.
    if (column !== "waiting") item.ask = ""
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
  if (opts.ask !== undefined) item.ask = String(opts.ask).trim()
  if (opts.job !== undefined) item.job = clean(opts.job)
  if (opts.report !== undefined) item.report = resolve(opts.report)
  item.updated = now.toISOString()
  return item
}

/** needs_user from a report, as a list of plain lines. */
function needsList(needs) {
  const list = Array.isArray(needs) ? needs : needs ? [needs] : []
  return list
    .map((n) => (typeof n === "string" ? n : n?.what || n?.ask || n?.text || n?.command || JSON.stringify(n)))
    .map((n) => String(n).trim())
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
    if (a.name && (!byName.has(a.name) || a.workspace_id === workspace)) byName.set(a.name, a)
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

const STYLES = { title: "1", waiting: "1;33", head: "1", dim: "2", ask: "33", working: "32", blocked: "1;31", done: "36", idle: "33" }
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
function card(entry, column, width, idWidth, descMax) {
  const indent = { t: " ".repeat(idWidth + 1) }
  const inner = Math.max(4, width - idWidth - 1)
  const blocked = entry.live === "blocked"
  const mark = entry.id == null ? "•" : String(entry.id)
  const titles = wrap(entry.title, inner, 2)
  const lines = titles.map((t, i) => [
    i ? indent : { t: `${mark.padStart(idWidth)} `, s: entry.id == null ? "" : "dim" },
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

/** A column's cards with at most `descMax` description lines each and the first `cards` cards. */
function columnAt(view, column, width, descMax, cards) {
  const entries = view[column]
  if (!entries.length) return [[{ t: column === "waiting" ? "nothing needs you" : "nothing", s: "dim" }]]
  const idWidth = Math.max(1, ...entries.map((e) => (e.id == null ? 1 : String(e.id).length)))
  const lines = []
  entries.slice(0, cards).forEach((e, i) => {
    if (i) lines.push([])
    lines.push(...card(e, column, width, idWidth, descMax))
  })
  if (cards < entries.length) lines.push(...(cards ? [[]] : []), [{ t: `+${entries.length - cards} more`, s: "dim" }])
  return lines
}

const DESC_LINES = 3

/** A column in at most `max` lines: fewer description lines first, then fewer cards. */
function fitColumn(view, column, width, max) {
  const n = view[column].length
  for (let d = DESC_LINES; d >= 0; d--) {
    const lines = columnAt(view, column, width, d, n)
    if (lines.length <= max || max === Infinity) return lines
  }
  for (let c = n - 1; c >= 0; c--) {
    const lines = columnAt(view, column, width, 0, c)
    if (lines.length <= max) return lines
  }
  return columnAt(view, column, width, 0, 0).slice(0, Math.max(0, max))
}

function heading(view, column) {
  return [{ t: `${HEADINGS[column]} (${view.counts[column]})`, s: column === "waiting" && view.counts.waiting ? "waiting" : "head" }]
}

const pad = (painted, width) => painted.text + " ".repeat(Math.max(0, width - painted.width))

/**
 * The board as text. `width` cells per line at most; `height` lines at most (Infinity for `ls`).
 * Wide: three columns side by side, each giving up description lines, then cards, when it is
 * too long. Under STACK_BELOW cells the columns stack, and To do gives way first: its
 * descriptions, then its cards; then the descriptions of Doing and Waiting; then their cards.
 */
export function render(view, { width = 100, height = Infinity, color = false, now = new Date(), repo = "", error = "" } = {}) {
  width = Math.max(20, Math.floor(width))
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
  const name = `Job board${repo ? ` · ${repo}` : ""}`
  const titleLine = paintLine([{ t: name, s: "title" }], width - clock.length - 1, color)
  const top = [pad(titleLine, width - clock.length) + paintLine([{ t: clock, s: "dim" }], clock.length, color).text]
  if (error) top.push(paintLine([{ t: error, s: "blocked" }], width, color).text)
  top.push("")
  const done = view.doneToday.map((e) => e.title).join(" · ")
  const footer = paintLine([{ t: "Done today: ", s: "dim" }, { t: done || "nothing yet", s: done ? "" : "dim" }], width, color).text
  const order = ["waiting", "doing", "todo"]
  const lines = [...top]

  if (width >= STACK_BELOW) {
    const gap = 3
    const cw = Math.floor((width - 2 * gap) / 3)
    const body = Math.max(2, height - top.length - 3)
    const cols = order.map((c) => [heading(view, c), [], ...fitColumn(view, c, cw, body - 2)])
    const rows = Math.max(...cols.map((c) => c.length))
    for (let r = 0; r < rows; r++) {
      const cells = cols.map((c, i) => {
        const painted = c[r] ? paintLine(c[r], cw, color) : { text: "", width: 0 }
        return i < 2 ? pad(painted, cw + gap) : painted.text
      })
      lines.push(cells.join("").trimEnd())
    }
  } else {
    const level = Object.fromEntries(order.map((c) => [c, { d: DESC_LINES, c: view[c].length }]))
    const build = () =>
      order.flatMap((c, i) => [...(i ? [[]] : []), heading(view, c), [], ...columnAt(view, c, width, level[c].d, level[c].c)])
    const steps = []
    for (let d = DESC_LINES - 1; d >= 0; d--) steps.push(["todo", "d", d])
    for (let n = view.todo.length - 1; n >= 0; n--) steps.push(["todo", "c", n])
    for (const c of ["doing", "waiting"]) for (let d = DESC_LINES - 1; d >= 0; d--) steps.push([c, "d", d])
    for (const c of ["doing", "waiting"]) for (let n = view[c].length - 1; n >= 0; n--) steps.push([c, "c", n])
    let stacked = build()
    const room = height - top.length - 2
    for (const [c, key, value] of steps) {
      if (stacked.length <= room) break
      level[c][key] = value
      stacked = build()
    }
    for (const segs of stacked) lines.push(paintLine(segs, width, color).text)
  }
  lines.push("", footer)
  return lines.slice(0, height).join("\n")
}

// --- opening the pane (`open`) ----------------------------------------------------------------

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

function paneCommand(file) {
  return `node ${shellQuote(PANE_SCRIPT)} --board ${shellQuote(file)}`
}

/**
 * What runs in the board's pane: "board" (with the path of its script), "shell" (the user quit
 * it) or "busy" (anything else).
 */
function paneState(pane, env) {
  const info = herdr(["pane", "process-info", "--pane", pane], env, { quiet: true })
  const procs = info?.result?.process_info?.foreground_processes || []
  for (const p of procs) {
    const script = (p.argv || []).find((a) => String(a).endsWith("board-pane.mjs"))
    if (script) return { state: "board", script: resolve(p.cwd || "/", script) }
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
    let { state, script } = paneState(pane, env)
    // Another copy of the board runs there (an older install, a moved checkout): quit it with
    // its `q` key and start this one, so one `open` switches the pane over.
    let upgraded = false
    if (state === "board" && !sameFile(script, PANE_SCRIPT)) {
      herdr(["pane", "send-text", pane, "q"], env, { quiet: true })
      for (let i = 0; i < 30 && state !== "shell"; i++) {
        sleep(100)
        ;({ state } = paneState(pane, env))
      }
      upgraded = state === "shell"
    }
    if (state === "shell") herdr(["pane", "run", pane, paneCommand(file)], env)
    out(
      state === "busy"
        ? `pane ${pane} is the board's, but something else runs in it now; left alone`
        : state === "board"
          ? `board already open in pane ${pane}${script && !sameFile(script, PANE_SCRIPT) ? ` (another copy, ${script}, did not quit)` : ""}`
          : `board ${upgraded ? "switched to this copy" : "restarted"} in pane ${pane}`,
    )
  } else {
    const split = herdr(
      ["pane", "split", "--pane", target, "--direction", "right", "--ratio", String(1 - share), "--cwd", me.foreground_cwd || me.cwd || process.cwd(), "--no-focus"],
      env,
    )
    pane = split?.result?.pane?.pane_id
    if (!pane) throw new Error("herdr pane split returned no pane id")
    herdr(["pane", "rename", pane, PANE_LABEL], env, { quiet: true })
    herdr(["pane", "run", pane, paneCommand(file)], env)
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

const FLAGS = new Set(["desc", "job", "ask", "title", "id", "report", "width", "share"])

function parse(argv) {
  const args = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a)
    if (!m) {
      args.push(a)
      continue
    }
    if (!FLAGS.has(m[1])) throw usage(`unknown option ${a}`)
    if (m[2] !== undefined) opts[m[1]] = m[2]
    else if (i + 1 < argv.length) opts[m[1]] = argv[++i]
    else throw usage(`${a} needs a value`)
  }
  return { args, opts }
}

function only(opts, allowed, command) {
  for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw usage(`${command} does not take --${key}`)
}

const label = (column) => (column === "waiting" ? "waiting on you" : column === "todo" ? "to do" : column)

export function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const out = io.out || ((line) => process.stdout.write(`${line}\n`))
  const err = io.err || ((line) => process.stderr.write(`${line}\n`))
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
        only(opts, ["desc", "job", "ask"], command)
        need(2, "<column> <title> [--desc D] [--job slug] [--ask A]")
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
        only(opts, ["title", "desc", "ask", "job", "report"], command)
        need(1, "<id|job> [--title T] [--desc D] [--ask A] [--job slug]")
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
          err(`report status is "${report.status ?? ""}", not final; the board is unchanged`)
          return 1
        }
        const [column, ask] = outcome
        const item = change((s) => {
          const it = jobItem(s.items, slug) || addItem(s, column, slug, { job: slug, report: path }, now)
          moveItem(it, column, now)
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
        out(render(view, { width, color, now, repo: repoName(file) }))
        return 0
      }
      case "json": {
        only(opts, [], command)
        out(JSON.stringify(readBoard(file), null, 2))
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
