// Run: node --test (from the repo root)
// The one board for every project (0.5): where the store is, which project a folder is, tags,
// the ownership check, importing 0.4 boards, export, archive, backups and restore. Every test
// has its own temp HOME and store; Herdr is faked by fixtures/fake-herdr.mjs.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { boardPath, projectAt, projectName, readBoard, storeDir, tagFor, VERSION } from "../board.mjs"

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(SCRIPTS, "board.mjs")
const PANE = join(SCRIPTS, "board-pane.mjs")
const FAKE_HERDR = join(SCRIPTS, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=test", ...args], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

/** A temp HOME with repos in it; the store is that HOME's ~/.local/state/herdr-job-board. */
function home() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-store-")))
  const store = join(base, ".local", "state", "herdr-job-board")
  const file = join(store, "board.json")
  const repo = (name, at = base) => {
    const dir = join(at, name)
    mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    git(dir, "commit", "-q", "--allow-empty", "-m", "init")
    return dir
  }
  const envFor = (extra = {}) => {
    const env = { ...process.env, HOME: base, XDG_STATE_HOME: "", JOB_BOARD_HOME: "", JOB_BOARD_FILE: "", TZ: "UTC", NO_COLOR: "1", JOB_BOARD_NOW: "2026-10-19T10:00:00Z", HERDR_ENV: "0", HERDR_PANE_ID: "", HERDR_WORKSPACE_ID: "", JOB_AGENT_ROLE: "" }
    // No role or plugin variable of the session running the tests (it may be a job's worker).
    for (const key of ["HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT", "HERDR_PLUGIN_STATE_DIR", "HERDR_BIN_PATH", "SFC_AGENT_ROLE", "JOB_BOARD_PROTECT", "JOB_BOARD_DEV"]) delete env[key]
    return { ...env, ...extra }
  }
  const run = (cwd, args, extra) => spawnSync(process.execPath, [BOARD, ...args], { cwd, env: envFor(extra), encoding: "utf8" })
  const ok = (cwd, args, extra) => {
    const r = run(cwd, args, extra)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const state = () => JSON.parse(readFileSync(file, "utf8"))
  const card = (id) => state().items.find((i) => i.id === id)
  // A fake Herdr: a coordinator pane w4:p6 in workspace w4 (labelled sfc-integration), plus `agents`.
  const herdr = (agents = []) => {
    const path = join(base, `herdr-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(path, JSON.stringify({ agents, panes: [{ pane_id: "w4:p6", tab_id: "w4:t1", workspace_id: "w4", cwd: base }] }))
    return path
  }
  const inHerdr = (fake, pane = "w4:p6", workspace = "w4", extra = {}) => ({ HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_PANE_ID: pane, HERDR_WORKSPACE_ID: workspace, ...extra })
  return { base, store, file, repo, envFor, run, ok, state, card, herdr, inHerdr, done: () => rmSync(base, { recursive: true, force: true }) }
}

/** A 0.4 board (version 1) in a repo's .git, as 0.4.0 wrote it. */
function legacy(dir, items, nextId = Math.max(0, ...items.map((i) => i.id)) + 1) {
  const at = "2026-10-18T09:00:00.000Z"
  const full = items.map((i) => ({ title: `card ${i.id}`, desc: "", column: "todo", job: "", ask: "", created: `${at.slice(0, 17)}${String(i.id % 60).padStart(2, "0")}.000Z`, since: at, updated: at, ...i }))
  const file = join(dir, ".git", "job-board.json")
  writeFileSync(file, JSON.stringify({ version: 1, next_id: nextId, items: full, panes: { "w4:t1": "w4:p14" } }, null, 2))
  return file
}

test("store: XDG state folder by default; JOB_BOARD_HOME and JOB_BOARD_FILE override it; HERDR_PLUGIN_STATE_DIR never moves it", () => {
  const env = { HOME: "/home/u" }
  assert.equal(storeDir(env), "/home/u/.local/state/herdr-job-board")
  assert.equal(boardPath("/x", env), "/home/u/.local/state/herdr-job-board/board.json")
  assert.equal(boardPath("/x", { ...env, XDG_STATE_HOME: "/st" }), "/st/herdr-job-board/board.json")
  assert.equal(boardPath("/x", { ...env, XDG_STATE_HOME: "relative" }), "/home/u/.local/state/herdr-job-board/board.json", "a relative XDG_STATE_HOME is ignored, as the spec says")
  assert.equal(boardPath("/x", { ...env, JOB_BOARD_HOME: "/b" }), "/b/board.json")
  assert.equal(boardPath("/x", { ...env, JOB_BOARD_HOME: "/b", JOB_BOARD_FILE: "f.json" }), "/x/f.json")
  assert.equal(boardPath("/x", { ...env, HERDR_PLUGIN_STATE_DIR: "/plugin/state" }), "/home/u/.local/state/herdr-job-board/board.json")

  const h = home()
  try {
    const app = h.repo("app")
    // The CLI, from any folder, with or without the plugin's state dir, finds the same file.
    assert.equal(h.ok(app, ["path"]).trim(), h.file)
    assert.equal(h.ok(h.base, ["path"], { HERDR_PLUGIN_STATE_DIR: join(h.base, "elsewhere") }).trim(), h.file)
    h.ok(app, ["add", "todo", "first"])
    assert.equal((readFileSync(h.file) && spawnSync("stat", ["-c", "%a", h.file], { encoding: "utf8" }).stdout.trim()), "600")
    assert.equal(git(app, "status", "--porcelain"), "", "nothing in the work tree")
    assert.ok(!existsSync(join(app, ".git", "job-board.json")), "no 0.4 board file")
  } finally {
    h.done()
  }
})

test("projects: a repo and its worktrees are one project; a bare repo; ~ is home; another folder is its own; same-name repos get the parent's name", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const wt = join(h.base, "app-wt-x")
    git(app, "worktree", "add", "-q", wt, "-b", "feat/x")
    const env = { HOME: h.base }
    const id = projectAt(app, env)
    assert.deepEqual(id, { git: join(app, ".git"), root: app, name: "app" })
    assert.deepEqual(projectAt(wt, env), id, "a worktree is its repo")
    assert.deepEqual(projectAt(join(app, ".git"), env), id, "inside .git too")
    const bare = join(h.base, "srv", "tool.git")
    mkdirSync(bare, { recursive: true })
    git(bare, "init", "-q", "--bare")
    assert.deepEqual(projectAt(bare, env), { git: bare, root: bare, name: "tool" })
    const notes = join(h.base, "notes")
    mkdirSync(notes)
    assert.deepEqual(projectAt(notes, env), { git: "", root: h.base, name: "home" }, "under HOME and not a repo: home")
    assert.deepEqual(projectAt(h.base, env), { git: "", root: h.base, name: "home" })
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "board-outside-")))
    try {
      assert.deepEqual(projectAt(outside, env), { git: "", root: outside, name: outside.split("/").pop() })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }

    // Two repos called "app": the first keeps the name, the second gets its parent's.
    const other = h.repo("app", join(h.base, "clients"))
    h.ok(app, ["add", "todo", "in app"])
    h.ok(wt, ["add", "todo", "in app's worktree"])
    h.ok(other, ["add", "todo", "in the other app"])
    h.ok(notes, ["add", "todo", "in home"])
    const s = h.state()
    assert.deepEqual(s.items.map((i) => [i.id, i.project]), [[1, "app"], [2, "app"], [3, "clients-app"], [4, "home"]])
    assert.equal(projectName(s.projects, projectAt(other, env)), "clients-app", "the name sticks")
    assert.deepEqual(Object.fromEntries(Object.entries(s.projects).map(([n, p]) => [n, [p.tag, p.color]])), {
      app: ["app", "magenta"],
      "clients-app": ["clients", "cyan"],
      home: ["home", "blue"],
    })
  } finally {
    h.done()
  }
})

test("tags: the name's first part, at most 7 characters; a clash adds the next parts' initials, then a number", () => {
  const p = (...tags) => Object.fromEntries(tags.map((t, i) => [`p${i}`, { tag: t }]))
  assert.equal(tagFor("sfc-integration", {}), "sfc")
  assert.equal(tagFor("herdr-job-board", {}), "herdr")
  assert.equal(tagFor("ai-config", {}), "ai")
  assert.equal(tagFor("release-notes-manager", {}), "release")
  assert.equal(tagFor("Upgrade-Firmware-Twice", {}), "upgrade")
  assert.equal(tagFor("sfc-app-track", p("sfc")), "sfc-a")
  assert.equal(tagFor("sfc-app-test", p("sfc", "sfc-a")), "sfc-at")
  assert.equal(tagFor("release-notes-x", p("release")), "relea-n")
  assert.equal(tagFor("sfc", p("sfc")), "sfc2")
  for (const name of ["a", "x".repeat(40), "日本語", "--", "my app"]) assert.match(tagFor(name, p("x", "xxxxxxx")), /^[a-z0-9][a-z0-9-]{0,6}$/, name)
})

test("store: 4 writers × 200 adds, from two projects: no card lost, ids unique and whole, the lock and temp files gone", async () => {
  const h = home()
  try {
    const dirs = [h.repo("one"), h.repo("two")]
    const writers = 4
    const each = 200
    const script = (w) => `
      const { updateBoard } = await import(${JSON.stringify(new URL("../board.mjs", import.meta.url).href)})
      for (let i = 1; i <= ${each}; i++) updateBoard(${JSON.stringify(h.file)}, (s) => { s.items.push({ id: s.next_id++, project: "${w % 2 ? "two" : "one"}", title: "writer ${w} card " + i, column: "todo", since: new Date().toISOString() }) })`
    // A first write through the CLI makes the store; then 4 processes write at once.
    h.ok(dirs[0], ["add", "todo", "first"])
    const runs = Array.from({ length: writers }, (_, w) => new Promise((done) => spawn(process.execPath, ["--input-type=module", "-e", script(w)], { cwd: dirs[w % 2], env: h.envFor() }).on("exit", done)))
    assert.deepEqual(await Promise.all(runs), Array(writers).fill(0))
    const all = h.state().items
    assert.equal(all.length, writers * each + 1)
    assert.deepEqual(all.map((i) => i.id).sort((a, b) => a - b), Array.from({ length: writers * each + 1 }, (_, i) => i + 1))
    assert.equal(new Set(all.map((i) => i.title)).size, writers * each + 1)
    assert.deepEqual(readdirSync(h.store).filter((f) => f.startsWith("board.json.")), [], "no lock or temp file left")
    // And through the CLI as well (two writers × 20, one per project).
    const cli = dirs.map((dir, w) => new Promise((done) => spawn("bash", ["-c", `for i in $(seq 1 20); do node '${BOARD}' add todo "cli ${w} $i" >/dev/null || exit 1; done`], { cwd: dir, env: h.envFor() }).on("exit", done)))
    assert.deepEqual(await Promise.all(cli), [0, 0])
    const after = h.state().items
    assert.equal(after.length, writers * each + 41)
    assert.equal(new Set(after.map((i) => i.id)).size, after.length)
    assert.equal(after.filter((i) => i.title.startsWith("cli 1 ")).every((i) => i.project === "two"), true)
  } finally {
    h.done()
  }
})

test("ownership: another project's card needs --project; its owner pane may change it; a gone owner's card is taken over", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    const fake = h.herdr([{ name: "coord", pane_id: "w4:p6", workspace_id: "w4", agent_status: "idle" }])
    // The sfc coordinator (pane w4:p6) adds a card for ai-config: it owns it.
    assert.match(h.ok(sfc, ["add", "todo", "Guard v5", "--project", "ai-config"], h.inHerdr(fake)), /^added 1 /)
    assert.deepEqual([h.card(1).project, h.card(1).origin, h.card(1).workspace], ["ai-config", "w4:p6", "w4"])
    assert.deepEqual(h.state().coordinators["w4:p6"].project, "sfc-integration")
    h.ok(sfc, ["add", "todo", "sfc card"], h.inHerdr(fake))

    // In ai-config, outside Herdr: card 2 is sfc's. Refused with the hint, exit 2, unchanged.
    for (const args of [["done", "2"], ["move", "2", "doing"], ["edit", "2", "--title", "x"], ["rm", "2"], ["retag", "2", "ai-config"]]) {
      const r = h.run(ai, args)
      assert.equal(r.status, 2, args.join(" "))
      assert.equal(r.stderr.trim(), "board: card 2 belongs to sfc-integration (owner w4:p6); add --project sfc-integration to change it")
    }
    assert.equal(h.card(2).column, "todo")
    // With --project naming the card's project it goes through; a wrong one is refused.
    assert.match(h.run(ai, ["done", "2", "--project", "ai-config"]).stderr, /card 2 belongs to sfc-integration, not ai-config/)
    assert.match(h.ok(ai, ["done", "2", "--project", "sfc"]), /^2 → done/, "the tag works too")
    // ai-config's own card 1: fine from ai-config, and from its owner pane anywhere.
    h.ok(ai, ["move", "1", "doing"])
    h.ok(h.base, ["edit", "1", "--desc", "owner"], h.inHerdr(fake))
    assert.equal(h.card(1).desc, "owner")
    // A job slug means this project's card first.
    h.ok(ai, ["edit", "1", "--job", "guard"])
    h.ok(sfc, ["add", "todo", "sfc guard", "--job", "guard"])
    assert.match(h.ok(sfc, ["move", "guard", "doing"]), /^3 → doing/)
    assert.match(h.ok(ai, ["move", "guard", "waiting"]), /^1 → waiting/)
    const home = h.run(h.base, ["move", "guard", "todo"])
    assert.equal(home.status, 1)
    assert.match(home.stderr, /job "guard" is open in several projects \(1 in ai-config, 3 in sfc-integration\); use the card's id/)

    // The owner pane is gone: another coordinator that changes the card takes it over, and says so.
    const gone = h.herdr([{ name: "other", pane_id: "w8:p2", workspace_id: "w8", agent_status: "idle" }])
    const r = h.run(ai, ["move", "1", "todo"], h.inHerdr(gone, "w8:p2", "w8"))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /card 1's coordinator \(w4:p6\) is gone: this pane \(w8:p2\) owns it now/)
    assert.equal(h.card(1).origin, "w8:p2")
    // A live owner keeps it; a worker never takes over.
    h.ok(ai, ["edit", "1", "--desc", "x"], h.inHerdr(h.herdr([{ pane_id: "w8:p2" }]), "w9:p1", "w9"))
    assert.equal(h.card(1).origin, "w8:p2")
    h.ok(ai, ["edit", "1", "--desc", "y"], h.inHerdr(h.herdr([]), "w9:p3", "w9", { JOB_AGENT_ROLE: "worker" }))
    assert.equal(h.card(1).origin, "w8:p2")
  } finally {
    h.done()
  }
})

test("projects, project set, retag, adopt and front", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    const fake = h.herdr([{ name: "coord", pane_id: "w4:p6", workspace_id: "w4" }])
    h.ok(sfc, ["add", "waiting", "Approve", "--ask", "say go"], h.inHerdr(fake))
    h.ok(sfc, ["add", "todo", "About ai-config"], h.inHerdr(fake))
    h.ok(ai, ["add", "todo", "Unowned"])
    let lines = h.ok(h.base, ["projects"], h.inHerdr(fake)).split("\n")
    assert.match(lines[0], /^ai-config +ai +cyan +1 to do  .*\/ai-config$/)
    assert.match(lines[1], /^sfc-integration +sfc +magenta +1 need you · 1 to do  .*\/sfc-integration  coordinator w4:p6 live$/)

    // retag moves a card to another project (a repo under HOME is found by its name).
    assert.match(h.ok(sfc, ["retag", "2", "ai-config"]), /^2 → project ai-config: About ai-config/)
    assert.equal(h.card(2).project, "ai-config")
    assert.equal(h.run(sfc, ["retag", "1", "nope"]).status, 2)
    h.ok(sfc, ["retag", "1", "home"])
    assert.equal(h.card(1).project, "home")
    h.ok(h.base, ["retag", "1", "sfc-integration"])

    // project set: tag, colour, name; checked.
    h.ok(h.base, ["project", "set", "ai", "--tag", "aic", "--color", "green"])
    assert.deepEqual([h.state().projects["ai-config"].tag, h.state().projects["ai-config"].color], ["aic", "green"])
    assert.equal(h.run(h.base, ["project", "set", "ai-config", "--tag", "sfc"]).status, 2, "taken")
    assert.equal(h.run(h.base, ["project", "set", "ai-config", "--tag", "much-too-long"]).status, 2)
    assert.equal(h.run(h.base, ["project", "set", "ai-config", "--color", "red"]).status, 2, "red means urgency")
    h.ok(h.base, ["project", "set", "ai-config", "--name", "config"])
    assert.deepEqual(h.state().items.map((i) => i.project), ["sfc-integration", "config", "config"])
    assert.ok(!h.state().projects["ai-config"])

    // adopt: by id, or every open card of a project whose owner is gone.
    assert.equal(h.run(h.base, ["adopt", "3"]).status, 2, "only a coordinator pane adopts")
    const other = h.herdr([{ name: "c2", pane_id: "w8:p2", workspace_id: "w8" }])
    assert.match(h.ok(h.base, ["adopt", "3"], h.inHerdr(other, "w8:p2", "w8")), /^3 now owned by w8:p2/)
    assert.match(h.ok(h.base, ["adopt", "--project", "sfc", "--gone"], h.inHerdr(other, "w8:p2", "w8")), /^1 now owned by w8:p2: Approve$/m)
    assert.equal(h.card(1).origin, "w8:p2")
    assert.equal(h.ok(h.base, ["adopt", "--project", "sfc", "--gone"], h.inHerdr(other, "w8:p2", "w8")).trim(), "nothing to adopt")

    // front: the calling coordinator pane.
    assert.match(h.ok(h.base, ["front", "show"]), /no front coordinator: none set, and no pane has opened the board/)
    h.ok(sfc, ["front"], h.inHerdr(fake))
    assert.equal(h.state().front, "w4:p6")
    assert.equal(h.run(sfc, ["front"]).status, 2, "outside Herdr")
    lines = h.ok(h.base, ["projects"], h.inHerdr(fake))
    assert.match(lines, /coordinator w4:p6 front live/)
  } finally {
    h.done()
  }
})

test("import: dry run first (nothing written), then ids kept, a clash renumbered with its map, stale cards left out, re-tags, files renamed and backed up", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    const herdrRepo = h.repo("herdr-job-board")
    const sfcFile = legacy(sfc, [
      { id: 1, title: "Old done", column: "done", since: "2026-10-18T09:00:00.000Z" },
      { id: 7, title: "3CX certificate: renew", column: "todo" },
      { id: 9, title: "Job board 0.5.0, one board for all projects: plan", column: "doing", job: "board-v5-plan" },
      { id: 12, title: "Waiting with a gone report", column: "waiting", report: "/tmp/no-such-dir-xyz/r.json", since: "2026-10-18T09:00:00.000Z" },
    ], 14)
    const aiFile = legacy(ai, [{ id: 1, title: "fix-x", job: "fix-x", column: "waiting", report: "/tmp/job-scripts-gone-xyz/r.json", since: "2026-10-13T09:00:00.000Z" }, { id: 7, title: "Keep me", column: "todo" }])
    const before = [readFileSync(sfcFile, "utf8"), readFileSync(aiFile, "utf8")]

    // The dry run prints what happens and writes nothing (no store, both files as they were).
    const dry = h.ok(sfc, ["import", "--dry-run"])
    assert.ok(!existsSync(h.store), "no store")
    assert.deepEqual([readFileSync(sfcFile, "utf8"), readFileSync(aiFile, "utf8")], before)
    assert.match(dry, /^import: 2 boards, 6 cards → .*board\.json \(dry run: nothing is written\)$/m)
    assert.match(dry, /sfc-integration\/\.git\/job-board\.json {2}→ {2}sfc-integration \(sfc\): 4 cards, ids kept \(1–12\)$/m)
    assert.match(dry, /ai-config\/\.git\/job-board\.json {2}→ {2}ai-config \(ai\): 1 card, 0 ids kept, 1 renumbered, 1 left out$/m)
    assert.match(dry, /ai-config#1 fix-x {2}waiting since 13 Oct, report gone \(\/tmp\/job-scripts-gone-xyz\/r\.json\): left out\n +\(--keep-stale imports it as 15\)/)
    assert.match(dry, /^renumbered \(the id was taken\): ai-config#7 → 14$/m)
    assert.match(dry, /^re-tag \(suggested from titles and running jobs; apply with --retag 9=herdr-job-board\):$/m)
    assert.match(dry, /^then: {2}board\.json 5 cards \(4 open\), next_id 15; old files renamed job-board\.migrated\.json; backups in .*\/backups\/import-\d{8}-\d{6}$/m)

    // The real thing, with the re-tags (a repo under HOME and home).
    const out = h.ok(sfc, ["import", "--retag", "9=herdr-job-board,7=home"])
    assert.match(out, /^re-tagged: 9→herdr-job-board 7→home$/m)
    assert.match(out, /^done: /m)
    const s = h.state()
    assert.equal(s.version, 2)
    assert.deepEqual(s.items.map((i) => [i.id, i.project, i.title, i.was ?? ""]), [
      [1, "sfc-integration", "Old done", ""],
      [7, "home", "3CX certificate: renew", ""],
      [9, "herdr-job-board", "Job board 0.5.0, one board for all projects: plan", ""],
      [12, "sfc-integration", "Waiting with a gone report", ""],
      [14, "ai-config", "Keep me", "ai-config#7"],
    ])
    assert.equal(s.next_id, 15)
    assert.deepEqual(s.imports.map((i) => [i.project, i.cards, i.renumbered, i.left_out]), [
      ["sfc-integration", 4, {}, []],
      ["ai-config", 1, { 7: 14 }, [1]],
    ])
    assert.deepEqual(s.panes, { "w4:t1": "w4:p14" })
    assert.equal(s.projects["herdr-job-board"].root, herdrRepo)
    // Renamed beside themselves (a rollback is one mv), and copied to backups first.
    for (const dir of [sfc, ai]) {
      assert.ok(!existsSync(join(dir, ".git", "job-board.json")))
      assert.ok(existsSync(join(dir, ".git", "job-board.migrated.json")))
    }
    const [backup] = readdirSync(join(h.store, "backups"))
    assert.match(backup, /^import-\d{8}-\d{6}$/)
    assert.deepEqual(readdirSync(join(h.store, "backups", backup)).sort(), ["ai-config.json", "sfc-integration.json"])
    assert.equal(readFileSync(join(h.store, "backups", backup, "sfc-integration.json"), "utf8"), before[0])
    // Nothing more to bring in: import reviews the last import instead.
    assert.match(h.ok(sfc, ["import"]), /^import: nothing left to bring in; imported on /)

    // A 0.4 copy wrote the old file again: import merges by id and created time (newer wins),
    // and a card it added meanwhile is renumbered.
    const again = legacy(sfc, [
      { id: 12, title: "Waiting with a gone report", column: "done", report: "/tmp/no-such-dir-xyz/r.json", since: "2026-10-18T09:00:00.000Z", updated: "2026-10-19T09:30:00.000Z" },
      { id: 13, title: "Written by 0.4 after the import", column: "todo" },
      { id: 14, title: "Another 0.4 card", column: "todo" },
    ], 15)
    const merged = h.ok(sfc, ["import", again])
    assert.match(merged, /4 cards → |3 cards → /)
    assert.match(merged, /sfc-integration \(sfc\): 2 cards, 1 ids kept, 1 renumbered, 1 updated/)
    assert.deepEqual([h.card(12).column, h.card(13).title, h.card(15).title, h.card(15).was], ["done", "Written by 0.4 after the import", "Another 0.4 card", "sfc-integration#14"])
  } finally {
    h.done()
  }
})

test("import --keep-stale keeps a stale card (renumbered when its id is taken); --retag is checked before anything is written", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    legacy(sfc, [{ id: 1, title: "sfc one" }])
    const aiFile = legacy(ai, [{ id: 1, title: "fix-x", column: "waiting", report: "/tmp/job-scripts-gone-xyz/r.json", since: "2026-10-13T09:00:00.000Z" }])
    const bad = h.run(sfc, ["import", "--retag", "1=nowhere"])
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /--retag: no project "nowhere"/)
    assert.ok(!existsSync(h.file) && existsSync(aiFile), "nothing written, nothing renamed")
    assert.equal(h.run(sfc, ["import", "--retag", "1-home"]).status, 2)
    h.ok(sfc, ["import", "--keep-stale"])
    assert.deepEqual(h.state().items.map((i) => [i.id, i.project, i.was ?? ""]), [
      [1, "sfc-integration", ""],
      [2, "ai-config", "ai-config#1"],
    ])
  } finally {
    h.done()
  }
})

test("migration, per repo: a read says the repo's 0.4 board isn't in; the first write brings it in, ids kept; then the pane of the old file reads the store", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const file = legacy(app, [{ id: 3, title: "Carried over", column: "waiting", ask: "say go" }], 5)
    // A read changes nothing and says what to run.
    const r = h.run(app, ["ls", "--width", "80"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /^board: this repo's 0\.4 board isn't on the one board yet \(.*app\/\.git\/job-board\.json\), so its cards are missing here\. Bring it in: node '.*board\.mjs' import --dry-run, then node '.*board\.mjs' import$/m)
    assert.ok(existsSync(file) && !existsSync(h.file), "nothing written")
    // A write brings it in first.
    const w = h.run(app, ["add", "todo", "next"])
    assert.equal(w.status, 0, w.stderr)
    assert.match(w.stderr, /^board: the 0\.4 board on this machine \(.*app\/\.git\/job-board\.json\) wasn't on the one board yet: brought in first/m)
    assert.match(w.stderr, /^board: {3}.*app\/\.git\/job-board\.json {2}→ {2}app \(app\): 1 card, id kept \(3\)$/m)
    assert.match(w.stdout, /^added 5 /, "ids go on from the old board's")
    assert.ok(!existsSync(file) && existsSync(join(app, ".git", "job-board.migrated.json")))
    assert.deepEqual(h.state().items.map((i) => [i.id, i.title]), [[3, "Carried over"], [5, "next"]])
    // The note stays (ls, the hook, the pane) until the coordinator runs import.
    assert.match(h.run(app, ["ls"]).stderr, /^board: 0\.4 boards were brought in by themselves \(app: 1 card\)\. Look and re-tag: node .* import --dry-run, then node .* import \[--retag ID=PROJECT,…\]$/m)
    assert.match(h.ok(app, ["import"]), /^done: marked seen$/m)
    assert.doesNotMatch(h.run(app, ["ls"]).stderr, /0\.4/, "seen: no more note")
    // A pane started (by 0.4) on the old file shows the store.
    const pane = spawnSync(process.execPath, [PANE, "--once", "--width", "80", "--height", "20", "--board", file], { cwd: app, env: h.envFor(), encoding: "utf8" })
    assert.equal(pane.status, 0, pane.stderr)
    assert.match(pane.stdout, /^all · 1 needs you/)
    assert.match(pane.stdout, /3 ! Carried over/)
  } finally {
    h.done()
  }
})

test("migration: when another repo writes first, the store starts with every 0.4 board on the machine (biggest first, stale left out), so no repo's ids are taken", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    const tool = h.repo("herdr-job-board")
    legacy(sfc, [{ id: 1, title: "sfc one" }, { id: 2, title: "Review", column: "doing", job: "fix-a", report: join(sfc, "r.json") }], 3)
    legacy(ai, [{ id: 1, title: "fix-x", column: "waiting", report: "/tmp/job-scripts-gone-xyz/r.json", since: "2026-10-13T09:00:00.000Z" }])
    // herdr-job-board's first write: both boards come in first; its card gets the next id.
    assert.match(h.ok(tool, ["add", "todo", "Plan"]), /^added 3 /)
    assert.deepEqual(h.state().items.map((i) => [i.id, i.project]), [[1, "sfc-integration"], [2, "sfc-integration"], [3, "herdr-job-board"]])
    assert.deepEqual(h.state().imports.map((e) => [e.project, e.left_out]), [["sfc-integration", []], ["ai-config", [1]]], "the stale test card is left out")
    // The wait script's job-report finds the 0.4 Doing card: no duplicate.
    writeFileSync(join(sfc, "r.json"), JSON.stringify({ status: "done", summary: "ok" }))
    assert.equal(h.ok(sfc, ["job-report", "fix-a", join(sfc, "r.json"), "--if-final"]).trim(), "2 → done: Review")
    assert.equal(h.state().items.length, 3)
  } finally {
    h.done()
  }
})

test("migration: a write that would renumber an established repo's ids is refused with the import to run; a worker never brings a board in; job-report doesn't duplicate", () => {
  const h = home()
  try {
    const one = h.repo("one")
    const two = h.repo("two")
    h.ok(one, ["add", "todo", "first card"])
    // A 0.4 copy wrote a board in two after the store was made: its id 1 is taken.
    const file = legacy(two, [{ id: 1, title: "two's one", column: "doing", job: "build", report: join(two, "r.json") }])
    writeFileSync(join(two, "r.json"), JSON.stringify({ status: "done", summary: "ok" }))
    const before = readFileSync(h.file, "utf8")
    for (const args of [["add", "todo", "x"], ["job-report", "build", join(two, "r.json")]]) {
      const r = h.run(two, args)
      assert.equal(r.status, 1, args.join(" "))
      assert.match(r.stderr, /this repo's 0\.4 board \(.*two\/\.git\/job-board\.json\) isn't on the one board yet, and bringing it in would renumber 1 card \(two#1 → 2\)\. Nothing was changed\. Look first, then import: node '.*board\.mjs' import --dry-run '.*two\/\.git\/job-board\.json'; node '.*board\.mjs' import '.*two\/\.git\/job-board\.json'/)
    }
    assert.equal(readFileSync(h.file, "utf8"), before, "the store is as it was")
    assert.ok(existsSync(file))
    // A worker's write is refused too, whatever the ids.
    const w = h.run(two, ["add", "todo", "x"], { JOB_AGENT_ROLE: "worker" })
    assert.equal(w.status, 1)
    assert.match(w.stderr, /isn't on the one board yet, and a worker doesn't bring it in; nothing was changed\. The coordinator runs: node .* import --dry-run, then node .* import/)
    // The explicit import renumbers it (the map is printed); then job-report finds the card.
    assert.match(h.ok(two, ["import"]), /renumbered \(the id was taken\): two#1 → 2/)
    assert.equal(h.ok(two, ["job-report", "build", join(two, "r.json")]).trim(), "2 → done: two's one")
    assert.equal(h.state().items.length, 2)
  } finally {
    h.done()
  }
})

test("migration: the coordinator's hook says the repo's 0.4 board isn't in, with or without a store", async () => {
  const { handle } = await import("../hooks/board-hook.mjs")
  const h = home()
  try {
    const app = h.repo("app")
    legacy(app, [{ id: 1, title: "Old", column: "waiting" }])
    const env = { HERDR_ENV: "1", HOME: h.base, JOB_BOARD_HOME: "", XDG_STATE_HOME: "" }
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: app, prompt: "hi" }
    let text = JSON.parse(handle(prompt, env).stdout).hookSpecificOutput.additionalContext
    assert.match(text, /^Job board: this repo's 0\.4 board \(.*app\/\.git\/job-board\.json\) isn't on the one board yet.*Bring it in now: node .* import --dry-run, then node .* import\.$/)
    assert.ok(!existsSync(h.store), "the hook writes nothing")
    // With a store already there (made before this repo had its 0.4 board): the warning comes first.
    rmSync(join(app, ".git", "job-board.json"))
    h.ok(h.repo("other"), ["add", "waiting", "Elsewhere"])
    legacy(app, [{ id: 1, title: "Old", column: "waiting" }])
    text = JSON.parse(handle(prompt, env).stdout).hookSpecificOutput.additionalContext
    // "Elsewhere" is another project's card: only counted (the hooks show this coordinator's own).
    assert.match(text, /^Job board: this repo's 0\.4 board .* isn't on the one board yet.*\nJob board: \+1 waiting in other projects \(not yours; the board shows them\)\.$/s)
    // A board of its own (JOB_BOARD_HOME) never takes the repos' boards, and says nothing about them.
    const own = join(h.base, "own-store")
    assert.match(h.ok(app, ["add", "todo", "trial"], { JOB_BOARD_HOME: own }), /^added 1 /)
    assert.ok(existsSync(join(app, ".git", "job-board.json")), "left alone")
    assert.equal(h.run(app, ["ls"], { JOB_BOARD_HOME: own }).stderr, "")
  } finally {
    h.done()
  }
})

test("migration: two first writes at once in one repo both succeed, and the board comes in once", async () => {
  const h = home()
  try {
    const app = h.repo("app")
    for (let round = 0; round < 4; round++) {
      rmSync(h.store, { recursive: true, force: true })
      rmSync(join(app, ".git", "job-board.migrated.json"), { force: true })
      legacy(app, Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `old ${i + 1}` })))
      const runs = Array.from({ length: 4 }, (_, w) => new Promise((done) => spawn(process.execPath, [BOARD, "add", "todo", `new ${w}`], { cwd: app, env: h.envFor() }).on("exit", done)))
      assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0], `round ${round}`)
      assert.equal(h.state().items.length, 24)
      assert.equal(h.state().imports.length, 1)
    }
  } finally {
    h.done()
  }
})

test("JOB_BOARD_FILE at a 0.4 board: read as v1 (its repo's project), written back as v2", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const file = legacy(app, [{ id: 2, title: "Old" }])
    const env = { JOB_BOARD_FILE: file }
    assert.match(h.ok(app, ["ls", "--width", "60"], env), /2 {3}Old/)
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1, "a read changes nothing")
    h.ok(app, ["add", "todo", "New"], env)
    const s = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(s.version, 2)
    assert.deepEqual(s.items.map((i) => [i.id, i.project]), [[2, "app"], [3, "app"]])
    assert.ok(!existsSync(h.store), "the store isn't touched")
    assert.deepEqual(readBoard(file).projects.app.tag, "app")
  } finally {
    h.done()
  }
})

test("export --legacy writes a project's cards as a 0.4 board; a 0.4 reader takes it back (round trip)", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.ok(sfc, ["add", "waiting", "Approve", "--ask", "go?", "--option", "Go"])
    h.ok(ai, ["add", "todo", "Other project"])
    h.ok(sfc, ["add", "todo", "Second"])
    const out = JSON.parse(h.ok(sfc, ["export", "--legacy"]))
    assert.equal(out.version, 1)
    assert.equal(out.next_id, 4)
    assert.deepEqual(out.items.map((i) => [i.id, i.title]), [[1, "Approve"], [3, "Second"]])
    assert.ok(out.items.every((i) => !("project" in i) && !("origin" in i)))
    assert.deepEqual(out.items[0].options, [{ label: "Go" }])
    assert.equal(JSON.parse(h.ok(sfc, ["export", "--legacy", "--project", "all"])).items.length, 3)
    assert.equal(h.run(sfc, ["export"]).status, 2)
    // Back: the exported file imported into an empty store gives the same cards.
    const copy = h.repo("roundtrip")
    writeFileSync(join(copy, ".git", "job-board.json"), JSON.stringify(out))
    const store2 = join(h.base, "store2")
    h.ok(copy, ["import", join(copy, ".git", "job-board.json")], { JOB_BOARD_HOME: store2 })
    const back = JSON.parse(readFileSync(join(store2, "board.json"), "utf8"))
    assert.deepEqual(back.items.map((i) => [i.id, i.title, i.column, i.ask]), [[1, "Approve", "waiting", "go?"], [3, "Second", "todo", ""]])
  } finally {
    h.done()
  }
})

test("archive: Done cards older than 7 days move to archive/YYYY-MM.jsonl; json --archive reads them; a repeat job-report stays a no-op", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const report = join(app, "r.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "built" }))
    h.ok(app, ["job-start", "build", "--report", report], { JOB_BOARD_NOW: "2026-10-01T10:00:00Z" })
    assert.match(h.ok(app, ["job-report", "build"], { JOB_BOARD_NOW: "2026-10-01T11:00:00Z" }), /^1 → done/)
    h.ok(app, ["add", "todo", "recent"], { JOB_BOARD_NOW: "2026-10-07T10:00:00Z" })
    assert.deepEqual(h.state().items.map((i) => i.id), [1, 2], "6 days: still on the board")
    h.ok(app, ["add", "todo", "a week later"], { JOB_BOARD_NOW: "2026-10-08T12:00:00Z" })
    assert.deepEqual(h.state().items.map((i) => i.id), [2, 3], "7 days: archived")
    const lines = readFileSync(join(h.store, "archive", "2026-10.jsonl"), "utf8").trim().split("\n")
    assert.deepEqual(lines.map((l) => JSON.parse(l).title), ["build"])
    const archived = JSON.parse(h.ok(app, ["json", "--archive", "2026-10"]))
    assert.deepEqual(archived.items.map((i) => [i.id, i.column]), [[1, "done"]])
    assert.equal(h.run(app, ["json", "--archive", "Oct"]).status, 2)
    // The wait script fires again for the same report: no second card.
    const again = h.ok(app, ["job-report", "build", report, "--if-final"], { JOB_BOARD_NOW: "2026-10-09T10:00:00Z" })
    assert.equal(again, "")
    assert.match(h.ok(app, ["job-report", "build", report], { JOB_BOARD_NOW: "2026-10-09T10:00:00Z" }), /^1 unchanged \(archived\)/)
    assert.deepEqual(h.state().items.map((i) => i.id), [2, 3])
    assert.equal(h.state().reports && Object.values(h.state().reports)[0].id, 1)
    // Ids are never reused, even after the archive.
    assert.match(h.ok(app, ["add", "todo", "next"], { JOB_BOARD_NOW: "2026-10-09T10:00:00Z" }), /^added 4 /)
  } finally {
    h.done()
  }
})

test("backups: the first write of a day keeps the board as it was (7 kept); restore puts one back, saving the board before it", () => {
  const h = home()
  try {
    const app = h.repo("app")
    h.ok(app, ["add", "todo", "day 0"], { JOB_BOARD_NOW: "2026-10-01T10:00:00Z" })
    assert.ok(!existsSync(join(h.store, "backups")), "nothing to back up before the first write")
    for (let d = 2; d <= 10; d++) h.ok(app, ["add", "todo", `day ${d}`], { JOB_BOARD_NOW: `2026-10-${String(d).padStart(2, "0")}T10:00:00Z` })
    h.ok(app, ["add", "todo", "again on day 10"], { JOB_BOARD_NOW: "2026-10-10T11:00:00Z" })
    const backups = readdirSync(join(h.store, "backups")).sort()
    assert.deepEqual(backups, ["board-2026-10-04.json", "board-2026-10-05.json", "board-2026-10-06.json", "board-2026-10-07.json", "board-2026-10-08.json", "board-2026-10-09.json", "board-2026-10-10.json"])
    assert.equal(JSON.parse(readFileSync(join(h.store, "backups", "board-2026-10-10.json"), "utf8")).items.length, 9, "as it was before day 10's first write")
    assert.match(h.ok(app, ["restore"]), /^backups \(newest first; board\.mjs restore <file>\):/)
    const r = h.ok(app, ["restore", "board-2026-10-05.json"], { JOB_BOARD_NOW: "2026-10-10T12:00:00Z" })
    assert.match(r, /^restored .*board-2026-10-05\.json \(4 cards\) to .*board\.json; the board before it is in .*board-before-restore-20261010-\d{6}\.json$/m)
    assert.equal(h.state().items.length, 4)
    assert.equal(h.run(app, ["restore", "nope.json"]).status, 1)
  } finally {
    h.done()
  }
})

test("job-start --worktree: the card goes to that worktree's repo, with the writer's workspace and owner", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const tool = h.repo("tool")
    const wt = join(h.base, "tool-wt-a")
    git(tool, "worktree", "add", "-q", wt, "-b", "feat/a")
    const fake = h.herdr([{ name: "coord", pane_id: "w4:p6", workspace_id: "w4" }])
    h.ok(sfc, ["job-start", "tool-a", "--worktree", wt, "--title", "Tool: a"], h.inHerdr(fake))
    assert.deepEqual([h.card(1).project, h.card(1).origin, h.card(1).workspace, h.card(1).job], ["tool", "w4:p6", "w4", "tool-a"])
    // The same slug in sfc is another card; job-start from sfc finds its own (none) first.
    h.ok(sfc, ["add", "todo", "sfc's tool-a", "--job", "tool-a"])
    assert.match(h.ok(sfc, ["job-start", "tool-a"]), /^2 → doing/)
    assert.equal(h.run(sfc, ["job-start", "x", "--worktree", join(h.base, "missing")]).status, 2)
  } finally {
    h.done()
  }
})

const hasScript = /util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "")
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const words = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, " ").replace(/\s+/g, " ")

test("upgrade path: a pane on a repo's 0.4 file (self-updated before the import) follows the cards into the store, and says the board isn't in until then", { skip: !hasScript && "needs util-linux script" }, async () => {
  const h = home()
  let child
  try {
    const app = h.repo("app")
    const file = legacy(app, [{ id: 3, title: "Approve the waves", column: "waiting", ask: "say go" }], 5)
    const cmd = `stty cols 100 rows 30; exec node '${PANE}' --board '${file}' --origin 'w4:p6' --interval 1`
    child = spawn("script", ["-qefc", cmd, "/dev/null"], { cwd: app, env: h.envFor(), detached: true })
    let out = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    await pause(1500)
    assert.match(words(out), /Approve the waves/)
    // The first write in the repo brings the board in and renames the file.
    h.ok(app, ["add", "waiting", "Second question", "--ask", "yes?"])
    out = ""
    await pause(2500)
    // Only changed lines are repainted: the title (now the store's, with both questions) and the new card.
    assert.match(words(out), /Job board · all projects · 2 need you/)
    assert.match(words(out), /5 ! Second question/)

    // A pane on the store in a repo whose 0.4 board isn't in yet says so.
    const other = h.repo("other")
    legacy(other, [{ id: 9, title: "Not in yet" }])
    const once = spawnSync(process.execPath, [PANE, "--once", "--width", "100", "--height", "20"], { cwd: other, env: h.envFor(), encoding: "utf8" })
    assert.match(words(once.stdout), /this repo's 0\.4 board isn't on the one board yet \(.*other\/\.git\/job-board\.json\): run board\.mjs import --dry-run, then board\.mjs import/)
  } finally {
    try {
      if (child && child.exitCode === null) process.kill(-child.pid, "SIGKILL")
    } catch {}
    h.done()
  }
})

test("open and restart move a board pane started on a repo's 0.4 file to the one board", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const file = legacy(app, [{ id: 3, title: "Old" }], 5)
    const fake = join(h.base, "herdr-open.json")
    const running = `node '${PANE}' --board '${file}' --origin 'w4:p6' --version '${VERSION}'`
    writeFileSync(
      fake,
      JSON.stringify({
        agents: [{ name: "coord", pane_id: "w4:p6", workspace_id: "w4" }],
        panes: [
          { pane_id: "w4:p6", tab_id: "w4:t1", workspace_id: "w4", cwd: app },
          { pane_id: "w4:p9", tab_id: "w4:t1", workspace_id: "w4", label: "board", running },
        ],
      }),
    )
    const log = () => JSON.parse(readFileSync(fake, "utf8")).log
    const r = h.run(app, ["open"], h.inHerdr(fake))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /board restarted in pane w4:p9 on the one board \(it showed .*app\/\.git\/job-board\.json\)/)
    assert.deepEqual(log().filter((a) => a[1] === "send-text").at(-1), ["pane", "send-text", "w4:p9", "q"])
    assert.match(log().filter((a) => a[1] === "run").at(-1)[3], new RegExp(`--board '${h.file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}' --origin 'w4:p6'`))
    assert.ok(!existsSync(file), "open (a write) brought the board in first")

    // `restart` finds a current-version board still on the imported file: restarted on the store.
    const state = JSON.parse(readFileSync(fake, "utf8"))
    state.panes.find((p) => p.pane_id === "w4:p9").running = running
    writeFileSync(fake, JSON.stringify(state))
    const again = h.run(app, ["restart"], h.inHerdr(fake))
    assert.equal(again.status, 0, again.stderr)
    assert.match(log().filter((a) => a[1] === "run").at(-1)[3], /--board '.*\/herdr-job-board\/board\.json'/)
  } finally {
    h.done()
  }
})

test("job-start and job-report by slug never take another project's card; the first group with the job open wins, so no duplicate and no stranded card", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    const fake = h.herdr([{ name: "c1", pane_id: "w4:p6", workspace_id: "w4" }, { name: "c2", pane_id: "w4:p20", workspace_id: "w4" }, { name: "c3", pane_id: "wA:p1", workspace_id: "wA" }])
    // F3: sfc's To do card "review"; the ai-config coordinator starts its own job "review".
    h.ok(sfc, ["add", "todo", "Review the PR", "--job", "review"], h.inHerdr(fake))
    assert.match(h.ok(ai, ["job-start", "review", "--title", "AI rules review"], h.inHerdr(fake, "wA:p1", "wA")), /^2 → doing: AI rules review/)
    assert.deepEqual([h.card(1).column, h.card(1).title, h.card(1).workspace], ["todo", "Review the PR", "w4"], "sfc's card untouched")
    assert.equal(h.card(2).project, "ai-config")
    const report = join(ai, "r.json")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "ok" }))
    assert.match(h.ok(ai, ["job-report", "review", report], h.inHerdr(fake, "wA:p1", "wA")), /^2 → done/)
    assert.equal(h.card(1).column, "todo")

    // F4a: pane w4:p20 has a Done "build" card; the project's To do "build" card belongs to w4:p6.
    h.ok(sfc, ["add", "done", "Old build", "--job", "build"], h.inHerdr(fake, "w4:p20"))
    h.ok(sfc, ["add", "todo", "Build again", "--job", "build"], h.inHerdr(fake))
    assert.match(h.ok(sfc, ["job-start", "build"], h.inHerdr(fake, "w4:p20")), /^4 → doing: Build again/, "the open card, not a new one")
    assert.equal(h.state().items.filter((i) => i.job === "build").length, 2)

    // F4b: w4:p20's own Done card used report R; w4:p6's card 6 runs the job again with R.
    const R = join(sfc, "build-report.json")
    h.ok(sfc, ["add", "todo", "Deploy", "--job", "deploy"], h.inHerdr(fake, "w4:p20"))
    h.ok(sfc, ["job-start", "deploy", "--report", R], h.inHerdr(fake, "w4:p20"))
    writeFileSync(R, JSON.stringify({ status: "done", summary: "deployed" }))
    assert.match(h.ok(sfc, ["job-report", "deploy", R, "--if-final"], h.inHerdr(fake, "w4:p20")), /^5 → done/)
    h.ok(sfc, ["add", "todo", "Deploy again", "--job", "deploy"], h.inHerdr(fake))
    h.ok(sfc, ["job-start", "deploy", "--id", "6", "--report", R], h.inHerdr(fake, "w4:p20"))
    assert.match(h.ok(sfc, ["job-report", "deploy", R, "--if-final"], h.inHerdr(fake, "w4:p20")), /^6 → done: Deploy again/)
  } finally {
    h.done()
  }
})

test("restore takes only the store's backups; an import backup is merged with import, into its own repo; next_id never goes down", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    legacy(sfc, [{ id: 1, title: "one" }, { id: 2, title: "two" }])
    h.ok(sfc, ["import"])
    h.ok(sfc, ["rm", "2"])
    h.ok(sfc, ["add", "todo", "three"], { JOB_BOARD_NOW: "2026-10-20T10:00:00Z" })
    h.ok(sfc, ["add", "todo", "four"], { JOB_BOARD_NOW: "2026-10-20T10:00:00Z" })
    const listed = h.ok(sfc, ["restore"])
    assert.match(listed, /board-2026-10-20\.json/)
    assert.doesNotMatch(listed, /import-/, "import backups aren't restore's")
    const [dir] = readdirSync(join(h.store, "backups")).filter((f) => f.startsWith("import-"))
    const importBackup = join(h.store, "backups", dir, "sfc-integration.json")
    const r = h.run(sfc, ["restore", importBackup])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /is a 0\.4 board \(one repo's cards, e\.g\. what import kept\), not a backup of the one board; restore puts back only backups\/board-\*\.json\. To merge its cards in again: node .* import '.*sfc-integration\.json'/)
    // The import backup merged in: card 2 comes back in sfc-integration, the rest are there already.
    assert.match(h.ok(sfc, ["import", importBackup]), /→ {2}sfc-integration \(sfc\): 1 card, id kept \(2\), 1 already there/)
    assert.deepEqual(h.state().items.map((i) => [i.id, i.project]), [[1, "sfc-integration"], [2, "sfc-integration"], [3, "sfc-integration"], [4, "sfc-integration"]])
    assert.ok(existsSync(importBackup), "a backup is never renamed")
    // Restoring the day's backup (before cards 3 and 4): next_id stays 5.
    h.ok(sfc, ["restore", "board-2026-10-20.json"], { JOB_BOARD_NOW: "2026-10-20T11:00:00Z" })
    assert.match(h.ok(sfc, ["add", "todo", "five"], { JOB_BOARD_NOW: "2026-10-20T11:00:00Z" }), /^added 5 /)
  } finally {
    h.done()
  }
})

test("import again after a rollback: re-tagged, renumbered and archived cards are found, not added twice; reports are kept for imported and archived cards", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    h.repo("ai-config")
    const other = h.repo("other")
    h.ok(other, ["add", "todo", "other one"], { JOB_BOARD_NOW: "2026-10-01T10:00:00Z" })
    // A 0.4-era board, written through JOB_BOARD_FILE: a job report finished card 1 on 1 Oct.
    const file = join(sfc, ".git", "job-board.json")
    const R = join(sfc, "r.json")
    writeFileSync(R, JSON.stringify({ status: "done", summary: "built" }))
    const old = { JOB_BOARD_FILE: file, JOB_BOARD_NOW: "2026-10-01T10:00:00Z" }
    h.ok(sfc, ["job-start", "build", "--report", R], old)
    h.ok(sfc, ["job-report", "build"], old)
    h.ok(sfc, ["add", "todo", "two"], old)
    h.ok(sfc, ["add", "todo", "three"], old)
    // Import on 19 Oct: id 1 is taken (other's), so build becomes 4 and is archived at once.
    const first = h.ok(sfc, ["import", "--retag", "3=ai-config"])
    assert.match(first, /renumbered \(the id was taken\): sfc-integration#1 → 4/)
    assert.match(first, /^archive: 1 Done card older than 7 days goes to archive\//m)
    assert.deepEqual(h.state().items.map((i) => [i.id, i.project]), [[1, "other"], [2, "sfc-integration"], [3, "ai-config"]])
    // The same report again: archived, so no new card.
    assert.match(h.ok(sfc, ["job-report", "build", R]), /^4 unchanged \(archived\)/)
    // Rollback (mv back), then forward again: nothing added twice.
    spawnSync("mv", [join(sfc, ".git", "job-board.migrated.json"), file])
    const again = h.ok(sfc, ["import"])
    assert.match(again, /sfc-integration \(sfc\): 0 cards, 3 already there/)
    assert.equal(h.state().items.length, 3)
  } finally {
    h.done()
  }
})

test("the dry run shows the archive the import does, and its totals match the real run", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    legacy(sfc, [{ id: 1, title: "old done", column: "done", since: "2026-10-01T09:00:00.000Z" }, { id: 2, title: "open" }])
    const dry = h.ok(sfc, ["import", "--dry-run"])
    const real = h.ok(sfc, ["import"])
    const tail = (text) => text.split("\n").filter((l) => /^(archive|then|done):/.test(l)).map((l) => l.replace(/^(then|done):/, "x:"))
    assert.deepEqual(tail(dry), tail(real))
    assert.match(dry, /^archive: 1 Done card older than 7 days goes to archive\/ \(json --archive YYYY-MM shows them\)$/m)
    assert.match(dry, /^then: {2}board\.json 1 cards \(1 open\), next_id 3;/m)
  } finally {
    h.done()
  }
})

test("job-start --id N --project P on one's own card runs it in P; retag gives an unowned card to the coordinator", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    h.repo("herdr-job-board")
    h.repo("ai-config")
    const fake = h.herdr([{ name: "c1", pane_id: "w4:p6", workspace_id: "w4" }])
    h.ok(sfc, ["add", "todo", "Card"], h.inHerdr(fake))
    assert.match(h.ok(sfc, ["job-start", "p2", "--id", "1", "--project", "herdr-job-board"], h.inHerdr(fake)), /^1 → doing/)
    assert.equal(h.card(1).project, "herdr-job-board")
    // A card nobody owns (written from a plain shell), re-tagged by the coordinator: it may go on.
    h.ok(sfc, ["add", "todo", "Unowned"])
    assert.equal(h.card(2).origin, "")
    h.ok(sfc, ["retag", "2", "ai-config"], h.inHerdr(fake))
    assert.equal(h.card(2).origin, "w4:p6")
    h.ok(sfc, ["done", "2"], h.inHerdr(fake))
  } finally {
    h.done()
  }
})

test("a corrupt board is never backed up over the good ones; an archive line cut short doesn't swallow the next card", () => {
  const h = home()
  try {
    const app = h.repo("app")
    h.ok(app, ["add", "todo", "a"], { JOB_BOARD_NOW: "2026-10-01T10:00:00Z" })
    writeFileSync(h.file, "{ not json")
    const r = h.run(app, ["add", "todo", "b"], { JOB_BOARD_NOW: "2026-10-02T10:00:00Z" })
    assert.equal(r.status, 1)
    assert.ok(!existsSync(join(h.store, "backups", "board-2026-10-02.json")), "no backup of a corrupt board")
    // An archive whose last line has no line break (a full disk): the next card starts a new line.
    writeFileSync(h.file, JSON.stringify({ version: 2, next_id: 3, items: [{ id: 2, project: "app", title: "done", column: "done", since: "2026-10-01T10:00:00.000Z", updated: "2026-10-01T10:00:00.000Z" }] }))
    mkdirSync(join(h.store, "archive"), { recursive: true })
    writeFileSync(join(h.store, "archive", "2026-10.jsonl"), JSON.stringify({ id: 1, title: "earlier", column: "done" }))
    h.ok(app, ["add", "todo", "c"], { JOB_BOARD_NOW: "2026-10-12T10:00:00Z" })
    assert.deepEqual(JSON.parse(h.ok(app, ["json", "--archive", "2026-10", "--project", "all"])).items.map((i) => i.id), [1, 2])
  } finally {
    h.done()
  }
})

/** A repo whose jobs carry SFC_AGENT_ROLE (its .claude/job.json role_env), as sfc-integration's do. */
function roleRepo(h, name = "sfc-integration") {
  const dir = h.repo(name)
  mkdirSync(join(dir, ".claude"))
  writeFileSync(join(dir, ".claude", "job.json"), JSON.stringify({ role_env: "SFC_AGENT_ROLE" }))
  return dir
}

test("roles: a worker known by its repo's role_env (SFC_AGENT_ROLE) never brings boards in, owns, takes over or becomes front; the hook leaves it alone", async () => {
  const { handle } = await import("../hooks/board-hook.mjs")
  const h = home()
  try {
    const sfc = roleRepo(h)
    const wt = join(h.base, "sfc-integration-wt-a")
    git(sfc, "worktree", "add", "-q", wt, "-b", "feat/a")
    legacy(sfc, [{ id: 1, title: "one", column: "waiting" }, { id: 2, title: "two" }])
    const fake = h.herdr([{ name: "sfc-a", pane_id: "w4:p51", workspace_id: "w4" }])
    const worker = h.inHerdr(fake, "w4:p51", "w4", { SFC_AGENT_ROLE: "worker" })
    // From the worktree (no job.json there: the repo's is read too), and from the repo.
    for (const dir of [wt, sfc]) {
      const r = h.run(dir, ["add", "todo", "x"], worker)
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /isn't on the one board yet, and a worker doesn't bring it in; nothing was changed/)
    }
    assert.ok(!existsSync(h.file))
    // The coordinator (w4:p6, gone later) brings it in and owns the cards.
    h.ok(sfc, ["ls"], h.inHerdr(h.herdr([{ pane_id: "w4:p6" }])))
    h.ok(sfc, ["add", "todo", "coordinator's"], h.inHerdr(h.herdr([{ pane_id: "w4:p6" }])))
    assert.deepEqual(h.state().items.map((i) => i.origin), ["w4:p6", "w4:p6", "w4:p6"])
    // The worker edits a card whose owner is gone: no takeover; its own card has no owner; never in coordinators.
    h.ok(wt, ["edit", "2", "--desc", "by the worker"], worker)
    assert.equal(h.card(2).origin, "w4:p6")
    h.ok(wt, ["add", "todo", "worker's"], worker)
    assert.equal(h.card(4).origin, "")
    assert.deepEqual(Object.keys(h.state().coordinators), ["w4:p6"])
    assert.equal(h.run(wt, ["front"], worker).status, 2)
    assert.equal(h.run(wt, ["adopt", "1"], worker).status, 2)
    // The hook: nothing for that worker, even without --role-env.
    const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: wt, prompt: "hi" }
    assert.equal(handle(input, { HERDR_ENV: "1", HOME: h.base, SFC_AGENT_ROLE: "worker" }).stdout, "")
    assert.notEqual(handle(input, { HERDR_ENV: "1", HOME: h.base }).stdout, "")
  } finally {
    h.done()
  }
})

test("open from the key binding (a plugin action: the focused pane's role is unknown) brings boards in with no owner", () => {
  const h = home()
  try {
    const app = h.repo("app")
    legacy(app, [{ id: 1, title: "one" }])
    const fake = join(h.base, "herdr-plugin.json")
    writeFileSync(fake, JSON.stringify({ agents: [{ name: "job-x", pane_id: "w4:p51", workspace_id: "w4" }], panes: [{ pane_id: "w4:p51", tab_id: "w4:t2", workspace_id: "w4", cwd: app }] }))
    const r = h.run(h.base, ["open"], h.inHerdr(fake, "w4:p51", "w4", { HERDR_PLUGIN_ID: "herdr-job-board" }))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(h.state().items.map((i) => [i.id, i.origin]), [[1, ""]])
    assert.deepEqual(h.state().coordinators, {})
  } finally {
    h.done()
  }
})

test("write gate: a board under the real home is written only by the installed plugin at 0.5.0 or later; a checkout (this one, 0.4.0) refuses, reads still work", async () => {
  const { writeRefusal } = await import("../board.mjs")
  const h = home()
  try {
    // JOB_BOARD_PROTECT stands for the real home here (the tests never touch the real one).
    const env = { HOME: h.base, JOB_BOARD_PROTECT: h.base }
    const store = join(h.store, "board.json")
    const checkout = SCRIPTS
    // `herdr plugin install` clones the repo into <config>/herdr/plugins/github/<id>-<hash>/.
    const installed = join(h.base, ".config", "herdr", "plugins", "github", "herdr-job-board-2d3b6201c876")
    mkdirSync(installed, { recursive: true })
    git(installed, "init", "-q")
    assert.match(writeRefusal(store, env, { version: "0.4.0", scripts: installed }), /is 0\.4\.0 .*older than 0\.5\.0: it writes no board under .*; for a trial, set JOB_BOARD_HOME to a scratch folder/)
    assert.match(writeRefusal(store, env, { version: "0.5.0", scripts: checkout }), /isn't the installed plugin/)
    assert.equal(writeRefusal(store, { ...env, HERDR_PLUGIN_ROOT: checkout }, { version: "0.5.0", scripts: checkout }), "", "the copy Herdr runs")
    assert.equal(writeRefusal(store, env, { version: "0.5.0", scripts: installed }), "", "the installed clone, outside Herdr")
    assert.equal(writeRefusal(store, { ...env, XDG_CONFIG_HOME: join(h.base, "elsewhere") }, { version: "0.5.0", scripts: installed }), "", "HOME's config folder counts too")
    const plain = join(h.base, "copies", "herdr-job-board")
    mkdirSync(plain, { recursive: true })
    assert.match(writeRefusal(store, env, { version: "0.5.0", scripts: plain }), /isn't the installed plugin/, "a folder outside Herdr's plugins is a development copy")
    assert.match(writeRefusal(store, env, { version: "0.5.0", scripts: join(h.base, ".config", "herdr", "plugins") }), /isn't the installed plugin/, "the plugins folder itself isn't a copy")
    assert.equal(writeRefusal(join(h.base, "..", "elsewhere", "board.json"), env, { version: "0.4.0", scripts: checkout }), "", "outside the real home: free")
    // JOB_BOARD_DEV=1: a board of its own under the home, never the one board or a repo's .git.
    const dev = { ...env, JOB_BOARD_DEV: "1", JOB_BOARD_HOME: join(h.base, "trial") }
    assert.equal(writeRefusal(join(h.base, "trial", "board.json"), dev, { version: "0.4.0", scripts: checkout }), "")
    assert.notEqual(writeRefusal(store, dev, { version: "0.4.0", scripts: checkout }), "")
    assert.notEqual(writeRefusal(join(h.base, "app", ".git", "job-board.json"), { ...dev, JOB_BOARD_FILE: "x" }, { version: "0.4.0", scripts: checkout }), "")

    // The CLI from this checkout: a write (and open) refuses before anything moves; ls reads.
    const app = h.repo("app")
    const file = legacy(app, [{ id: 1, title: "live one" }])
    for (const args of [["add", "todo", "x"], ["job-start", "build"]]) {
      const r = h.run(app, args, { JOB_BOARD_PROTECT: h.base })
      assert.equal(r.status, 1, args.join(" "))
      assert.match(r.stderr, /isn't the installed plugin: it writes no board under/)
    }
    const fake = h.herdr([])
    const o = h.run(app, ["open"], { ...h.inHerdr(fake), JOB_BOARD_PROTECT: h.base })
    assert.equal(o.status, 1)
    assert.ok(existsSync(file) && !existsSync(h.store), "nothing imported, nothing renamed")
    assert.equal(JSON.parse(readFileSync(fake, "utf8")).log.filter((a) => a[1] === "split").length, 0, "no pane opened")
    assert.equal(h.run(app, ["ls"], { JOB_BOARD_PROTECT: h.base }).status, 0)
  } finally {
    h.done()
  }
})

test("after a write brought the boards in, the coordinator's steps still work: import --dry-run shows it, import --retag applies the re-tags, and the note stays until then", async () => {
  const { handle } = await import("../hooks/board-hook.mjs")
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    h.repo("herdr-job-board")
    legacy(sfc, [{ id: 7, title: "3CX certificate: renew" }, { id: 9, title: "Job board 0.5.0: plan", column: "doing" }])
    // A wait script's job-report (output dropped) brings it in.
    spawnSync(process.execPath, [BOARD, "job-report", "x", join(sfc, "none.json"), "--if-final"], { cwd: sfc, env: h.envFor(), encoding: "utf8" })
    assert.equal(h.state().imports[0].seen, false)
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: sfc, prompt: "hi" }
    assert.match(JSON.parse(handle(prompt, { HERDR_ENV: "1", HOME: h.base }).stdout).hookSpecificOutput.additionalContext, /^Job board: 0\.4 boards were brought in by themselves \(sfc-integration: 2 cards\)\. Look and re-tag: /)
    const pane = spawnSync(process.execPath, [PANE, "--once", "--width", "120", "--height", "20"], { cwd: sfc, env: h.envFor(), encoding: "utf8" })
    assert.match(words(pane.stdout), /0\.4 boards were brought in by themselves/)
    const dry = h.ok(sfc, ["import", "--dry-run"])
    assert.match(dry, /^import: nothing left to bring in; brought in automatically on /)
    assert.match(dry, /sfc-integration\/\.git\/job-board\.json {2}→ {2}sfc-integration: 2 cards$/m)
    assert.match(dry, /^re-tag \(suggested from titles and running jobs; apply with --retag 9=herdr-job-board\):$/m)
    assert.equal(h.state().imports[0].seen, false, "a dry run marks nothing")
    assert.match(h.ok(sfc, ["import", "--retag", "9=herdr-job-board,7=home"]), /^re-tagged: 9→herdr-job-board 7→home$/m)
    assert.deepEqual(h.state().items.map((i) => [i.id, i.project]), [[7, "home"], [9, "herdr-job-board"]])
    assert.equal(h.state().imports[0].seen, true)
    assert.doesNotMatch(handle(prompt, { HERDR_ENV: "1", HOME: h.base }).stdout, /brought in by themselves/)
    assert.equal(h.run(sfc, ["import", "--retag", "1=home"]).status, 2, "only the imported cards")
  } finally {
    h.done()
  }
})

test("a renumbered card that comes back through export --legacy isn't added twice; a repeat job-report after Done doesn't move a queued To do card", () => {
  const h = home()
  try {
    const one = h.repo("one")
    const ai = h.repo("ai-config")
    h.ok(one, ["add", "todo", "one's card"])
    legacy(ai, [{ id: 1, title: "ai card" }])
    h.ok(ai, ["import"])
    assert.equal(h.card(2).was, "ai-config#1")
    // Rollback with export --legacy, then forward again.
    rmSync(join(ai, ".git", "job-board.migrated.json"))
    writeFileSync(join(ai, ".git", "job-board.json"), h.ok(ai, ["export", "--legacy"]))
    assert.match(h.ok(ai, ["import"]), /ai-config \(ai\): 0 cards, 1 already there/)
    assert.equal(h.state().items.length, 2)

    // R6: build reported Done; a new To do card for build is queued; the report fires again.
    const R = join(one, "r.json")
    h.ok(one, ["job-start", "build", "--report", R])
    writeFileSync(R, JSON.stringify({ status: "done", summary: "ok" }))
    assert.match(h.ok(one, ["job-report", "build", R]), /^3 → done/)
    h.ok(one, ["add", "todo", "Build again later", "--job", "build"])
    assert.match(h.ok(one, ["job-report", "build", R]), /^3 unchanged/)
    assert.equal(h.card(4).column, "todo")
  } finally {
    h.done()
  }
})

test("small points: front show is a read; the migration says 'weren't' for several boards; the test guard refuses a HOME that holds the real home", () => {
  const h = home()
  try {
    const sfc = roleRepo(h)
    const ai = h.repo("ai-config")
    legacy(sfc, [{ id: 1, title: "one" }])
    legacy(ai, [{ id: 2, title: "two" }])
    const r = h.run(sfc, ["front", "show"], { SFC_AGENT_ROLE: "worker" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(h.run(h.repo("third"), ["add", "todo", "x"]).stderr, /^board: the 0\.4 boards on this machine \(.*\) weren't on the one board yet: brought in first/m)
    const g = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(new URL("./guard.mjs", import.meta.url).href)}`], { env: { ...process.env, HOME: "/" }, encoding: "utf8" })
    assert.equal(g.status, 2)
    assert.match(g.stderr, /refusing to run: HOME \/ is the real home or holds it/)
  } finally {
    h.done()
  }
})

test("write gate, end to end: the installed clone at 0.5.0 writes outside Herdr and inside it with no Herdr call; this checkout refuses with one line and exit 1", () => {
  const h = home()
  try {
    // The release as Herdr installs it: a git clone in the plugins folder, its herdr-plugin.toml at 0.5.0.
    const installed = join(h.base, ".config", "herdr", "plugins", "github", "herdr-job-board-2d3b6201c876")
    mkdirSync(join(installed, "hooks"), { recursive: true })
    git(installed, "init", "-q")
    for (const f of ["board.mjs", "board-pane.mjs", "links.mjs", join("hooks", "board-hook.mjs")]) writeFileSync(join(installed, f), readFileSync(join(SCRIPTS, f)))
    writeFileSync(join(installed, "herdr-plugin.toml"), readFileSync(join(SCRIPTS, "herdr-plugin.toml"), "utf8").replace(/^version = "[^"]*"/m, 'version = "0.5.0"'))
    const app = h.repo("app")
    const protect = { JOB_BOARD_PROTECT: h.base }
    const run = (cli, args, extra) => spawnSync(process.execPath, [cli, ...args], { cwd: app, env: h.envFor({ ...protect, ...extra }), encoding: "utf8" })
    // Outside Herdr.
    let r = run(join(installed, "board.mjs"), ["add", "todo", "from the installed copy"])
    assert.equal(r.status, 0, r.stderr)
    // Inside Herdr: no `herdr` call decides it (the fake logs every call).
    const fake = h.herdr([])
    r = run(join(installed, "board.mjs"), ["add", "todo", "inside Herdr"], h.inHerdr(fake))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(fake, "utf8")).log.filter((a) => a[0] === "plugin"), [], "no herdr plugin call")
    assert.equal(h.state().items.length, 2)
    // This checkout: refused, one line, exit 1, nothing written.
    r = run(BOARD, ["add", "todo", "from the checkout"])
    assert.equal(r.status, 1)
    assert.equal(r.stderr.trim().split("\n").length, 1)
    assert.match(r.stderr, /^board: this copy \(.*\) isn't the installed plugin: it writes no board under /)
    assert.equal(h.state().items.length, 2)
  } finally {
    h.done()
  }
})

test("cross-repo workers: SFC_AGENT_ROLE=worker in a repo whose job.json names another variable (or none) is still a worker; migrate honours --worktree", () => {
  const h = home()
  try {
    const tool = h.repo("herdr-job-board")
    const fake = h.herdr([{ name: "coord", pane_id: "w4:p6", workspace_id: "w4" }, { name: "board-v5", pane_id: "w4:p51", workspace_id: "w4" }])
    const coordinator = h.inHerdr(fake)
    const worker = h.inHerdr(fake, "w4:p51", "w4", { SFC_AGENT_ROLE: "worker" })
    h.ok(tool, ["add", "todo", "coordinator's card"], coordinator)
    h.ok(tool, ["add", "todo", "worker's card"], worker)
    assert.deepEqual(h.state().items.map((i) => i.origin), ["w4:p6", ""])
    assert.deepEqual(Object.keys(h.state().coordinators), ["w4:p6"])
    assert.equal(h.run(tool, ["front"], worker).status, 2)
    assert.equal(h.run(tool, ["adopt", "1"], worker).status, 2)
    // An owner that is gone: the worker's edit doesn't take the card.
    h.ok(tool, ["edit", "1", "--desc", "x"], h.inHerdr(h.herdr([{ pane_id: "w4:p51" }]), "w4:p51", "w4", { SFC_AGENT_ROLE: "worker" }))
    assert.equal(h.card(1).origin, "w4:p6")
    // Any *_AGENT_ROLE; "coordinator" is not a worker.
    h.ok(tool, ["add", "todo", "a coordinator by role"], h.inHerdr(fake, "w4:p52", "w4", { OTHER_AGENT_ROLE: "coordinator" }))
    assert.equal(h.card(3).origin, "w4:p52")

    // migrate with --worktree: the worktree's repo names JOB_ROLE (not *_AGENT_ROLE); the worker runs from a plain folder.
    const h2 = home()
    try {
      const sfc = h2.repo("sfc")
      mkdirSync(join(sfc, ".claude"))
      writeFileSync(join(sfc, ".claude", "job.json"), JSON.stringify({ role_env: "JOB_ROLE" }))
      legacy(sfc, [{ id: 1, title: "one" }])
      const plain = join(h2.base, "plain")
      mkdirSync(plain)
      const r = h2.run(plain, ["job-start", "x", "--worktree", sfc], h2.inHerdr(h2.herdr([]), "w4:p51", "w4", { JOB_ROLE: "worker" }))
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /on the one board yet, and a worker doesn't bring it in; nothing was changed/)
      assert.ok(!existsSync(h2.file) && existsSync(join(sfc, ".git", "job-board.json")))
    } finally {
      h2.done()
    }
  } finally {
    h.done()
  }
})
