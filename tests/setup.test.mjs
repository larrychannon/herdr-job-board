// Run: node --test (from the repo root)
// `setup` (the key binding and the sidebar count in Herdr's config.toml, on scratch config files
// only), `contract`, `guide`, `ls --done`, and the phase 3 review's points. Herdr is faked: its
// `--default-config` is an excerpt of Herdr 0.9.5's (fixtures/herdr-default-config.toml).
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { COMMAND_FLAGS, stateDir, VERSION } from "../board.mjs"
import { snapshot, waitingTouched } from "../hooks/board-hook.mjs"

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(SCRIPTS, "board.mjs")
const FAKE_HERDR = join(SCRIPTS, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)

/** A scratch HOME with a config.toml (or none), the fake Herdr, and `setup` runs against them. */
function scratch(config = null) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-setup-")))
  const dir = join(base, ".config", "herdr")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "config.toml")
  if (config !== null) writeFileSync(file, config)
  const herdr = join(base, "herdr.json")
  writeFileSync(herdr, JSON.stringify({ log: [] }))
  const env = { ...process.env, HOME: base, JOB_BOARD_HOME: join(base, "store"), HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, JOB_BOARD_NOW: "2026-10-19T12:00:00Z", TZ: "UTC" }
  const run = (args, extra = {}) => spawnSync(process.execPath, [BOARD, "setup", ...args], { cwd: base, env: { ...env, ...extra }, encoding: "utf8" })
  const calls = () => JSON.parse(readFileSync(herdr, "utf8")).log.map((a) => a.join(" "))
  const text = () => readFileSync(file, "utf8")
  const backups = () => readdirSync(dir).filter((f) => f.startsWith("config.toml.bak-"))
  return { base, dir, file, herdr, env, run, calls, text, backups, done: () => rmSync(base, { recursive: true, force: true }) }
}

test("setup: the default key is prefix+shift+b; prefix+b, Herdr's own toggle_sidebar, stops it with a free key; nothing is written", () => {
  const t = scratch("")
  try {
    assert.match(t.run(["--dry-run"]).stdout, /^key: would add prefix\+shift\+b → herdr-job-board\.open$/m, "the default")
    const r = t.run(["--key", "prefix+b"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^key: prefix\+b is taken \(Herdr's default toggle_sidebar\); nothing was changed\. Pick another: board\.mjs setup --key prefix\+shift\+b$/m)
    assert.equal(t.text(), "")
    assert.deepEqual(t.backups(), [])
    assert.ok(!t.calls().includes("server reload-config"))
    // A user who moved toggle_sidebar elsewhere frees prefix+b.
    writeFileSync(t.file, '[keys]\ntoggle_sidebar = "prefix+shift+s"\n')
    assert.equal(t.run(["--key", "prefix+b", "--no-reload"]).status, 0)
    assert.match(t.text(), /key = "prefix\+b"/)
  } finally {
    t.done()
  }
})

test("setup on a missing config: the binding and the sidebar rows written; Herdr checks and reloads it; a second run changes nothing", () => {
  const t = scratch(null)
  try {
    const r = t.run(["--key", "prefix+shift+b"])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^config: .*config\.toml \(not there yet: created\)$/m)
    assert.match(r.stdout, /^key: added prefix\+shift\+b → herdr-job-board\.open$/m)
    assert.match(r.stdout, /^sidebar: added \["\$board"\] to \[ui\.sidebar\.spaces\] rows$/m)
    assert.match(r.stdout, /^check: ok \(herdr config check\)$/m)
    assert.match(r.stdout, /^reload: done \(herdr server reload-config\)$/m)
    assert.equal(
      t.text().trim(),
      [
        "[[keys.command]]",
        'key = "prefix+shift+b"',
        'type = "plugin_action"',
        'command = "herdr-job-board.open"',
        'description = "open the job board"',
        "",
        "[ui.sidebar.spaces]",
        "rows = [",
        '  ["state_icon", "workspace"],',
        '  ["branch", "git_status"],',
        '  ["$board"],',
        "]",
      ].join("\n"),
    )
    assert.deepEqual(t.calls().filter((c) => !c.startsWith("--")), ["config check", "server reload-config"])
    // Again: ok for both, nothing written, no backup, no reload.
    const before = t.text()
    const again = t.run(["--key", "prefix+shift+b"])
    assert.equal(again.status, 0)
    assert.match(again.stdout, /^key: ok \(prefix\+shift\+b opens the board\)$/m)
    assert.match(again.stdout, /^sidebar: ok \("\$board" is in the space rows\)$/m)
    assert.match(again.stdout, /^nothing to change$/m)
    assert.equal(t.text(), before)
    assert.deepEqual(t.backups(), [])
    assert.equal(t.calls().filter((c) => c === "server reload-config").length, 1)
  } finally {
    t.done()
  }
})

test("setup keeps a config's other content: a [ui] table, rows over several lines or on one, a table without rows; and backs it up first", () => {
  const cases = [
    ['[ui]\nsidebar_width = 30\n', /\[ui\]\nsidebar_width = 30\n[\s\S]*\[ui\.sidebar\.spaces\]\nrows = \[\n {2}\["state_icon", "workspace"\],\n {2}\["branch", "git_status"\],\n {2}\["\$board"\],\n\]/],
    ['[ui.sidebar.spaces]\nrow_gap = 1\nrows = [\n  ["state_icon", "workspace"],\n  ["branch"]  # mine\n]\n', /rows = \[\n {2}\["state_icon", "workspace"\],\n {2}\["branch"\],  # mine\n {2}\["\$board"\],\n\]\n/],
    ['[ui.sidebar.spaces]\nrows = [["workspace"], ["branch", "git_status"]]  # short\n', /^rows = \[\["workspace"\], \["branch", "git_status"\], \["\$board"\]\]  # short$/m],
    ['[ui.sidebar.spaces]\nrow_gap = 1\n', /\[ui\.sidebar\.spaces\]\nrows = \[\n {2}\["state_icon", "workspace"\],\n {2}\["branch", "git_status"\],\n {2}\["\$board"\],\n\]\nrow_gap = 1/],
  ]
  for (const [config, want] of cases) {
    const t = scratch(config)
    try {
      const r = t.run(["--no-key", "--no-reload"])
      assert.equal(r.status, 0, r.stdout)
      assert.match(t.text(), want, config)
      assert.deepEqual(t.backups(), ["config.toml.bak-20261019-120000"])
      assert.equal(readFileSync(join(t.dir, t.backups()[0]), "utf8"), config)
      assert.match(r.stdout, /^reload: skipped \(--no-reload\); run herdr server reload-config$/m)
    } finally {
      t.done()
    }
  }
})

test("setup: a binding there already is kept; a key the user bound is taken; a shape it doesn't edit gets the lines to paste; --dry-run writes nothing", () => {
  // The board bound already (another key): ok.
  let t = scratch('[[keys.command]]\nkey = "prefix+alt+j"\ntype = "plugin_action"\ncommand = "herdr-job-board.open"\n\n[ui.sidebar.spaces]\nrows = [["$board"]]\n')
  try {
    const r = t.run([])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^key: ok \(prefix\+alt\+j opens the board\)$/m)
    assert.match(r.stdout, /^nothing to change$/m)
  } finally {
    t.done()
  }
  // The key asked for is the user's own command's.
  t = scratch('[[keys.command]]\nkey = "prefix+shift+b"\ntype = "popup"\ncommand = "lazygit"\n')
  try {
    const r = t.run(["--key", "prefix+shift+b"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /prefix\+shift\+b is taken \(your config's command lazygit\); nothing was changed\. Pick another: board\.mjs setup --key prefix\+alt\+b/)
    // A digit inside a default range (switch_tab = prefix+1..9) is taken too.
    assert.match(t.run(["--key", "prefix+3"]).stdout, /prefix\+3 is taken \(Herdr's default switch_tab\)/)
  } finally {
    t.done()
  }
  // The sidebar set as a dotted key: not edited; the lines to paste.
  t = scratch('[ui]\nsidebar.spaces.rows = [["workspace"]]\n')
  try {
    const r = t.run(["--no-key", "--no-reload"])
    assert.match(r.stdout, /sidebar: this config sets the sidebar's space rows in a way setup doesn't edit; add "\$board" to them yourself/)
    assert.equal(t.text(), '[ui]\nsidebar.spaces.rows = [["workspace"]]\n')
  } finally {
    t.done()
  }
  // --dry-run: what would change, nothing written, no Herdr call but its defaults.
  t = scratch("[ui]\n")
  try {
    const r = t.run(["--dry-run", "--key", "prefix+shift+b"])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^key: would add prefix\+shift\+b → herdr-job-board\.open$/m)
    assert.match(r.stdout, /^dry run: nothing written; the file would end like this:$/m)
    assert.match(r.stdout, /^ {2}\| {3}\["\$board"\],$/m)
    assert.equal(t.text(), "[ui]\n")
    assert.deepEqual(t.backups(), [])
    assert.deepEqual(t.calls().filter((c) => !c.startsWith("--")), [])
  } finally {
    t.done()
  }
})

test("setup: a config Herdr's check refuses is put back as it was; HERDR_CONFIG_PATH is where it writes; the real home's config only from the installed 0.5 copy", () => {
  let t = scratch("[ui]\nsidebar_width = 30\n# !invalid!\n")
  try {
    const r = t.run(["--key", "prefix+shift+b"])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^check: herdr config check failed, so the config is back as it was: /m)
    assert.equal(t.text(), "[ui]\nsidebar_width = 30\n# !invalid!\n")
    assert.ok(!t.calls().includes("server reload-config"))
  } finally {
    t.done()
  }
  t = scratch(null)
  try {
    const elsewhere = join(t.base, "other", "herdr.toml")
    const r = t.run(["--key", "prefix+shift+b", "--no-reload"], { HERDR_CONFIG_PATH: elsewhere })
    assert.equal(r.status, 0, r.stdout)
    assert.match(readFileSync(elsewhere, "utf8"), /herdr-job-board\.open/)
    assert.ok(!existsSync(t.file))
    // The real home (JOB_BOARD_PROTECT stands in for it): this checkout writes no config there.
    const g = t.run(["--key", "prefix+shift+b", "--no-reload"], { JOB_BOARD_PROTECT: t.base })
    assert.equal(g.status, 1)
    assert.match(g.stderr, /isn't the installed plugin: it writes no board under/)
    assert.ok(!existsSync(t.file))
  } finally {
    t.done()
  }
})

test("contract and guide: the commands and flags this copy takes (the same table it checks), the agent instructions", () => {
  const env = { ...process.env, HOME: realpathSync(tmpdir()) }
  const c = JSON.parse(spawnSync(process.execPath, [BOARD, "contract"], { env, encoding: "utf8" }).stdout)
  assert.equal(c.version, VERSION)
  assert.equal(c.contract, 2)
  assert.equal(c.store, "global")
  assert.deepEqual(c.hooks, ["SessionStart", "UserPromptSubmit", "Stop", "Notification"])
  // 0.10.0: the inbox socket's texts and delivery modes.
  assert.match(c.socket_text.answer, /^\[board answer\] card <id> /)
  assert.deepEqual(c.delivery.modes, ["auto", "socket", "channel", "prompt"])
  assert.equal(c.delivery.current, "auto")
  assert.deepEqual(c.flags, COMMAND_FLAGS)
  for (const command of ["add", "answer", "setup", "guide", "import", "export", "projects", "retag", "adopt", "front"]) assert.ok(c.commands.includes(command), command)
  assert.ok(c.flags["job-start"].includes("worktree"))
  // A flag a command doesn't list is refused: the table is what main checks.
  const r = spawnSync(process.execPath, [BOARD, "answer", "1", "x", "--worktree", "/"], { env, encoding: "utf8" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /answer does not take --worktree/)
  const g = spawnSync(process.execPath, [BOARD, "guide"], { env, encoding: "utf8" }).stdout
  for (const part of [/^How to use the job board \(herdr-job-board \d+\.\d+\.\d+\), for agents$/m, /--project P or --project all/, /Board card <id> \(<tag> · <title>\):/, /answer 170 "go" --from telegram/, /job-start <slug> --worktree/, /import --dry-run/]) {
    assert.match(g, part)
  }
  assert.match(readFileSync(join(SCRIPTS, "README.md"), "utf8"), /board\.mjs guide/, "the README points agents to guide")
})

test("ls --done 30d: Done cards of the last 30 days, the archive's too, each with its date", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-done-")))
  try {
    spawnSync("git", ["-C", base, "init", "-q"])
    const env = (now) => ({ ...process.env, HOME: base, JOB_BOARD_HOME: join(base, "store"), JOB_BOARD_NOW: now, TZ: "UTC", NO_COLOR: "1" })
    const board = (now, ...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env: env(now), encoding: "utf8" })
    board("2026-09-01T10:00:00Z", "add", "done", "Long ago")
    board("2026-10-01T10:00:00Z", "add", "done", "Archived since")
    board("2026-10-19T09:00:00Z", "add", "done", "Today")
    assert.match(readFileSync(join(base, "store", "archive", "2026-10.jsonl"), "utf8"), /Archived since/)
    const r = board("2026-10-19T12:00:00Z", "ls", "--width", "80", "--done", "30d")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Archived since +1 Oct 10:00$/m)
    assert.match(r.stdout, /Today +09:00$/m)
    assert.doesNotMatch(r.stdout, /Long ago/)
    assert.doesNotMatch(board("2026-10-19T12:00:00Z", "ls", "--width", "80").stdout, /Archived since/, "plain ls: today's only")
    assert.match(board("2026-10-19T12:00:00Z", "ls", "--width", "80", "--done", "60").stdout, /Long ago/)
    assert.equal(board("2026-10-19T12:00:00Z", "ls", "--done", "soon").status, 2)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("restart.log: beside a board of its own (JOB_BOARD_HOME), so a scratch store keeps a scratch log", () => {
  assert.equal(stateDir({ HOME: "/home/u", JOB_BOARD_HOME: "/tmp/qa/store", HERDR_PLUGIN_STATE_DIR: "/p" }), "/tmp/qa/store")
  assert.equal(stateDir({ HOME: "/home/u", HERDR_PLUGIN_STATE_DIR: "/p" }), "/p")
  assert.equal(stateDir({ HOME: "/home/u", XDG_STATE_HOME: "/st" }), "/st/herdr-job-board")
})

test("Stop: the pane's own sent note (a button press) is not the coordinator updating a card", () => {
  const card = { id: 1, project: "a", column: "waiting", title: "Go?", updated: "x" }
  const turn = snapshot({ items: [card] })
  assert.equal(waitingTouched({ items: [{ ...card, sent: { label: "Go", at: "y" }, by: "w9:p5" }] }, turn), false)
  assert.equal(waitingTouched({ items: [{ ...card, ask: "now?" }] }, turn), true)
})

test("setup's edges: a symlinked config is edited where it points; a header inside a multi-line string is text; an older Herdr without config check", () => {
  // A dotfiles link: the managed file changes, the link stays.
  let t = scratch(null)
  try {
    const managed = join(t.base, "dotfiles", "herdr.toml")
    mkdirSync(join(t.base, "dotfiles"))
    writeFileSync(managed, "[ui]\n")
    symlinkSync(managed, t.file)
    const r = t.run(["--no-reload"])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /^config: .*config\.toml \(a link to .*dotfiles\/herdr\.toml: edited there\)$/m)
    assert.ok(lstatSync(t.file).isSymbolicLink(), "still a link")
    assert.match(readFileSync(managed, "utf8"), /herdr-job-board\.open/)
    assert.deepEqual(readdirSync(join(t.base, "dotfiles")).filter((f) => f.includes(".bak-")).length, 1, "the backup beside the real file")
  } finally {
    t.done()
  }
  // "[ui.sidebar.spaces]" inside a multi-line string is not the table.
  t = scratch('[theme]\nnote = """\n[ui.sidebar.spaces]\nrows = [["x"]]\n"""\n')
  try {
    assert.equal(t.run(["--no-key", "--no-reload"]).status, 0)
    assert.match(t.text(), /\nnote = """\n\[ui\.sidebar\.spaces\]\nrows = \[\["x"\]\]\n"""\n/, "the string as it was")
    assert.match(t.text(), /\n\[ui\.sidebar\.spaces\]\nrows = \[\n {2}\["state_icon", "workspace"\],/, "a real table after it")
  } finally {
    t.done()
  }
  // An older Herdr whose CLI has no `config check`: skipped, the file kept.
  t = scratch("[ui]\n")
  try {
    writeFileSync(t.herdr, JSON.stringify({ log: [], no_config_check: true }))
    const r = t.run(["--no-reload"])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /^check: skipped \(this Herdr has no `config check`; Herdr 0\.9\.5 has\)$/m)
    assert.match(t.text(), /herdr-job-board\.open/)
  } finally {
    t.done()
  }
})
