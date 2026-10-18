#!/usr/bin/env node
// The board pane: draws the job board (board.mjs), redraws it every 3 s, and at once when the
// board file changes, the pane is resized or a key is pressed. It only reads the board;
// board.mjs writes it.
//
//   node board-pane.mjs [--board <file>] [--origin <pane>] [--interval <s>]
//   node board-pane.mjs --once [--width N] [--height N] [--layout wide|inbox|compact] [--color] [--emoji] [--links] [--frame N] [--keys <input>] [--origin <pane>]
//
// `board.mjs open` starts it in a split right of the calling pane. The layout follows the
// pane's size: from 120 cells wide, WAITING ON YOU across the top and DOING | TO DO in two
// columns below; from 70, the inbox (the sections stacked, one row a card, the selected card
// open under its row); under 70 cells or 24 rows, compact (rows only; Space opens the selected
// one). DONE (today) is folded to one line ("DONE · 3 today ▸"; d or a click opens it, newest
// first, and folds it again). A card: the title, the description over up to 3 lines, for
// Waiting the ask and its buttons, and the age; Doing shows its agent's live status from
// `herdr agent list`, and a blocked agent shows under Waiting. Colours come from the 16-colour
// palette (NO_COLOR turns them off), emoji only in the section headers (BOARD_EMOJI=0 turns them
// off); whole http(s) URLs are terminal hyperlinks (OSC 8) showing the URL itself. It also keeps
// the sidebar's $board token current, and restarts itself when an update rewrites its folder.
//
// A Doing card whose agent is working shows a small ASCII bar bouncing beside "working"; every
// other card stands still, so the motion says what is running. It ticks about 6 times a second,
// only while such a bar is on screen (no timer otherwise), and a tick rewrites only the bars. JOB_BOARD_ANIMATION=0 (or TERM=dumb) keeps it still; NO_COLOR draws it uncoloured.
//
// Every section scrolls on its own and has a selected card; the position holds across redraws
// and new cards.
//   Tab / Shift-Tab, ← →   select a section        ↑ ↓, j k   select a card (the view follows)
//   Space                   open or close the selected card under its row (inbox, compact)
//   PgUp PgDn               scroll a page           g G        first / last card
//   mouse wheel             scroll the section under the pointer
//   click, double click     select a card, open its details; a click on a card's question
//                           chooses its suggested button (or the first) for Enter, never sends
//   Enter                   open the selected card's details (no button chosen); Esc closes them
//   in the details          ↑ ↓ PgUp PgDn g G scroll; ← → choose one of the card's buttons and
//                           Enter presses it; with no button chosen, Enter or f shows or hides
//                           More… (the rest of the job's report), and Enter closes the details
//                           when there is no More…; o is Other…; Esc closes them
//   c                       copy the card's first link, or its text (OSC 52); c again copies its
//                           next link, round to the first; a new card or opening or closing
//                           its details starts at the first again
//   d, click on Done's line open Done (a third column); d or a click on its header folds it.
//                           Folded, Tab skips it. The choice holds while the pane runs
//   t                       go to the job's tab (herdr agent focus)
//   m                       mouse capture off and on (off: the terminal selects text)
//   q quit, r redraw
// Waiting cards can carry answer buttons (board.mjs add … --option), straight under the question
// (plain text after a dim "Question:", never drawn like a button): ← → or a click on the
// question choose one (the suggested first; only buttons on screen, so none on a card whose job
// is blocked or one cut off above its buttons in a short pane) and the key line says "Enter to
// send"; Enter on a chosen button still on screen (or a click on the button) sends
// "Board card <id> (<title>): <label>" to the --origin pane with `herdr agent prompt`; o (or
// Other…) focuses that pane for the user to type. Presses run one at a time; a card answered
// already asks before sending again.
// No flicker: it draws on the alternate screen, overwrites lines in place, and only writes
// the lines that changed. Mouse reporting (SGR 1006) is switched off again on exit, on a
// signal and on a crash.
//
// --once prints one frame and exits (no colour unless --color, no hyperlinks unless --links, the
// working bar still unless --frame N picks its frame): for tests and a quick look.
// --keys feeds it input first, e.g. --keys $'\t\e[B' (next section, then one card down); a
// button pressed there is really sent.
// The board file: --board, else JOB_BOARD_FILE, else the current directory's repo.

import { spawn } from "node:child_process"
import { watch } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  animates,
  animationTimer,
  barTick,
  boardPath,
  buildView,
  copyMessage,
  copyPlace,
  createAnswerer,
  emojiOn,
  emptyBoard,
  focusAgent,
  handleInput,
  listAgentsAsync,
  listTabsAsync,
  parseInput,
  readBoard,
  renderBoard,
  repoName,
  reportToken,
  screenDiff,
  textWidth,
  tokenText,
  nextCopy,
  VERSION,
  versionOf,
  WORKING_FRAMES,
} from "./board.mjs"
import { osc52 } from "./links.mjs"

const MOUSE_ON = "\x1b[?1000h\x1b[?1006h"
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l"

function parse(argv) {
  const opts = { interval: 3, once: false, color: null, links: false, emoji: null, keys: "", origin: "", frame: null, layout: "" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--once") opts.once = true
    else if (a === "--links") opts.links = true
    else if (a === "--color") opts.color = true
    else if (a === "--no-color") opts.color = false
    else if (a === "--emoji") opts.emoji = true
    else if (a === "--no-emoji") opts.emoji = false
    else if (["--board", "--interval", "--width", "--height", "--keys", "--origin", "--frame", "--layout", "--version"].includes(a) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
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

/** The board's data, live agents and tab labels, read fresh; drawing then works from this cache. */
async function load(file, env) {
  const [agents, tabs] = await Promise.all([listAgentsAsync(env), listTabsAsync(env)])
  try {
    return { state: readBoard(file), agents, tabs, error: "" }
  } catch (e) {
    return { state: emptyBoard(), agents, tabs, error: e.message }
  }
}

const clockNow = (env) => (env.JOB_BOARD_NOW ? new Date(env.JOB_BOARD_NOW) : new Date())

function compose(data, file, env, layout) {
  layout = { ...layout, notice: data.notice || "" }
  const now = clockNow(env)
  const workspace = env.HERDR_WORKSPACE_ID || ""
  const view = buildView(data.state, data.agents, { now, workspace })
  const drawn = renderBoard(view, { ...layout, now, repo: repoName(file), error: data.error, interactive: true, agents: data.agents, tabs: data.tabs, workspace })
  return { drawn, token: data.error ? null : tokenText(view) }
}

/**
 * The pane's side of an action. Answers go to the answerer (one at a time). c writes the
 * selected card's first link, or its text, to the clipboard with OSC 52: only on that key, and
 * only that card; pressed again on the same card, its next link (ctx.copy keeps the place). t switches to the job's tab. m switches mouse capture off and on. Resolves to
 * the footer message, if any.
 */
async function perform(action, ctx) {
  if (action.type === "send" || action.type === "other") {
    const pressed = ctx.answers.press(action)
    if (ctx.wait) await pressed
    return null
  }
  if (action.type === "mouse") {
    ctx.mouse = !ctx.mouse
    ctx.write(ctx.mouse ? MOUSE_ON : MOUSE_OFF)
    return ctx.mouse ? "mouse: board" : "mouse: select · drag to select text, m gives the mouse back"
  }
  const entry = ctx.drawn?.entries?.[action.key]
  if (!entry) return null
  if (action.type === "copy") {
    try {
      const { payload, cycle } = nextCopy(ctx.copy, entry, copyPlace(ctx.drawn.scroll))
      ctx.copy = cycle
      ctx.write(osc52(payload.text))
      return copyMessage(payload, entry)
    } catch (e) {
      return `couldn't copy: ${String(e?.message ?? "").slice(0, 100)}`
    }
  }
  if (action.type === "tab") {
    if (!entry.job) return "this card has no job, so no tab"
    const error = await focusAgent(entry.job, ctx.env)
    return error ? `couldn't go to the tab: ${error}` : null
  }
  return null
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

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
    const ctx = { answers, env, wait: true, mouse: true, drawn: null, copy: null, write: (text) => process.stdout.write(text) }
    let message = null
    const frame = opts.frame === null ? null : Number(opts.frame)
    const layout = {
      width: Number(opts.width) || process.stdout.columns || 100,
      height: Number(opts.height) || Infinity,
      color: opts.color === true,
      links: opts.links,
      emoji: opts.emoji === true,
      layout: opts.layout,
      frame: Number.isInteger(frame) ? frame : null,
    }
    const draw = (scroll) =>
      compose(data, file, env, { ...layout, scroll, notes: answers.notes, footer: { mouse: ctx.mouse ? "board" : "select", message } }).drawn
    let drawn = draw()
    for (const event of parseInput(opts.keys)) {
      if (event.type === "key" && ["quit", "redraw"].includes(event.name)) continue
      event.at = Date.now()
      const { scroll, action } = handleInput(drawn.scroll, event, drawn)
      if (action) {
        ctx.drawn = drawn
        message = (await perform(action, ctx)) ?? message
        data = await load(file, env)
      }
      drawn = draw(scroll)
      if (ctx.copy && ctx.copy.place !== copyPlace(drawn.scroll)) ctx.copy = null
    }
    process.stdout.write(`${drawn.text}\n`)
    return 0
  }

  const out = process.stdout
  const color = opts.color ?? !env.NO_COLOR
  const emoji = opts.emoji ?? emojiOn(env)
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
  // The screen as last written, by line; [] for "write it all".
  let shownLines = []
  let lastToken
  // The working bar: its frame, and the timer that moves it, running only while one is on screen.
  // A tick draws nothing else: it rewrites the bars in place (a few bytes), and marks their
  // lines for the next paint, which draws the board at the current frame.
  const animate = animates(env)
  let frame = 0
  const ticker = animationTimer(() => {
    frame = (frame + 1) % WORKING_FRAMES.length
    const patch = barTick(drawn, frame, color)
    if (!patch) return
    out.write(`\x1b[?2026h${patch}\x1b[?2026l`)
    for (const { y } of drawn.bars) shownLines[y - 1] = null
  })
  const ctx = { answers, env, wait: false, mouse: true, drawn: null, copy: null, write: (text) => out.write(text) }
  // A footer message (copied, mouse mode, …) shows for a few seconds.
  let message = null
  let messageTimer
  const say = (text) => {
    if (!text) return
    message = text
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => {
      message = null
      paint()
    }, 5000)
    paint()
  }

  // Draw from the cache: instant for keys and resizes. One cell of margin on the right, so a
  // full last column never wraps. Synchronised update (ignored by terminals that lack it).
  const paint = () => {
    const cols = out.columns || 80
    const result = compose(data, file, env, {
      width: cols - 1,
      height: out.rows || 24,
      color,
      emoji,
      links: true,
      frame: animate ? frame : null,
      scroll,
      notes: answers.notes,
      footer: { mouse: ctx.mouse ? "board" : "select", message },
    })
    drawn = result.drawn
    scroll = drawn.scroll
    // Another card, or its details opened or closed: the next c starts at the first link.
    if (ctx.copy && ctx.copy.place !== copyPlace(scroll)) ctx.copy = null
    // Only the lines that changed: a tick of the working bar rewrites just its lines.
    const lines = drawn.text.split("\n")
    const diff = screenDiff(shownLines, lines, cols, (l) => textWidth(l.replace(ANSI, "")))
    if (diff) out.write(`\x1b[?2026h${diff}\x1b[?2026l`)
    shownLines = lines
    if (result.token !== null && result.token !== lastToken) {
      reportToken(result.token, env, { wait: false })
      lastToken = result.token
    }
    // Tick while a working bar is on screen; no timer otherwise.
    ticker.sync(animate && drawn.animated > 0)
  }
  // An update rewrites the plugin's folder in place: this pane still runs the code it started
  // with. Each refresh reads the folder's version; seen changed twice in a row (so the update
  // has finished writing), the pane hands over to the new copy in the same pane (board.mjs
  // pane-restart waits for it to quit, then starts the new one), unless the details are open or
  // a button is chosen: then it says so, and restarts once they are closed. Outside Herdr, or in
  // a pane `open` didn't start (no --version: Herdr's own plugin pane, which closes when the board
  // quits), it only says so.
  const here = dirname(fileURLToPath(import.meta.url))
  let seen = ""
  let restarting = false
  const checkUpdate = () => {
    const now = versionOf(here)
    const changed = now && now !== VERSION
    if (!changed) {
      seen = ""
      return ""
    }
    const ready = seen === now
    seen = now
    const busy = scroll.detail || (scroll.button ?? -1) >= 0
    const canRestart = env.HERDR_ENV === "1" && env.HERDR_PANE_ID && opts.version
    if (ready && !busy && !restarting && canRestart) {
      restarting = true
      const args = [join(here, "board.mjs"), "pane-restart", env.HERDR_PANE_ID, "--board", file, "--origin", opts.origin || ""]
      spawn(process.execPath, args, { detached: true, stdio: "ignore", env }).unref()
      quit(0)
    }
    return canRestart
      ? `board ${now} is installed: this pane restarts with it${busy ? " once the details are closed and no button is chosen" : ""}`
      : `board ${now} is installed: press q, then open the board again`
  }
  let loading = false
  const refresh = async () => {
    if (loading) return
    loading = true
    try {
      data = await load(file, env)
      data.notice = checkUpdate()
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
    shownLines = []
    paint()
  })
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on("data", (chunk) => {
      for (const event of parseInput(chunk.toString("utf8"))) {
        if (event.type === "key" && event.name === "quit") quit(0)
        if (event.type === "key" && event.name === "redraw") {
          shownLines = []
          refresh()
          continue
        }
        if (!drawn) continue
        event.at = Date.now()
        const result = handleInput(scroll, event, drawn)
        scroll = result.scroll
        if (result.action) {
          ctx.drawn = drawn
          perform(result.action, ctx).then(say, crash)
        }
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
