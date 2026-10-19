// Run: node --test (from the repo root)
// The one board for every project (0.5): where the store is, which project a folder is, tags,
// the ownership check, importing 0.4 boards, export, archive, backups and restore. Every test
// has its own temp HOME and store; Herdr is faked by fixtures/fake-herdr.mjs.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { boardPath, projectAt, projectName, readBoard, storeDir, tagFor } from "../board.mjs"

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
    for (const key of ["HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT", "HERDR_PLUGIN_STATE_DIR", "HERDR_BIN_PATH"]) delete env[key]
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
    assert.match(h.ok(h.base, ["front", "show"]), /no front coordinator set/)
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
    // Nothing more to import.
    assert.match(h.ok(sfc, ["import"]), /no 0\.4 board found/)

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

test("import on first use: an empty store and a repo with a 0.4 board; once, ids kept; the pane of an imported board reads the store", () => {
  const h = home()
  try {
    const app = h.repo("app")
    const file = legacy(app, [{ id: 3, title: "Carried over", column: "waiting", ask: "say go" }], 5)
    const r = h.run(app, ["ls", "--width", "80"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /^board: one board for all projects now: .*board\.json\. Imported this repo's 0\.4 board/)
    assert.match(r.stdout, /3 ! Carried over/)
    assert.ok(!existsSync(file) && existsSync(join(app, ".git", "job-board.migrated.json")))
    assert.equal(h.state().next_id, 5)
    assert.match(h.ok(app, ["add", "todo", "next"]), /^added 5 /, "ids go on from the old board's")
    assert.doesNotMatch(h.run(app, ["ls"]).stderr, /Imported/, "said once")
    // A second repo's 0.4 board isn't imported by itself: the store isn't empty (its ids may clash).
    const other = h.repo("other")
    const otherFile = legacy(other, [{ id: 3, title: "Clash" }])
    h.ok(other, ["ls"])
    assert.ok(existsSync(otherFile), "left for an explicit import")
    // A pane started (by 0.4) on the old file shows the store.
    const pane = spawnSync(process.execPath, [PANE, "--once", "--width", "80", "--height", "20", "--board", file], { cwd: app, env: h.envFor(), encoding: "utf8" })
    assert.equal(pane.status, 0, pane.stderr)
    assert.match(pane.stdout, /^all projects · 1 needs you/)
    assert.match(pane.stdout, /3 ! Carried over/)
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
