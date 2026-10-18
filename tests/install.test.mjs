// Run: node --test (from the repo root)
// Install, update and run: version, hooks, doctor, restart, and a board pane that picks up an
// update of its own folder. Herdr is faked (fixtures/fake-herdr.mjs).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
    child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: t.repo, env: { ...t.env, HERDR_PANE_ID: "w9:p5" }, detached: true })
    let out = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    await pause(1500)
    assert.match(out, /Something/)
    t.setVersion("9.9.9")
    // Two refreshes see the new version (1 s apart), then it hands over and quits.
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
