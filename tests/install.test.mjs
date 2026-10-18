// Run: node --test (from the repo root)
// Install, update and run: version, hooks, doctor, restart, and a board pane that picks up an
// update of its own folder. Herdr is faked (fixtures/fake-herdr.mjs).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

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
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: "", HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w9", HERDR_PANE_ID: "w9:p1", NO_COLOR: "1" }
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
  return { base, plugin, repo, home, herdr, env, run, herdrState, setHerdr, setVersion, installed, done: () => rmSync(base, { recursive: true, force: true }) }
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
    assert.match(r.stdout, /^ok {4}this repo's board: .*\/app\/\.git\/job-board\.json \(0 cards, created on the first add\)$/m)
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
    const board = join(t.repo, ".git", "job-board.json")
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
  const board = join(t.repo, ".git", "job-board.json")
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
    assert.match(words(live), /update to 0\.3\.5 failed to start: board\.mjs version failed \(a board before 0\.4\.0 can't restart a pane\)/)
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
    await pause(1500)
    t.setVersion("9.9.9")
    await pause(2500)
    assert.equal(live.exited, false, "2.5 s after the write: still the old pane")
    assert.match(live.out, /board 9\.9\.9 is installed: this pane restarts with it/)
    // Written again (the update goes on): the clock starts again.
    t.setVersion("9.9.9")
    writeFileSync(join(t.plugin, "links.mjs"), readFileSync(join(ROOT, "links.mjs"), "utf8") + "\n")
    await pause(2500)
    assert.equal(live.exited, false, "the folder changed 2.5 s ago: still waiting")
    for (let i = 0; i < 60 && !live.exited; i++) await pause(100)
    assert.ok(live.exited, "then it hands over")
  } finally {
    live?.kill()
    t.done()
  }
})

test("pane-restart failures are logged and shown by the next board started in that pane", { skip: !hasScript && "needs util-linux script" }, async () => {
  const t = setup()
  let live
  try {
    // Something else runs in the pane: nothing is typed into it, and the reason is logged.
    t.setHerdr((s) => s.panes.push({ pane_id: "w9:p5", tab_id: "w9:t1", workspace_id: "w9", label: "board", running: "vim notes.md" }))
    const r = t.run(["pane-restart", "w9:p5", "--board", join(t.repo, ".git", "job-board.json"), "--origin", "w9:p1"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /pane w9:p5: not restarted: something else runs there now/)
    assert.deepEqual(t.herdrState().log.filter((a) => a[1] === "send-text" || a[1] === "run"), [])
    const log = readFileSync(join(t.home, ".local", "state", "herdr-job-board", "restart.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.deepEqual([log.at(-1).pane, log.at(-1).ok], ["w9:p5", false])
    // The board opened there next says so, once.
    t.setHerdr((s) => delete s.panes.find((p) => p.pane_id === "w9:p5").running)
    live = livePane(t)
    await pause(1500)
    assert.match(live.out, /the last restart in this pane failed: not restarted: something else runs there now/)
    live.kill()
    live = livePane(t)
    await pause(1500)
    assert.doesNotMatch(live.out, /the last restart in this pane failed/, "shown once")
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
