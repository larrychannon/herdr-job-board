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
  return { base, plugin, repo, home, store, herdr, env, run, herdrState, setHerdr, setVersion, installed, done: () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
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
    assert.match(r.stdout, /^add {3}no key binding for the board in .*\/home\/\.config\/herdr\/config\.toml$/m)
    assert.match(r.stdout, /^add {3}no "\$board" in the sidebar's space rows$/m)
    assert.match(r.stdout, /^ {6}node '.*board\.mjs' setup --dry-run {3}\(to see the change\), then: node '.*board\.mjs' setup$/m)
    assert.match(r.stdout, /^opt {3}Claude Code hooks not set up .*\n {6}node '.*\/plugin\/board\.mjs' hooks$/m)
    assert.match(r.stdout, /^ok {4}no board pane open$/m)
    // All set up: every line ok.
    writeFileSync(join(t.home, ".config", "herdr", "config.toml"), `[[keys.command]]\nkey = "prefix+b"\ntype = "plugin_action"\ncommand = "herdr-job-board.open"\n\n[ui.sidebar.spaces]\nrows = [["$board"]]\n`)
    mkdirSync(join(t.repo, ".claude"))
    const hook = [{ hooks: [{ command: 'node "$HOME/.claude/skills/job/scripts/job-board.mjs" hook' }] }]
    writeFileSync(join(t.repo, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: hook } }))
    // Hooks without SessionStart (0.10.0): right; SessionStart is said apart, coordinator only.
    r = t.run(["doctor"])
    assert.equal(r.status, 0)
    assert.doesNotMatch(r.stdout, /^(fix|add|opt) /m, r.stdout)
    assert.match(r.stdout, /^ok {4}Claude Code hooks \(in .*\/app\/\.claude\/settings\.json\)$/m)
    assert.match(r.stdout, /^note  SessionStart \(the inbox socket, coordinator only\): in the coordinator's start script's --settings, not a settings file\n {6}node '.*' hooks --coordinator$/m)
    // The board's SessionStart in a settings file: take it out (a session-sync one is fine).
    writeFileSync(join(t.repo, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: hook, Stop: hook } }))
    r = t.run(["doctor"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^fix {3}.*\/app\/\.claude\/settings\.json runs the board's hook on SessionStart: take it out; it belongs in the coordinator's start script's --settings only$/m)
    assert.doesNotMatch(r.stdout, /^note  SessionStart/m)
    writeFileSync(join(t.repo, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "bash session-sync.sh" }] }], Stop: hook } }))
    r = t.run(["doctor"])
    assert.equal(r.status, 0)
    assert.doesNotMatch(r.stdout, /^(fix|add|opt) /m, r.stdout)
    writeFileSync(join(t.repo, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: hook } }))
    // A board pane on an older version: the restart command, exit 1.
    t.setHerdr((s) => {
      s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: `node '${t.plugin}/board-pane.mjs' --board x --origin 'w9:p1' --version '0.3.9'` })
    })
    r = t.run(["doctor"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, new RegExp(`^fix {3}pane w9:p5 \\(tab w9:t1\\) runs 0\\.3\\.9, not ${VERSION.replace(/\./g, "\\.")}\\n {6}node '.*/plugin/board\\.mjs' restart {3}\\(or node '.*/plugin/board\\.mjs' open, from the pane left of it\\)$`, "m"))
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
    // The re-check's badlink: version 9.5.1, and board-pane.mjs imports what board.mjs doesn't export.
    t.setVersion("9.5.1")
    const pane = join(t.plugin, "board-pane.mjs")
    writeFileSync(pane, readFileSync(pane, "utf8").replace("  WORKING_FRAMES,\n", "  WORKING_FRAMES,\n  NO_SUCH_EXPORT,\n"))
    assert.equal(spawnSync(process.execPath, ["--check", pane]).status, 0, "it parses")
    assert.match(await verifyCopy(t.plugin, "9.5.1", t.env, board), /board-pane\.mjs doesn't start \(SyntaxError: .*NO_SUCH_EXPORT/)
    await pause(5000)
    assert.equal(live.exited, false, "the old pane is still running")
    assert.match(words(live), /update to 9\.5\.1 failed to start: board-pane\.mjs doesn't start/)
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
    // 9.5.1, whose pane hangs in --once (it parses, links, and says its version): each start is counted.
    const marker = join(t.base, "dry-runs")
    t.setVersion("9.5.1")
    const pane = join(t.plugin, "board-pane.mjs")
    writeFileSync(
      pane,
      readFileSync(pane, "utf8").replace('import { osc52 } from "./links.mjs"\n', `import { osc52 } from "./links.mjs"\nimport { appendFileSync as markRun } from "node:fs"\nif (process.argv.includes("--once")) { markRun(${JSON.stringify(marker)}, "x"); await new Promise(() => setInterval(() => {}, 1000)) }\n`),
    )
    for (let i = 0; i < 150 && !/took too long to start/.test(words(live)); i++) await pause(100)
    assert.match(words(live), /update to 9\.5\.1 failed to start: the new copy took too long to start \(a check ran over 400 ms, 3 times\); run herdr plugin install larrychannon\/herdr-job-board again/)
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

// --- Herdr 0.9.5's install layout --------------------------------------------------------------
// Herdr 0.9.3 cloned the plugin to plugins/github/herdr-job-board-<hash>/ and updated it there;
// 0.9.5 installs (and updates) it to plugins/github-installations/herdr-job-board-<hash>/<n>/checkout,
// a new <n> each time (seen: 3898869-0, with an empty .in-use beside checkout), and its
// `plugin list` says plugin_root is that checkout. The old folder stays behind.

/** `t`'s HOME with that layout: copies of the plugin in the 0.9.3 folder and in <n> folders. */
function layout095(t) {
  const plugins = join(t.home, ".config", "herdr", "plugins")
  const id = "herdr-job-board-2d3b6201c876"
  const old = join(plugins, "github", id)
  const inst = (n) => join(plugins, "github-installations", id, n, "checkout")
  const copy = (dir, version = VERSION) => {
    mkdirSync(dir, { recursive: true })
    cpSync(t.plugin, dir, { recursive: true })
    const toml = join(dir, "herdr-plugin.toml")
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^version = "[^"]*"/m, `version = "${version}"`))
    return dir
  }
  // Herdr says where it is installed now (and the version it read).
  const installAt = (dir, version = VERSION) => {
    writeFileSync(join(dir, "..", ".in-use"), "")
    t.setHerdr((s) => (s.plugins = [{ ...t.installed, version, plugin_root: dir, manifest_path: join(dir, "herdr-plugin.toml"), source: { ...t.installed.source, managed_path: dir } }]))
  }
  return { plugins, old, inst, copy, installAt }
}

/** livePane, for the copy in `dir`. */
function livePaneAt(t, dir, extra = {}) {
  const board = t.store
  if (!existsSync(board)) assert.equal(t.run(["add", "todo", "Something"]).status, 0)
  t.setHerdr((s) => s.panes.some((p) => p.pane_id === "w9:p5") || s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board" }))
  const version = JSON.parse(JSON.stringify(readFileSync(join(dir, "herdr-plugin.toml"), "utf8").match(/^version = "([^"]*)"/m)[1]))
  const cmd = `stty cols 100 rows 30; exec node '${dir}/board-pane.mjs' --board '${board}' --origin 'w9:p1' --version '${version}' --interval 1`
  const child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5", JOB_BOARD_UPDATE_SETTLE_MS: "1000", JOB_BOARD_ROOT_CHECK_MS: "300", ...extra }, detached: true })
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

test("Herdr 0.9.5's layout: a pane on the old 0.9.3 folder hands over to the installed copy in its new <n> folder, then to the next <n>", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  const L = layout095(t)
  let live
  try {
    // The live case of 19 Oct: the pane runs the 0.9.3 folder; Herdr installed a newer copy elsewhere.
    L.copy(L.old)
    const first = L.copy(L.inst("3898869-0"), "9.9.9")
    L.installAt(first, "9.9.9")
    live = livePaneAt(t, L.old)
    for (let i = 0; i < 100 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, `the old pane handed over: ${words(live).slice(-300)}`)
    let run
    for (let i = 0; i < 50 && !run; i++) {
      await pause(100)
      run = runs(t).find((a) => a[2] === "w9:p5")
    }
    assert.ok(run, "the installed copy's pane-restart started its board in the same pane")
    assert.equal(run[3], `node '${first}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '9.9.9' --as-plugin`)
    const log = readFileSync(join(t.home, ".local", "state", "herdr-job-board", "restart.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.deepEqual([log.at(-1).pane, log.at(-1).ok, log.at(-1).version], ["w9:p5", true, "9.9.9"], "logged")
    assert.ok(existsSync(L.old), "nothing deleted")

    // The next update lands in another <n>: a pane on the first one follows again.
    t.setHerdr((s) => {
      s.log = []
      delete s.panes.find((p) => p.pane_id === "w9:p5").running
    })
    const second = L.copy(L.inst("4100000-0"), "9.9.10")
    L.installAt(second, "9.9.10")
    live = livePaneAt(t, first)
    for (let i = 0; i < 100 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, "the pane on the previous <n> handed over too")
    for (run = null; !run; await pause(100)) run = runs(t).find((a) => a[2] === "w9:p5")
    assert.match(run[3], new RegExp(`^node '${second.replace(/[.]/g, "\\.")}/board-pane\\.mjs' .*--version '9\\.9\\.10' --as-plugin$`))
  } finally {
    live?.kill()
    t.done()
  }
})

test("Herdr 0.9.5's layout: the installed copy is followed only when newer and when it starts; a development copy, and an older root, are left alone", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  const L = layout095(t)
  let live
  try {
    L.copy(L.old)
    // A broken installed copy: checked, never started; the pane says why and keeps running.
    const broken = L.copy(L.inst("5-0"), "9.9.9")
    appendFileSync(join(broken, "board.mjs"), "\nthis is not js {\n")
    L.installAt(broken, "9.9.9")
    live = livePaneAt(t, L.old)
    for (let i = 0; i < 80 && !/failed to start/.test(words(live)); i++) await pause(100)
    assert.match(words(live), /update to 9\.9\.9 failed to start: board\.mjs doesn't parse/)
    assert.equal(live.exited, false)
    assert.deepEqual(runs(t), [])
    live.kill()
    // An installed copy older than the pane: no hand-over (installing it again is the way back).
    L.installAt(L.copy(L.inst("6-0"), "0.0.1"), "0.0.1")
    live = livePaneAt(t, L.old)
    await pause(2500)
    assert.equal(live.exited, false)
    assert.doesNotMatch(words(live), /is installed/)
    live.kill()
    // A development copy (outside Herdr's plugins folder) never follows the installed one.
    L.installAt(L.copy(L.inst("7-0"), "9.9.9"), "9.9.9")
    live = livePaneAt(t, t.plugin)
    await pause(2500)
    assert.equal(live.exited, false)
    assert.doesNotMatch(words(live), /is installed/)
    assert.deepEqual(runs(t), [])
  } finally {
    live?.kill()
    t.done()
  }
})

test("Herdr 0.9.5's layout: restart and doctor from the installed copy move panes off old install folders; doctor prints the rm -rf for the 0.9.3 folder and deletes nothing", () => {
  const t = setup()
  const L = layout095(t)
  try {
    L.copy(L.old, "0.4.0")
    const older = L.copy(L.inst("100-0"), VERSION)
    const root = L.copy(L.inst("3898869-0"), VERSION)
    L.installAt(root)
    const cli = (args, extra = {}) => spawnSync(process.execPath, [join(root, "board.mjs"), ...args], { cwd: t.repo, env: { ...t.env, ...extra }, encoding: "utf8" })
    const pane = (id, dir, version) => ({ pane_id: id, tab_id: `w9:t${id.slice(4)}`, workspace_id: "w9", label: "board", running: `node '${dir}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${version}'` })
    // A pane on the 0.9.3 folder (0.4.0), one on an older <n> at the same version, one on the root.
    t.setHerdr((s) => s.panes.push(pane("w9:p5", L.old, "0.4.0"), pane("w9:p6", older, VERSION), pane("w9:p7", root, VERSION)))
    let r = cli(["doctor"])
    assert.equal(r.status, 1, r.stdout)
    const at = (dir) => dir.replace(/[.]/g, "\\.")
    assert.match(r.stdout, new RegExp(`^fix {3}pane w9:p5 \\(tab w9:t5\\) runs 0\\.4\\.0 from ${at(L.old)}, not the installed copy \\(${at(VERSION)} at ${at(root)}\\)$`, "m"))
    assert.match(r.stdout, new RegExp(`^fix {3}pane w9:p6 \\(tab w9:t6\\) runs ${at(VERSION)} from ${at(older)}, not the installed copy \\(${at(VERSION)} at ${at(root)}\\)$`, "m"))
    assert.doesNotMatch(r.stdout, /pane w9:p7/)
    assert.match(r.stdout, new RegExp(`^ {6}node '${at(root)}/board\\.mjs' restart {3}\\(or node '${at(root)}/board\\.mjs' open, from the pane left of it\\)$`, "m"))
    assert.match(r.stdout, new RegExp(`^fix {3}${at(L.old)}: an old install of the board \\(0\\.4\\.0\\) that pane w9:p5 still runs\\n {6}node '.*' restart first, then: rm -rf '${at(L.old)}'$`, "m"))
    assert.match(r.stdout, new RegExp(`^note {2}${at(older)}: an older install of the board \\(${at(VERSION)}\\); Herdr removes it itself once nothing uses it$`, "m"))
    assert.doesNotMatch(r.stdout, new RegExp(`rm -rf '${at(older)}'`), "Herdr's own <n> folders are Herdr's to remove")
    assert.ok(existsSync(L.old) && existsSync(older), "doctor deletes nothing")

    // restart from the installed copy: both old-folder panes start the installed board; the root's is left alone.
    r = cli(["restart"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`pane w9:p5: board ${at(VERSION)} started \\(it ran 0\\.4\\.0 from ${at(L.old)}\\)`))
    assert.match(r.stdout, new RegExp(`pane w9:p6: board ${at(VERSION)} started \\(it ran ${at(VERSION)} from ${at(older)}\\)`))
    assert.deepEqual(runs(t).map((a) => a[2]), ["w9:p5", "w9:p6"])
    for (const a of runs(t)) assert.match(a[3], new RegExp(`^node '${at(root)}/board-pane\\.mjs' `))

    // Every pane on the installed copy now: doctor has only the orphan left, with its rm -rf; exit 0.
    r = cli(["doctor"])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /^ok {4}3 board panes open$/m)
    assert.match(r.stdout, new RegExp(`^fix {3}${at(L.old)}: an old install of the board \\(0\\.4\\.0\\) that Herdr no longer uses\\n {6}rm -rf '${at(L.old)}'$`, "m"))
    assert.ok(existsSync(L.old))
    // Hooks that still run the old folder: the command that prints the current ones.
    mkdirSync(join(t.home, ".claude"), { recursive: true })
    writeFileSync(join(t.home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${L.old}/hooks/board-hook.mjs'` }] }] } }))
    r = cli(["doctor"])
    assert.match(r.stdout, new RegExp(`^fix {3}the hooks in .*/home/\\.claude/settings\\.json run ${at(L.old)}, an older install folder: .*\\n {6}node '${at(root)}/board\\.mjs' hooks$`, "m"))
    assert.equal(r.status, 0, "optional: the exit code stays")
  } finally {
    t.done()
  }
})

test("Herdr 0.9.5's layout: restart and open typed from an old install folder run in the newer installed copy", () => {
  const t = setup()
  const L = layout095(t)
  try {
    L.copy(L.old)
    const root = L.copy(L.inst("3898869-0"), "9.9.9")
    L.installAt(root, "9.9.9")
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t5", workspace_id: "w9", label: "board", running: `node '${L.old}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}'` }))
    const r = spawnSync(process.execPath, [join(L.old, "board.mjs"), "restart"], { cwd: t.repo, env: t.env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, new RegExp(`is an old install folder: running it in the installed copy, 9\\.9\\.9 at ${root.replace(/[.]/g, "\\.")}`))
    assert.match(r.stdout, /pane w9:p5: board 9\.9\.9 started/)
    assert.match(runs(t)[0][3], new RegExp(`^node '${root.replace(/[.]/g, "\\.")}/board-pane\\.mjs' .*--version '9\\.9\\.9' --as-plugin$`))
    // From the installed copy itself, or with an installed copy that isn't newer: runs here.
    assert.doesNotMatch(spawnSync(process.execPath, [join(root, "board.mjs"), "restart"], { cwd: t.repo, env: t.env, encoding: "utf8" }).stderr, /old install folder/)
    L.installAt(root, "0.0.1")
    writeFileSync(join(root, "herdr-plugin.toml"), readFileSync(join(root, "herdr-plugin.toml"), "utf8").replace(/^version = "[^"]*"/m, 'version = "0.0.1"'))
    assert.doesNotMatch(spawnSync(process.execPath, [join(L.old, "board.mjs"), "restart"], { cwd: t.repo, env: t.env, encoding: "utf8" }).stderr, /old install folder/)
  } finally {
    t.done()
  }
})

// --- review of b461f74 ---------------------------------------------------------------------------

/** A development checkout of the board at `version`, outside Herdr's plugins folder (`herdr plugin link` of it). */
function devCheckout(t, name, version) {
  const dir = join(t.base, name)
  mkdirSync(dir, { recursive: true })
  cpSync(t.plugin, dir, { recursive: true })
  const toml = join(dir, "herdr-plugin.toml")
  writeFileSync(toml, readFileSync(toml, "utf8").replace(/^version = "[^"]*"/m, `version = "${version}"`))
  return dir
}
const linkAt = (t, dir, version) => t.setHerdr((s) => (s.plugins = [{ ...t.installed, version, plugin_root: dir, manifest_path: join(dir, "herdr-plugin.toml"), source: { kind: "local", path: dir } }]))

test("a linked dev checkout as Herdr's plugin_root is never followed: not by a pane, not by restart or open from an old install folder, not by restart run from it", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  const L = layout095(t)
  let live
  try {
    const inst = L.copy(L.inst("3898869-0"))
    const dev = devCheckout(t, "dev-board", "9.9.9")
    linkAt(t, dev, "9.9.9")
    // A pane on the install folder: no hand-over to the newer linked checkout.
    live = livePaneAt(t, inst)
    await pause(3500)
    assert.equal(live.exited, false, `still the installed copy's pane: ${words(live).slice(-200)}`)
    assert.doesNotMatch(words(live), /is installed/)
    assert.deepEqual(runs(t), [])
    live.kill()
    // restart typed from the install folder runs here, not in the checkout.
    t.setHerdr((s) => (s.panes.find((p) => p.pane_id === "w9:p5").running = `node '${inst}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}'`))
    let r = spawnSync(process.execPath, [join(inst, "board.mjs"), "restart"], { cwd: t.repo, env: t.env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /old install folder/)
    assert.deepEqual(runs(t), [])
    // restart run from the linked checkout (as its plugin action would): the install folder's pane stays.
    r = spawnSync(process.execPath, [join(dev, "board.mjs"), "restart"], { cwd: t.repo, env: { ...t.env, HERDR_PLUGIN_ROOT: dev }, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(runs(t), [], "no managed pane moved onto the checkout")
  } finally {
    live?.kill()
    t.done()
  }
})

test("restart from the installed root brings back a board started as the plugin from a once-linked checkout; one started by hand from a checkout stays", () => {
  const t = setup()
  const L = layout095(t)
  try {
    const root = L.copy(L.inst("3898869-0"))
    L.installAt(root)
    const dev = devCheckout(t, "dev-board", VERSION)
    const board = (id, dir, extra = "") => ({ pane_id: id, tab_id: `w9:t${id.slice(4)}`, workspace_id: "w9", label: "board", running: `node '${dir}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}'${extra}` })
    t.setHerdr((s) => s.panes.push(board("w9:p5", dev, " --as-plugin"), board("w9:p6", dev)))
    const doctor = spawnSync(process.execPath, [join(root, "board.mjs"), "doctor"], { cwd: t.repo, env: t.env, encoding: "utf8" })
    assert.match(doctor.stdout, /^fix {3}pane w9:p5 \(tab w9:t5\) runs .* from .*\/dev-board, not the installed copy/m)
    assert.match(doctor.stdout, /^note {2}pane w9:p6 \(tab w9:t6\) runs another copy: .*\/dev-board\/board-pane\.mjs$/m)
    const r = spawnSync(process.execPath, [join(root, "board.mjs"), "restart"], { cwd: t.repo, env: t.env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: board [\d.]+ started \(it ran [\d.]+ from .*\/dev-board\)/)
    assert.deepEqual(runs(t).map((a) => a[2]), ["w9:p5"], "the hand-started checkout pane is left alone")
    assert.equal(runs(t)[0][3], `node '${root}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}' --as-plugin`)
  } finally {
    t.done()
  }
})

test("a board started as the plugin from a linked checkout follows a newer installed root by itself", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  const L = layout095(t)
  let live
  try {
    const dev = devCheckout(t, "dev-board", VERSION)
    const root = L.copy(L.inst("4100000-0"), "9.9.9")
    L.installAt(root, "9.9.9")
    if (!existsSync(t.store)) assert.equal(t.run(["add", "todo", "Something"]).status, 0)
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board" }))
    const cmd = `stty cols 100 rows 30; exec node '${dev}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}' --as-plugin --interval 1`
    const child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5", JOB_BOARD_UPDATE_SETTLE_MS: "1000", JOB_BOARD_ROOT_CHECK_MS: "300" }, detached: true })
    live = { exited: false, kill: () => { try { if (!live.exited) process.kill(-child.pid, "SIGKILL") } catch {} } }
    child.on("exit", () => (live.exited = true))
    for (let i = 0; i < 100 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, "handed over")
    let run
    for (let i = 0; i < 50 && !run; i++) {
      await pause(100)
      run = runs(t).find((a) => a[2] === "w9:p5")
    }
    assert.match(run?.[3] ?? "", new RegExp(`^node '${root.replace(/[.]/g, "\\.")}/board-pane\\.mjs' .*--version '9\\.9\\.9' --as-plugin$`))
  } finally {
    live?.kill()
    t.done()
  }
})

test("doctor's old folders are this board by its manifest id: a sibling plugin's herdr-job-board-qa-<hash> gets no rm -rf; a folder hooks still run gets the hooks fix first", () => {
  const t = setup()
  const L = layout095(t)
  try {
    const root = L.copy(L.inst("3898869-0"))
    L.installAt(root)
    // A sibling plugin (id herdr-job-board-qa) installed by Herdr 0.9.3, listed by Herdr.
    const qa = L.copy(join(L.plugins, "github", "herdr-job-board-qa-0123456789ab"), "0.1.0")
    const toml = join(qa, "herdr-plugin.toml")
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^id = "herdr-job-board"/m, 'id = "herdr-job-board-qa"'))
    // Another copy with that id that Herdr doesn't list: still not this board's.
    const qaOld = L.copy(join(L.plugins, "github", "herdr-job-board-ffffffffffff"), "0.1.0")
    writeFileSync(join(qaOld, "herdr-plugin.toml"), readFileSync(toml, "utf8"))
    t.setHerdr((s) => s.plugins.push({ plugin_id: "herdr-job-board-qa", version: "0.1.0", plugin_root: qa, enabled: true, source: { kind: "github", managed_path: qa } }))
    // The board's own 0.9.3 folder, which the hooks still run.
    L.copy(L.old, "0.4.0")
    mkdirSync(join(t.home, ".claude"), { recursive: true })
    writeFileSync(join(t.home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${L.old}/hooks/board-hook.mjs'` }] }] } }))
    const r = spawnSync(process.execPath, [join(root, "board.mjs"), "doctor"], { cwd: t.repo, env: t.env, encoding: "utf8" })
    const at = (d) => d.replace(/[.]/g, "\\.")
    assert.doesNotMatch(r.stdout, /herdr-job-board-qa-0123456789ab|herdr-job-board-ffffffffffff/, "nothing about the sibling plugin's folders")
    assert.match(r.stdout, new RegExp(`^fix {3}${at(L.old)}: an old install of the board \\(0\\.4\\.0\\) that the hooks in .*/home/\\.claude/settings\\.json still run\\n {6}node '${at(root)}/board\\.mjs' hooks \\(put them in .*settings\\.json\\) first, then: rm -rf '${at(L.old)}'$`, "m"))
    assert.doesNotMatch(r.stdout, new RegExp(`^ {6}rm -rf '${at(L.old)}'$`, "m"), "never the bare rm while hooks run it")
    assert.ok(existsSync(qa) && existsSync(qaOld) && existsSync(L.old))
  } finally {
    t.done()
  }
})

test("a pane whose own <n> folder Herdr removed still follows the installed root: it settled at start that it is the board's", { skip: !hasScript && "needs util-linux script" }, async () => {
  for (const flag of ["", " --as-plugin"]) {
    const t = setup()
    const L = layout095(t)
    let live
    try {
      const first = L.copy(L.inst("1-0"))
      L.installAt(first)
      if (!existsSync(t.store)) assert.equal(t.run(["add", "todo", "Something"]).status, 0)
      t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board" }))
      const cmd = `stty cols 100 rows 30; exec node '${first}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '${VERSION}'${flag} --interval 1`
      const child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5", JOB_BOARD_UPDATE_SETTLE_MS: "1500", JOB_BOARD_ROOT_CHECK_MS: "300" }, detached: true })
      live = { out: "", exited: false, kill: () => { try { if (!live.exited) process.kill(-child.pid, "SIGKILL") } catch {} } }
      child.stdout.on("data", (d) => (live.out += d.toString("utf8")))
      child.on("exit", () => (live.exited = true))
      for (let i = 0; i < 100 && !/Something/.test(live.out); i++) await pause(100)
      // The update: 2-0 written at 9.9.9, plugin_root flips to it, and Herdr removes 1-0.
      const second = L.copy(L.inst("2-0"), "9.9.9")
      L.installAt(second, "9.9.9")
      rmSync(join(first, ".."), { recursive: true, force: true })
      assert.ok(!existsSync(first))
      for (let i = 0; i < 100 && !live.exited; i++) await pause(100)
      assert.ok(live.exited, `${flag || "plain"}: the pane on the removed folder handed over: ${words(live).slice(-200)}`)
      assert.match(words(live), /board 9\.9\.9 is installed: this pane restarts with it/, "and said so first")
      let run
      for (let i = 0; i < 50 && !run; i++) {
        await pause(100)
        run = runs(t).find((a) => a[2] === "w9:p5")
      }
      assert.equal(run?.[3], `node '${second}/board-pane.mjs' --board '${t.store}' --origin 'w9:p1' --version '9.9.9' --as-plugin`)
    } finally {
      live?.kill()
      t.done()
    }
  }
})
