#!/usr/bin/env node
// The board pane: draws the job board (board.mjs) and redraws it every 3 s, and at once when the
// board file changes or the pane is resized. It only reads the board; board.mjs writes it.
//
//   node board-pane.mjs [--board <file>] [--interval <s>]
//   node board-pane.mjs --once [--width N] [--height N] [--color]
//
// `board.mjs open` starts it in a split right of the calling pane. Three
// columns, WAITING ON YOU, DOING and TO DO, with "Done today" at the bottom; under 70 cells
// wide the columns stack. Each card: the title, the description over up to 3 lines, for
// Waiting the ask ("→ …"), and the age. Doing items show their agent's live status from
// `herdr agent list`; a blocked agent shows under Waiting. It also keeps the sidebar's $board
// token current.
// No flicker: it draws on the alternate screen, overwrites lines in place, and only writes
// when the text changed. Keys: q quits, r redraws.
//
// --once prints one frame (no colour unless --color) and exits: for tests and a quick look.
// The board file: --board, else JOB_BOARD_FILE, else the current directory's repo.

import { watch } from "node:fs"
import { basename, dirname, resolve, sep } from "node:path"

import { boardPath, buildView, emptyBoard, listAgentsAsync, readBoard, render, repoName, reportToken, textWidth, tokenText } from "./board.mjs"

function parse(argv) {
  const opts = { interval: 3, once: false, color: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--once") opts.once = true
    else if (a === "--color") opts.color = true
    else if (a === "--no-color") opts.color = false
    else if (["--board", "--interval", "--width", "--height"].includes(a) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
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

async function frame(file, env, { width, height, color }) {
  const now = env.JOB_BOARD_NOW ? new Date(env.JOB_BOARD_NOW) : new Date()
  const agents = await listAgentsAsync(env)
  let state = emptyBoard()
  let error = ""
  try {
    state = readBoard(file)
  } catch (e) {
    error = e.message
  }
  const view = buildView(state, agents, { now, workspace: env.HERDR_WORKSPACE_ID || "" })
  return { text: render(view, { width, height, color, now, repo: repoName(file), error }), token: error ? null : tokenText(view) }
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
    process.stderr.write(
      "board-pane: no board here. Run `node board.mjs open` from the repo, or pass --board <file>.\n",
    )
    return 2
  }

  if (opts.once) {
    const size = { width: Number(opts.width) || process.stdout.columns || 100, height: Number(opts.height) || Infinity }
    const { text } = await frame(file, env, { ...size, color: opts.color === true })
    process.stdout.write(`${text}\n`)
    return 0
  }

  const out = process.stdout
  const color = opts.color ?? !env.NO_COLOR
  let last = ""
  let lastToken
  let busy = false
  let again = false
  // Synchronised update (ignored by terminals that lack it), cursor home, then each line in place.
  const paint = (text) => {
    const cols = out.columns || 80
    const lines = text.split("\n")
    const body = lines.map((l) => (textWidth(l.replace(ANSI, "")) < cols ? `${l}\x1b[K` : l)).join("\r\n")
    out.write(`\x1b[?2026h\x1b[H${body}\x1b[J\x1b[?2026l`)
  }
  const draw = async () => {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      // One cell of margin on the right, so a full last column never wraps.
      const { text, token } = await frame(file, env, { width: (out.columns || 80) - 1, height: out.rows || 24, color })
      if (text !== last) {
        paint(text)
        last = text
      }
      if (token !== null && token !== lastToken) {
        reportToken(token, env, { wait: false })
        lastToken = token
      }
    } finally {
      busy = false
      if (again) {
        again = false
        draw()
      }
    }
  }

  const restore = () => out.write("\x1b[?25h\x1b[?1049l")
  const quit = () => {
    restore()
    process.exit(0)
  }
  out.write("\x1b[?1049h\x1b[?25l\x1b[2J")
  process.on("exit", restore)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, quit)
  out.on("resize", () => {
    last = ""
    draw()
  })
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on("data", (key) => {
      const k = key.toString()
      if (k === "q" || k === "\x03") quit()
      if (k === "r") {
        last = ""
        draw()
      }
    })
  }
  // The file is replaced by a rename on every write, so watch its folder, not the file.
  let pending
  try {
    watch(dirname(file), (_, name) => {
      if (name && name !== basename(file)) return
      clearTimeout(pending)
      pending = setTimeout(draw, 100)
    })
  } catch {}
  setInterval(draw, Math.max(1, Number(opts.interval) || 3) * 1000)
  await draw()
  return null
}

main().then((code) => {
  if (code !== null) process.exitCode = code
})
