// Run: node --test (from the repo root)
// Install, update and run: version, hooks, doctor, restart, and a board pane that picks up an
// update of its own folder. Herdr is faked (fixtures/fake-herdr.mjs).
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { verifyCopy } from "../board.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const FAKE_HERDR = join(ROOT, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version

/**
 * A temp folder with a copy of the plugin (so its version can change, as an update does), a git
 * repo, a Claude settings folder (HOME) and a fake Herdr with the given state.
 */
function setup(state = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-install-")))
  const plugin = join(base, "plugin")
  mkdirSync(plugin)
  for (const f of ["board.mjs", "board-pane.mjs", "links.mjs", "herdr-plugin.toml", "package.json", "hooks"]) cpSync(join(ROOT, f), join(plugin, f), { recursive: true })
  const repo = join(base, "app")
  mkdirSync(repo)
  spawnSync("git", ["-C", repo, "init", "-q"])
  const home = join(base, "home")
  mkdirSync(join(home, ".config", "herdr"), { recursive: true })
  const herdr = join(base, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ panes: [{ pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", cwd: repo }], ...state }))
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", JOB_BOARD_HOME: "", HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", HERDR_PANE_ID: "w9:p1", NO_COLOR: "1" }
  for (const key of ["JOB_BOARD_FILE", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT"]) delete env[key]
  const run = (args, extra = {}) => spawnSync(process.execPath, [join(plugin, "board.mjs"), ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" })
  const herdrState = () => JSON.parse(readFileSync(herdr, "utf8"))
  const setHerdr = (change) => {
    const s = herdrState()
    change(s)
    writeFileSync(herdr, JSON.stringify(s))
  }
  const setVersion = (v) => {
    const toml = join(plugin, "herdr-plugin.toml")
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^version = "[^"]*"/m, `version = "${v}"`))
  }
  const installed = { plugin_id: "herdr-job-board", version: VERSION, plugin_root: plugin, enabled: true, source: { kind: "github", owner: "larrychannon", repo: "herdr-job-board", resolved_commit: "abc1234def" } }
  // The store: HOME is the temp home, so ~/.local/state/herdr-job-board is in the temp folder.
  const store = join(home, ".local", "state", "herdr-job-board", "board.json")
  return { base, plugin, repo, home, store, herdr, env, run, herdrState, setHerdr, setVersion, installed, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("version and hooks: one command each, from the copy that runs them", () => {
  const t = setup()
  try {
    assert.equal(t.run(["version"]).stdout.trim(), VERSION)
    const hooks = t.run(["hooks"])
    assert.equal(hooks.status, 0, hooks.stderr)
    const settings = JSON.parse(hooks.stdout)
    for (const event of ["UserPromptSubmit", "Stop"]) assert.match(settings.hooks[event][0].hooks[0].command, new RegExp(`${t.plugin.replace(/[/.]/g, "\\$&")}/hooks/board-hook\\.mjs`))
    assert.match(t.run(["help"]).stdout, /restart [\s\S]*doctor /, "help lists them")
  } finally {
    t.done()
  }
})

test("doctor: says what works and the one command for what's missing; exit 1 only when something required is", () => {
  const t = setup()
  try {
    // Not installed: the install command, exit 1.
    let r = t.run(["doctor"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^herdr-job-board \d+\.\d+\.\d+ at /)
    assert.match(r.stdout, /^ok {4}Node\.js \d+/m)
    assert.match(r.stdout, /^ok {4}Herdr 0\.9\.3$/m)
    assert.match(r.stdout, /^fix {3}plugin not installed\n {6}herdr plugin install larrychannon\/herdr-job-board$/m)
    // Installed, nothing set up: the key binding and the sidebar lines to paste, the hooks
    // command; exit 0 (they are optional).
    t.setHerdr((s) => (s.plugins = [t.installed]))
    r = t.run(["doctor"])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /^ok {4}plugin installed: herdr-job-board [\d.]+ from larrychannon\/herdr-job-board @ abc1234$/m)
    assert.match(r.stdout, /^ok {4}the board: .*\/home\/\.local\/state\/herdr-job-board\/board\.json \(0 cards, 0 projects, created on the first add\)$/m)
    assert.match(r.stdout, new RegExp(`^add {3}no key binding: add this to ${join(t.home, ".config", "herdr", "config.toml").replace(/[/.]/g, "\\$&")}, then run \`herdr server reload-config\`\\n {6}\\[\\[keys\\.command\\]\\]`, "m"))
    assert.match(r.stdout, /command = "herdr-job-board\.open"/)
    assert.match(r.stdout, /^add {3}no "\$board" in the sidebar/m)
    assert.match(r.stdout, /^opt {3}Claude Code hooks not set up .*\n {6}node '.*\/plugin\/board\.mjs' hooks$/m)
    assert.match(r.stdout, /^ok {4}no board pane open$/m)
    // All set up: every line ok.
    writeFileSync(join(t.home, ".config", "herdr", "config.toml"), `[[keys.command]]\nkey = "prefix+b"\ntype = "plugin_action"\ncommand = "herdr-job-board.open"\n\n[ui.sidebar.spaces]\nrows = [["$board"]]\n`)
    mkdirSync(join(t.repo, ".claude"))
    writeFileSync(join(t.repo, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node "$HOME/.claude/skills/job/scripts/job-board.mjs" hook' }] }] } }))
    r = t.run(["doctor"])
    assert.equal(r.status, 0)
    assert.doesNotMatch(r.stdout, /^(fix|add|opt) /m, r.stdout)
    assert.match(r.stdout, /^ok {4}Claude Code hooks \(in .*\/app\/\.claude\/settings\.json\)$/m)
    // A board pane on an older version: the restart command, exit 1.
    t.setHerdr((s) => {
      s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: `node '${t.plugin}/board-pane.mjs' --board x --origin 'w9:p1' --version '0.3.9'` })
    })
    r = t.run(["doctor"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, new RegExp(`^fix {3}pane w9:p5 \\(tab w9:t1\\) runs 0\\.3\\.9, not ${VERSION.replace(/\./g, "\\.")}\\n {6}node '.*/plugin/board\\.mjs' restart$`, "m"))
    // A too old Herdr, and outside Herdr.
    t.setHerdr((s) => (s.version = "0.9.1"))
    assert.match(t.run(["doctor"]).stdout, /^fix {3}Herdr 0\.9\.1: the board needs 0\.9\.3 or newer\n {6}herdr update$/m)
    r = t.run(["doctor"], { HERDR_ENV: "0" })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^fix {3}not inside Herdr/m)
  } finally {
    t.done()
  }
})

test("restart: every board pane on an older version of this copy, or whose files are gone, restarts with this one; another copy is left alone", () => {
  const t = setup()
  try {
    const pane = (id, running) => ({ pane_id: id, tab_id: `w9:t${id.slice(4)}`, workspace_id: "w9", label: "board", running })
    t.setHerdr((s) => {
      s.panes.push(
        pane("w9:p5", `node '${t.plugin}/board-pane.mjs' --board /b/one.json --origin 'w9:p1'`),
        pane("w9:p6", `node '${t.plugin}/board-pane.mjs' --board /b/two.json --origin 'w9:p2' --version '${VERSION}'`),
        pane("w9:p7", `node '/gone/plugin/board-pane.mjs' --board /b/three.json --origin 'w9:p3'`),
        pane("w9:p8", `node '${ROOT}board-pane.mjs' --board /b/four.json --origin 'w9:p4' --version '0.1.0'`),
      )
      s.panes.push({ ...pane("w2:p9", `node '${t.plugin}/board-pane.mjs' --board /b/five.json --origin 'w2:p1' --version '0.3.9'`), workspace_id: "w2", tab_id: "w2:t1" })
    })
    const r = t.run(["restart"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: board [\d.]+ started \(it ran a version before 0\.4\.0\)/)
    assert.match(r.stdout, /pane w9:p7: board [\d.]+ started \(it ran \/gone\/plugin\/board-pane\.mjs, now gone\)/)
    assert.match(r.stdout, /pane w2:p9: board [\d.]+ started \(it ran 0\.3\.9\)/, "every workspace")
    assert.doesNotMatch(r.stdout, /w9:p6|w9:p8/, "up to date, and another copy that is still there, are left alone")
    const runs = t.herdrState().log.filter((a) => a[0] === "pane" && a[1] === "run")
    assert.deepEqual(runs.map((a) => a[2]), ["w9:p5", "w9:p7", "w2:p9"])
    // Each keeps its own board file and coordinator.
    assert.equal(runs[0][3], `node '${t.plugin}/board-pane.mjs' --board '/b/one.json' --origin 'w9:p1' --version '${VERSION}'`)
    assert.match(runs[2][3], /--board '\/b\/five\.json' --origin 'w2:p1'/)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text").map((a) => [a[2], a[3]]), [["w9:p5", "q"], ["w9:p7", "q"], ["w2:p9", "q"]])
    assert.match(t.run(["restart"]).stdout, /every board pane runs [\d.]+: nothing to restart/)
    assert.match(t.run(["restart"], { HERDR_ENV: "0" }).stderr, /needs Herdr/)
  } finally {
    t.done()
  }
})

test("an update of the pane's own folder: the running pane restarts itself with the new copy, in the same pane", { skip: !/util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "") && "needs util-linux script" }, async () => {
  const t = setup()
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  let child
  try {
    const board = t.store
    assert.equal(t.run(["add", "todo", "Something"]).status, 0)
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board" }))
    const cmd = `stty cols 100 rows 30; exec node '${t.plugin}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '${VERSION}' --interval 1`
    child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5", JOB_BOARD_UPDATE_SETTLE_MS: "1500" }, detached: true })
    let out = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    await pause(1500)
    assert.match(out, /Something/)
    t.setVersion("9.9.9")
    // The new version stands still for the settle time, the copy checks out, then it hands over and quits.
    const exited = await Promise.race([new Promise((r) => child.on("exit", () => r(true))), pause(8000).then(() => false)])
    assert.ok(exited, "the old pane quit")
    let run
    for (let i = 0; i < 50 && !run; i++) {
      await pause(100)
      run = t.herdrState().log.find((a) => a[0] === "pane" && a[1] === "run" && a[2] === "w9:p5")
    }
    assert.ok(run, "the new copy was started in the same pane")
    assert.equal(run[3], `node '${t.plugin}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '9.9.9'`)

    // A pane `open` didn't start (no --version: Herdr's plugin pane closes when the board quits)
    // only says so, and keeps running.
    const plain = `stty cols 100 rows 30; exec node '${t.plugin}/board-pane.mjs' --board '${board}' --interval 1`
    child = spawn("script", ["-qefc", plain, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5" }, detached: true })
    let said = ""
    child.stdout.on("data", (d) => (said += d.toString("utf8")))
    await pause(1500)
    t.setVersion("9.9.10")
    await pause(3500)
    assert.equal(child.exitCode, null, "still running")
    assert.match(said, /board 9\.9\.10 is installed: press q, then open the board again/)
    child.stdin.write("q")
  } finally {
    try {
      if (child && child.exitCode === null) process.kill(-child.pid, "SIGKILL")
    } catch {}
    t.done()
  }
})

const hasScript = /util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "")
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** The live pane of `t`'s plugin copy in a pty, as `open` starts it, in pane w9:p5. */
function livePane(t, extra = {}) {
  const board = t.store
  if (!existsSync(board)) assert.equal(t.run(["add", "todo", "Something"]).status, 0)
  t.setHerdr((s) => s.panes.some((p) => p.pane_id === "w9:p5") || s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board" }))
  const cmd = `stty cols 100 rows 30; exec node '${t.plugin}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '${VERSION}' --interval 1`
  const child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5", JOB_BOARD_UPDATE_SETTLE_MS: "1500", ...extra }, detached: true })
  const live = { child, out: "", exited: false, board }
  child.stdout.on("data", (d) => (live.out += d.toString("utf8")))
  child.on("exit", () => (live.exited = true))
  live.kill = () => {
    try {
      if (!live.exited) process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  return live
}
const runs = (t) => t.herdrState().log.filter((a) => a[0] === "pane" && a[1] === "run")
/** What the pane wrote, as words: escape sequences and line breaks (a notice wraps) as spaces. */
const words = (live) => live.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, " ").replace(/\s+/g, " ")

test("a broken update is never started: the pane keeps running, says why, and starts it once a good copy lands", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    live = livePane(t)
    await pause(1500)
    // The review's case: the version moves on and board.mjs is half written.
    t.setVersion("9.9.9")
    appendFileSync(join(t.plugin, "board.mjs"), "\nthis is not js {\n")
    await pause(5000)
    assert.equal(live.exited, false, "the old pane is still running")
    assert.match(words(live), /update to 9\.9\.9 failed to start: board\.mjs doesn't parse/)
    assert.match(words(live), /run herdr plugin install larrychannon\/herdr-job-board again/)
    assert.deepEqual(runs(t), [], "nothing started in the pane")
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text"), [], "and nothing typed into it")
    // The update finishes (a good board.mjs at 9.9.9): the folder changed, so it is checked again, and started.
    cpSync(join(ROOT, "board.mjs"), join(t.plugin, "board.mjs"))
    for (let i = 0; i < 80 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, "the pane handed over")
    let run
    for (let i = 0; i < 50 && !run; i++) {
      await pause(100)
      run = runs(t)[0]
    }
    assert.ok(run, "pane-restart started the new copy")
    assert.match(run[3], /--version '9\.9\.9'$/)
  } finally {
    live?.kill()
    t.done()
  }
})

test("a rollback to a board before 0.4.0 (no pane-restart) is not started either: no bare shell", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    live = livePane(t)
    await pause(1500)
    // 0.3.5's files: they parse, but its `version` is an unknown command.
    for (const f of ["board.mjs", "board-pane.mjs", "links.mjs", "herdr-plugin.toml"]) {
      writeFileSync(join(t.plugin, f), spawnSync("git", ["-C", ROOT, "show", `8401ffb:${f}`], { encoding: "utf8" }).stdout)
    }
    await pause(5000)
    assert.equal(live.exited, false)
    assert.match(words(live), /board 0\.3\.5 can't take over this pane by itself: board\.mjs version failed \(a board before 0\.4\.0 can't restart a pane\); quit \(q\) and open the board again to run 0\.3\.5/)
    assert.doesNotMatch(words(live), /install .* again/, "a rollback isn't undone by the advice")
    assert.deepEqual(runs(t), [])
  } finally {
    live?.kill()
    t.done()
  }
})

test("a new version is checked only after it stood still for the settle time, not on the next refresh", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    live = livePane(t, { JOB_BOARD_UPDATE_SETTLE_MS: "4000" })
    for (let i = 0; i < 100 && !/Something/.test(live.out); i++) await pause(100)
    await pause(300)
    t.setVersion("9.9.9")
    await pause(2500)
    assert.equal(live.exited, false, "2.5 s after the write: still the old pane")
    assert.match(live.out, /board 9\.9\.9 is installed: this pane restarts with it/)
    // Written again (the update goes on): the clock starts again.
    t.setVersion("9.9.9")
    writeFileSync(join(t.plugin, "links.mjs"), readFileSync(join(ROOT, "links.mjs"), "utf8") + "\n")
    await pause(2500)
    assert.equal(live.exited, false, "the folder changed 2.5 s ago: still waiting")
    for (let i = 0; i < 200 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, "then it hands over")
  } finally {
    live?.kill()
    t.done()
  }
})

test("pane-restart failures are logged and shown by the next board started in that pane; skips and old entries are not", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  const log = () => readFileSync(join(t.home, ".local", "state", "herdr-job-board", "restart.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const restart = () => t.run(["pane-restart", "w9:p5", "--board", t.store, "--origin", "w9:p1"])
  try {
    // The user's `restart` leaves a pane alone on purpose (an old board with no --board file):
    // nothing is typed into it, and it is logged as a skip.
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: `node '${t.plugin}/board-pane.mjs' --origin 'w9:p1' --version '0.3.9'` }))
    let r = t.run(["restart"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: not restarted: the board there has no --board file/)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text" || a[1] === "run"), [])
    assert.deepEqual([log().at(-1).pane, log().at(-1).ok, log().at(-1).skipped], ["w9:p5", null, true])
    t.setHerdr((s) => delete s.panes.find((x) => x.pane_id === "w9:p5").running)
    live = livePane(t)
    await pause(1500)
    assert.doesNotMatch(live.out, /the last restart in this pane failed/, "a skip is not a failure")
    live.kill()
    // pane-restart, and the pane never gets back to its prompt (vim runs there): a failure, shown.
    t.setHerdr((s) => (s.panes.find((x) => x.pane_id === "w9:p5").running = "vim notes.md"))
    r = t.run(["pane-restart", "w9:p5", "--board", t.store, "--origin", "w9:p1"], { JOB_BOARD_RESTART_WAIT_MS: "1000" })
    assert.match(r.stdout, /pane w9:p5: the pane didn't get back to its prompt within 1 s after the old board quit \(vim runs there\)/)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text" || a[1] === "run"), [], "nothing typed into vim")
    assert.equal(log().at(-1).ok, false)
    t.setHerdr((s) => delete s.panes.find((x) => x.pane_id === "w9:p5").running)
    live = livePane(t)
    await pause(1500)
    assert.match(words(live), /the last restart in this pane failed: the pane didn't get back to its prompt/)
    live.kill()
    // A shell that Herdr won't run the board in: a failure, logged; the board opened there next says so, once.
    t.setHerdr((s) => {
      const p = s.panes.find((x) => x.pane_id === "w9:p5")
      delete p.running
      p.refuse_run = true
    })
    r = restart()
    assert.match(r.stdout, /pane w9:p5: couldn't start board [\d.]+: herdr pane run failed/)
    assert.deepEqual([log().at(-1).ok, log().at(-1).skipped], [false, undefined])
    t.setHerdr((s) => delete s.panes.find((x) => x.pane_id === "w9:p5").refuse_run)
    live = livePane(t)
    await pause(1500)
    assert.match(live.out, /the last restart in this pane failed: couldn't start board/)
    live.kill()
    live = livePane(t)
    await pause(1500)
    assert.doesNotMatch(live.out, /the last restart in this pane failed/, "shown once")
    live.kill()
    // A failure from more than a few minutes ago is about another board (Herdr reuses pane ids).
    const file = join(t.home, ".local", "state", "herdr-job-board", "restart.log")
    appendFileSync(file, `${JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), pane: "w9:p5", ok: false, error: "an old failure" })}\n`)
    live = livePane(t)
    await pause(1500)
    assert.doesNotMatch(live.out, /an old failure/)
  } finally {
    live?.kill()
    t.done()
  }
})

test("restart looks again before typing: a pane with no board file, quit meanwhile, or restarted by itself gets no q", () => {
  const t = setup()
  try {
    const old = (board = " --board /b/x.json") => `node '${t.plugin}/board-pane.mjs'${board} --origin 'w9:p1' --version '0.3.9'`
    const now = `node '${t.plugin}/board-pane.mjs' --board /b/x.json --origin 'w9:p1' --version '${VERSION}'`
    const pane = (id, running, next) => ({ pane_id: id, tab_id: "w9:t1", workspace_id: "w9", label: "board", running, ...(next ? { next } : {}) })
    t.setHerdr((s) =>
      s.panes.push(
        pane("w9:p5", old("")), // no --board: nothing to start again
        pane("w9:p6", old(), [null]), // quit before restart looked again: a shell now
        pane("w9:p7", old(), [now]), // restarted itself meanwhile
        pane("w9:p8", old()), // still the old one: restarted
      ),
    )
    const r = t.run(["restart"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: not restarted: the board there has no --board file/)
    assert.match(r.stdout, /pane w9:p6: not restarted: its board was quit meanwhile/)
    assert.match(r.stdout, /pane w9:p7: already runs board /)
    assert.match(r.stdout, /pane w9:p8: board [\d.]+ started/)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text").map((a) => a[2]), ["w9:p8"], "q went only to the board that still ran the old version")
    assert.deepEqual(runs(t).map((a) => a[2]), ["w9:p8"])
  } finally {
    t.done()
  }
})

test("verifyCopy: a copy that parses but can't link (a bad import) doesn't start; the pane stays with the notice", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    assert.equal(t.run(["add", "todo", "Something"]).status, 0)
    const board = t.store
    assert.equal(await verifyCopy(t.plugin, VERSION, t.env, board), null, "the copy as it is starts")
    live = livePane(t)
    await pause(1500)
    // The re-check's badlink: version 0.4.1, and board-pane.mjs imports what board.mjs doesn't export.
    t.setVersion("0.4.1")
    const pane = join(t.plugin, "board-pane.mjs")
    writeFileSync(pane, readFileSync(pane, "utf8").replace("  WORKING_FRAMES,\n", "  WORKING_FRAMES,\n  NO_SUCH_EXPORT,\n"))
    assert.equal(spawnSync(process.execPath, ["--check", pane]).status, 0, "it parses")
    assert.match(await verifyCopy(t.plugin, "0.4.1", t.env, board), /board-pane\.mjs doesn't start \(SyntaxError: .*NO_SUCH_EXPORT/)
    await pause(5000)
    assert.equal(live.exited, false, "the old pane is still running")
    assert.match(words(live), /update to 0\.4\.1 failed to start: board-pane\.mjs doesn't start/)
    assert.deepEqual(runs(t), [])
  } finally {
    live?.kill()
    t.done()
  }
})

test("restart sends q only to a pane still stale just before; pane-restart says why only into a shell", () => {
  const t = setup()
  try {
    const old = `node '${t.plugin}/board-pane.mjs' --board /b/x.json --origin 'w9:p1' --version '0.3.9'`
    const now = `node '${t.plugin}/board-pane.mjs' --board /b/x.json --origin 'w9:p1' --version '${VERSION}'`
    // The re-check's race: old at the listing, old at restart's look, this version at quitBoard's look.
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p9", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: old, next: [old, now] }))
    const r = t.run(["restart"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p9: already runs board /)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text" || a[1] === "run"), [], "no q, no restart")
  } finally {
    t.done()
  }
  for (const [becomes, printed] of [["zsh-prompt-hook --slow", false], [null, true]]) {
    const u = setup()
    try {
      // The new board doesn't show as running within 3 s: something slow (busy) or back to the shell.
      u.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", run_becomes: becomes }))
      const r = u.run(["pane-restart", "w9:p5", "--board", u.store, "--origin", "w9:p1"])
      assert.match(r.stdout, /didn't stay running in this pane/)
      const typed = runs(u).filter((a) => a[2] === "w9:p5" && /^printf /.test(a[3]))
      assert.equal(typed.length, printed ? 1 : 0, printed ? "said in the shell" : "never typed into a pane that isn't a shell")
    } finally {
      u.done()
    }
  }
})

test("pane-restart waits out a briefly busy shell (a prompt hook) after the old board quits, and starts the board once", () => {
  const t = setup()
  try {
    const board = t.store
    const old = `node '${t.plugin}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '0.3.9'`
    const hook = "/Users/me/.ssh/agent-live /Users/me/.ssh/agent/forwarded"
    // The re-check's repro: the old board, then the zsh precmd probe twice, then the shell.
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: old, next: [hook, hook, null] }))
    const r = t.run(["pane-restart", "w9:p5", "--board", board, "--origin", "w9:p1"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: board [\d.]+ started/)
    assert.deepEqual(runs(t).map((a) => a[2]), ["w9:p5"], "exactly one pane run")
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text"), [], "and no q: the old board quit by itself")
    const log = readFileSync(join(t.home, ".local", "state", "herdr-job-board", "restart.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(log.at(-1).ok, true)
  } finally {
    t.done()
  }
})

test("a new board that shows late (the pane busy for 3.5 s after pane run) is not a failed restart, nor reported by the board itself", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    assert.equal(t.run(["add", "todo", "Something"]).status, 0)
    const board = t.store
    const hook = "/Users/me/.ssh/agent-live /Users/me/.ssh/agent/forwarded"
    const started = `node '${t.plugin}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '${VERSION}'`
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", run_becomes: hook, run_then: [...Array(35).fill(hook), started] }))
    const r = t.run(["pane-restart", "w9:p5", "--board", board, "--origin", "w9:p1"])
    assert.match(r.stdout, /pane w9:p5: board [\d.]+ started/)
    const file = join(t.home, ".local", "state", "herdr-job-board", "restart.log")
    assert.equal(JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)).ok, true)
    // And when pane-restart did give up a moment before the board came up after all, the board
    // that came up doesn't report it: it is the board that entry was about.
    appendFileSync(file, `${JSON.stringify({ at: new Date(Date.now() - 4000).toISOString(), pane: "w9:p5", ok: false, kind: "start", version: VERSION, error: "board didn't stay running in this pane" })}\n`)
    t.setHerdr((s) => {
      const p = s.panes.find((x) => x.pane_id === "w9:p5")
      delete p.running
      delete p.next
    })
    live = livePane(t)
    await pause(1500)
    assert.doesNotMatch(live.out, /the last restart in this pane failed/)
  } finally {
    live?.kill()
    t.done()
  }
})

test("a new copy whose dry run hangs: a few tries with growing waits, then a failure notice; no endless retries", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    live = livePane(t, { JOB_BOARD_VERIFY_TIMEOUT_MS: "400", JOB_BOARD_VERIFY_BACKOFF_MS: "300", JOB_BOARD_UPDATE_SETTLE_MS: "1000" })
    await pause(1500)
    // 0.4.1, whose pane hangs in --once (it parses, links, and says its version): each start is counted.
    const marker = join(t.base, "dry-runs")
    t.setVersion("0.4.1")
    const pane = join(t.plugin, "board-pane.mjs")
    writeFileSync(
      pane,
      readFileSync(pane, "utf8").replace('import { osc52 } from "./links.mjs"\n', `import { osc52 } from "./links.mjs"\nimport { appendFileSync as markRun } from "node:fs"\nif (process.argv.includes("--once")) { markRun(${JSON.stringify(marker)}, "x"); await new Promise(() => setInterval(() => {}, 1000)) }\n`),
    )
    for (let i = 0; i < 150 && !/took too long to start/.test(words(live)); i++) await pause(100)
    assert.match(words(live), /update to 0\.4\.1 failed to start: the new copy took too long to start \(a check ran over 400 ms, 3 times\); run herdr plugin install larrychannon\/herdr-job-board again/)
    const tries = readFileSync(marker, "utf8").length
    assert.equal(tries, 3, "three tries")
    await pause(2500)
    assert.equal(readFileSync(marker, "utf8").length, 3, "and no more after the notice")
    assert.equal(live.exited, false)
    assert.deepEqual(runs(t), [])
  } finally {
    live?.kill()
    t.done()
  }
})
