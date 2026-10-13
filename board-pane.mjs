#!/usr/bin/env node
// The board pane: draws the job board (board.mjs), redraws it every 3 s, and at once when the
// board file changes, the pane is resized or a key is pressed. It only reads the board;
// board.mjs writes it.
//
//   node board-pane.mjs [--board <file>] [--origin <pane>] [--interval <s>]
//   node board-pane.mjs --once [--width N] [--height N] [--color] [--keys <input>] [--origin <pane>]
//
// `board.mjs open` starts it in a split right of the calling pane. WAITING ON YOU across the
// top; DOING, TO DO and DONE (today, newest first) in three columns below; under 70 cells wide
// the four stack. Each card: the title, the description over up to 3 lines, for Waiting the
// ask ("→ …"), and the age; Doing shows its agent's live status from `herdr agent list`, and a
// blocked agent shows under Waiting. It also keeps the sidebar's $board token current.
//
// Every section scrolls on its own, and the position holds across redraws and new cards.
//   Tab / Shift-Tab, ← →   select a section        ↑ ↓, j k   scroll one card
//   PgUp PgDn               scroll a page           g G        top / bottom
//   mouse wheel             scroll the section under the pointer (a click selects it)
//   q quit, r redraw
// Waiting cards can carry answer buttons (board.mjs add … --option): in Waiting, ↑ ↓ select a
// card, ← → a button, Enter (or a click) sends "Board card <id> (<title>): <label>" to the
// --origin pane with `herdr agent prompt`; o (or Other…) focuses that pane for the user to type.
// Presses run one at a time; a card answered already asks before sending again.
// No flicker: it draws on the alternate screen, overwrites lines in place, and only writes
// when the text changed. Mouse reporting (SGR 1006) is switched off again on exit, on a
// signal and on a crash.
//
// --once prints one frame and exits (no colour unless --color): for tests and a quick look.
// --keys feeds it input first, e.g. --keys $'\t\e[B' (next section, then one card down); a
// button pressed there is really sent.
// The board file: --board, else JOB_BOARD_FILE, else the current directory's repo.

import { watch } from "node:fs"
import { basename, dirname, resolve, sep } from "node:path"

import {
  boardPath,
  buildView,
  createAnswerer,
  emptyBoard,
  handleInput,
  listAgentsAsync,
  parseInput,
  readBoard,
  renderBoard,
  repoName,
  reportToken,
  textWidth,
  tokenText,
} from "./board.mjs"

const MOUSE_ON = "\x1b[?1000h\x1b[?1006h"
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l"

function parse(argv) {
  const opts = { interval: 3, once: false, color: null, keys: "", origin: "" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--once") opts.once = true
    else if (a === "--color") opts.color = true
    else if (a === "--no-color") opts.color = false
    else if (["--board", "--interval", "--width", "--height", "--keys", "--origin"].includes(a) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

function locate(opts, env) {
  if (opts.board) return resolve(opts.board)
  // A plugin pane starts in the plugin's own folder, which is not the board's repo.
  if (!env.JOB_BOARD_FILE && env.HERDR_PLUGIN_ROOT && (process.cwd() + sep).startsWith(resolve(env.HERDR_PLUGIN_ROOT) + sep)) return null
  return boardPath(process.cwd(), env)
}

/** The board's data and live agents, read fresh; drawing then works from this cache. */
async function load(file, env) {
  const agents = await listAgentsAsync(env)
  try {
    return { state: readBoard(file), agents, error: "" }
  } catch (e) {
    return { state: emptyBoard(), agents, error: e.message }
  }
}

const clockNow = (env) => (env.JOB_BOARD_NOW ? new Date(env.JOB_BOARD_NOW) : new Date())

function compose(data, file, env, layout) {
  const now = clockNow(env)
  const view = buildView(data.state, data.agents, { now, workspace: env.HERDR_WORKSPACE_ID || "" })
  const drawn = renderBoard(view, { ...layout, now, repo: repoName(file), error: data.error, interactive: true })
  return { drawn, token: data.error ? null : tokenText(view) }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

async function main(argv = process.argv.slice(2), env = process.env) {
  let opts
  try {
    opts = parse(argv)
  } catch (error) {
    process.stderr.write(`board-pane: ${error.message}\n`)
    return 2
  }
  const file = locate(opts, env)
  if (!file) {
    process.stderr.write("board-pane: no board here. Run `node board.mjs open` from the repo, or pass --board <file>.\n")
    return 2
  }

  if (opts.once) {
    let data = await load(file, env)
    const answers = createAnswerer({ file, origin: opts.origin, env, now: () => clockNow(env) })
    const layout = { width: Number(opts.width) || process.stdout.columns || 100, height: Number(opts.height) || Infinity, color: opts.color === true }
    const draw = (scroll) => compose(data, file, env, { ...layout, scroll, notes: answers.notes }).drawn
    let drawn = draw()
    for (const event of parseInput(opts.keys)) {
      if (event.type === "key" && ["quit", "redraw"].includes(event.name)) continue
      const { scroll, action } = handleInput(drawn.scroll, event, drawn)
      if (action) {
        await answers.press(action)
        data = await load(file, env)
      }
      drawn = draw(scroll)
    }
    process.stdout.write(`${drawn.text}\n`)
    return 0
  }

  const out = process.stdout
  const color = opts.color ?? !env.NO_COLOR
  let data = await load(file, env)
  // Presses run one at a time and never stop the pane. Each change shows its note at once and
  // reloads the board (for "sent"); onChange only runs once a key is pressed, after setup.
  const answers = createAnswerer({
    file,
    origin: opts.origin,
    env,
    now: () => clockNow(env),
    onChange: () => {
      paint()
      refresh()
    },
  })
  let scroll = { selected: "waiting", anchors: {} }
  let drawn = null
  let last = ""
  let lastToken

  // Draw from the cache: instant for keys and resizes. One cell of margin on the right, so a
  // full last column never wraps. Synchronised update (ignored by terminals that lack it).
  const paint = () => {
    const cols = out.columns || 80
    const result = compose(data, file, env, { width: cols - 1, height: out.rows || 24, color, scroll, notes: answers.notes })
    drawn = result.drawn
    scroll = drawn.scroll
    if (drawn.text !== last) {
      const body = drawn.text
        .split("\n")
        .map((l) => (textWidth(l.replace(ANSI, "")) < cols ? `${l}\x1b[K` : l))
        .join("\r\n")
      out.write(`\x1b[?2026h\x1b[H${body}\x1b[J\x1b[?2026l`)
      last = drawn.text
    }
    if (result.token !== null && result.token !== lastToken) {
      reportToken(result.token, env, { wait: false })
      lastToken = result.token
    }
  }
  let loading = false
  const refresh = async () => {
    if (loading) return
    loading = true
    try {
      data = await load(file, env)
      paint()
    } finally {
      loading = false
    }
  }

  // Leave the terminal as it was, whatever the way out.
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    out.write(`${MOUSE_OFF}\x1b[?25h\x1b[?1049l`)
  }
  const quit = (code = 0) => {
    restore()
    process.exit(code)
  }
  process.on("exit", restore)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => quit(0))
  const crash = (error) => {
    restore()
    process.stderr.write(`board-pane: ${error?.stack || error}\n`)
    process.exit(1)
  }
  process.on("uncaughtException", crash)
  process.on("unhandledRejection", crash)

  out.write(`\x1b[?1049h\x1b[?25l${MOUSE_ON}\x1b[2J`)
  out.on("resize", () => {
    last = ""
    paint()
  })
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on("data", (chunk) => {
      for (const event of parseInput(chunk.toString("utf8"))) {
        if (event.type === "key" && event.name === "quit") quit(0)
        if (event.type === "key" && event.name === "redraw") {
          last = ""
          refresh()
          continue
        }
        if (!drawn) continue
        const result = handleInput(scroll, event, drawn)
        scroll = result.scroll
        if (result.action) answers.press(result.action)
        // Redraw before the next event: keys that arrive together each see the screen the
        // previous one left.
        paint()
      }
      paint()
    })
  }
  // The file is replaced by a rename on every write, so watch its folder, not the file.
  let pending
  try {
    watch(dirname(file), (_, name) => {
      if (name && name !== basename(file)) return
      clearTimeout(pending)
      pending = setTimeout(refresh, 100)
    })
  } catch {}
  setInterval(refresh, Math.max(1, Number(opts.interval) || 3) * 1000)
  paint()
  return null
}

main().then((code) => {
  if (code !== null) process.exitCode = code
})
