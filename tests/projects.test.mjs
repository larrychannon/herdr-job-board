// Run: node --test (from the repo root)
// The pane with several projects (0.5, phase 3): the tag column in each project's colour, the
// project strip, p / P / a click on the strip, filtered views that count what they hide, the
// open card's project and where its answers go, the wide layout, and `ls --project`. The board is
// the plan's mockups (real card titles), written to a temp store; Herdr is faked.
// UPDATE_SNAPSHOTS=1 rewrites the snapshots.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { textWidth } from "../board.mjs"

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(SCRIPTS, "board.mjs")
const PANE = join(SCRIPTS, "board-pane.mjs")
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))
const FAKE_HERDR = join(FIXTURES, "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)

const NOW = new Date("2026-10-19T11:57:00Z")
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The mockups' board: four projects, the sfc coordinator in pane w4:p6. */
function mockBoard() {
  const card = (id, project, column, title, since, more = {}) => ({ id, project, column, title, desc: "", job: "", ask: "", origin: project === "sfc-integration" || project === "herdr-job-board" ? "w4:p6" : "", workspace: "w4", created: since, since, updated: since, ...more })
  const items = [
    card(108, "sfc-integration", "waiting", "UI consistency plan: answer 10 questions", ago(3 * DAY), {
      desc: "Fable plan (docs PR #143): audit of every page with screenshots, one wording guide, shared components (CitySummaryRow, CountChip, DefaultVersion…)",
      ask: "Accept all 10 suggested answers (then mockup M1 first), or go through them?",
      options: [{ label: "Accept all suggested", suggested: true }, { label: "Go through them" }, { label: "Later" }],
    }),
    card(170, "sfc-integration", "waiting", "magicwan v343 fleet rollout: approve the waves", ago(2 * HOUR + 52 * MIN), {
      desc: "Pilot SFC-LON-021 healthy since 16 Oct: 270/270 heartbeats GRE up + conntrack assured, audits all running. 3 new nodes already on v343. 181 nodes in 40 cities.",
      ask: "Approve: wave 1 LON (5), wave 2 AMS FRA PAR MAD OSL (~26), then ~40 per wave by region, 15 min checks between",
      options: [{ label: "Go", suggested: true }, { label: "LON only first" }, { label: "Not today" }],
    }),
    card(192, "sfc-integration", "waiting", "One Analytics page PR #146: merge", ago(2 * DAY)),
    card(204, "ai-config", "waiting", "Git access on the LXC: narrower tokens instead of Touch-ID: pick", ago(16 * HOUR), {
      desc: "Pushes here already use tokens, not Touch-ID, but the tokens are broad (gh can write every repo).",
      ask: "Go = I write the step-by-step (you create the tokens yourself), or keep as is",
      options: [{ label: "Go", suggested: true }, { label: "Only ai-config HTTPS" }, { label: "Keep as is" }],
    }),
    card(211, "herdr-job-board", "doing", "Job board 0.5.0, one board for all projects: plan", ago(3 * MIN), { job: "board-v5-plan" }),
    card(140, "sfc-integration", "todo", "Bring sfc-app-track into sfc-integration", ago(3 * DAY)),
    card(171, "sfc-integration", "todo", "SFC-MKC-012: heartbeat flaps down/up every ~20 s", ago(3 * DAY)),
    card(177, "sfc-integration", "todo", "DNS: Edit Targets loop guard", ago(3 * DAY)),
    card(181, "sfc-integration", "todo", "SNMP stats follow-ups (from #142 re-check)", ago(3 * DAY)),
    card(183, "sfc-integration", "todo", "Redis / AC: parked until a real SFC node reports via AC", ago(2 * DAY)),
    card(190, "sfc-integration", "todo", "Analytics: include archived/removed nodes in range totals (after #142)", ago(2 * DAY)),
    card(200, "home", "todo", "3CX SSL certificate: renew before ~25 Oct 2026", ago(26 * HOUR)),
    card(206, "ai-config", "todo", "Job board 0.4.0 follow-ups in ai-config and the job skill", ago(13 * HOUR)),
    card(207, "herdr-job-board", "todo", "Board key binding + sidebar count (in 0.5.0)", ago(3 * MIN)),
    card(209, "ai-config", "todo", "Coordinator auto-restart supervisor (parked)", ago(9 * MIN)),
    card(205, "sfc-integration", "done", "Billing summary: totals per city", ago(3 * HOUR)),
    card(210, "herdr-job-board", "done", "Job board 0.4.0: release", ago(1 * HOUR)),
  ]
  return {
    version: 2,
    next_id: 212,
    front: "",
    projects: {
      "sfc-integration": { tag: "sfc", color: "magenta", root: "/root/sfc-integration", git: "/root/sfc-integration/.git", workspace: "w4" },
      "ai-config": { tag: "ai", color: "cyan", root: "/root/ai-config", git: "/root/ai-config/.git", workspace: "" },
      "herdr-job-board": { tag: "herdr", color: "blue", root: "/root/herdr-job-board", git: "/root/herdr-job-board/.git", workspace: "" },
      home: { tag: "home", color: "green", root: "/root", git: "", workspace: "" },
    },
    coordinators: { "w4:p6": { workspace: "w4", project: "sfc-integration", seen: ago(MIN) } },
    items,
    panes: { "w4:t1": { pane: "w4:p14", origin: "w4:p6", at: ago(HOUR) } },
    reports: {},
    imports: [],
  }
}

/** A temp store with the mockups' board, a fake Herdr (the coordinator w4:p6, the plan job working). */
function setup(board = mockBoard(), agents = null) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-projects-")))
  const store = join(base, "store")
  mkdirSync(store)
  writeFileSync(join(store, "board.json"), JSON.stringify(board))
  const herdr = join(base, "herdr.json")
  writeFileSync(
    herdr,
    JSON.stringify({ agents: agents ?? [{ pane_id: "w4:p6", workspace_id: "w4", agent_status: "idle", interactive_ready: true }, { name: "board-v5-plan", pane_id: "w4:p20", workspace_id: "w4", agent_status: "working" }] }),
  )
  const env = { ...process.env, HOME: base, JOB_BOARD_HOME: store, JOB_BOARD_NOW: NOW.toISOString(), TZ: "UTC", NO_COLOR: "1", HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdr, HERDR_WORKSPACE_ID: "w4", HERDR_PANE_ID: "w4:p6", BOARD_EMOJI: "0" }
  const pane = (width, height, keys = "", extra = []) =>
    spawnSync(process.execPath, [PANE, "--once", "--width", String(width), "--height", String(height), "--origin", "w4:p6", "--frame", "0", "--keys", keys, ...extra], { cwd: base, env, encoding: "utf8" })
  const ls = (...args) => spawnSync(process.execPath, [BOARD, "ls", ...args], { cwd: base, env, encoding: "utf8" })
  return { base, env, herdr, pane, ls, done: () => rmSync(base, { recursive: true, force: true }) }
}

/** Every line at most `width` cells, and exactly `height` lines. */
function fits(text, width, height) {
  const lines = text.replace(/\n$/, "").split("\n")
  for (const l of lines) assert.ok(textWidth(l.replace(/\x1b\[[0-9;]*m/g, "")) <= width, `${textWidth(l)} > ${width}: ${l}`)
  if (height) assert.equal(lines.length, height)
}

function snapshot(name, text) {
  const snap = join(FIXTURES, name)
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, text)
  assert.equal(text, readFileSync(snap, "utf8"), `snapshot ${name} (UPDATE_SNAPSHOTS=1 to rewrite)`)
}

test("snapshots: 95×40 inbox all and filtered (p), 60×30 compact all and filtered, 160×45 wide; colour on one of each", () => {
  const t = setup()
  try {
    const frames = [
      ["inbox 95x40 · all", t.pane(95, 40), 95, 40],
      ["inbox 95x40 · p (sfc), ↓ to 170", t.pane(95, 40, "p\x1b[B"), 95, 40],
      ["compact 60x30 · all", t.pane(60, 30), 60, 30],
      ["compact 60x30 · p p (ai), Space", t.pane(60, 30, "pp "), 60, 30],
      ["wide 160x45 · all", t.pane(160, 45), 160, 45],
      ["wide 160x45 · p p p (herdr)", t.pane(160, 45, "ppp"), 160, 45],
    ]
    let plain = ""
    for (const [name, r, w, h] of frames) {
      assert.equal(r.status, 0, r.stderr)
      fits(r.stdout, w, h)
      plain += `===== ${name} =====\n${r.stdout}\n`
    }
    snapshot("projects-plain.txt", plain)
    let color = ""
    for (const [name, keys, w, h] of [["inbox 95x40 · all", "", 95, 40], ["compact 60x30 · p p (ai), Space", "pp ", 60, 30], ["wide 160x45 · all", "", 160, 45]]) {
      const r = t.pane(w, h, keys, ["--color"])
      fits(r.stdout, w, h)
      color += `===== ${name} =====\n${r.stdout}\n`
    }
    snapshot("projects-color.txt", color)
    // The tags in their projects' colours, never yellow (33) or red (31) for a tag.
    assert.match(color, /\x1b\[35msfc /)
    assert.match(color, /\x1b\[36mai /)
    assert.match(color, /\x1b\[34mherdr/)
    assert.match(color, /\x1b\[32mhome/)
  } finally {
    t.done()
  }
})

test("what the views say: the strip, the title's counts, filtered headers, the open card's project and where answers go", () => {
  const t = setup()
  try {
    const all = t.pane(95, 40).stdout
    assert.match(all, /^Job board · all projects · 4 need you +11:57$/m)
    assert.match(all, /^Projects: ▸all  sfc 3  ai 1  herdr  home +p filter · P all$/m)
    assert.match(all, /^▸108 ! sfc   UI consistency plan: answer 10 questions +3 days$/m)
    assert.match(all, /^ {13}sfc-integration · Fable plan \(docs PR #143\)/m)
    assert.match(all, /^ {13}answers go to: sfc coordinator \(w4:p6\)$/m)
    assert.match(all, /^ 211   herdr Job board 0\.5\.0, one board for all projects: plan +working \[= {3}\] +3 min$/m)
    assert.match(all, /^ 200   home  3CX SSL certificate/m)
    assert.match(all, /p project · d done/)

    const sfc = t.pane(95, 40, "p").stdout
    assert.match(sfc, /^Job board · sfc-integration · 3 need you  \(\+1 in other projects\) +11:57$/m)
    assert.match(sfc, /^Projects: all  ▸sfc 3  ai 1  herdr  home +p next · P all$/m)
    assert.match(sfc, /WAITING ON YOU \(3 · \+1 other\)/)
    assert.match(sfc, /DOING \(0 · \+1 other\) · nothing running here/)
    assert.match(sfc, /TO DO \(6 · \+4 other\)/)
    assert.doesNotMatch(sfc, /204|211|206/)
    assert.match(sfc, /p next project · P all · d done/)

    // ai, opened (compact, Space): no ai-config coordinator runs, so a press asks first.
    const ai = t.pane(60, 30, "pp ").stdout
    assert.match(ai, /^ai-config · 1 needs you \(\+3 other\) +11:57$/m)
    assert.match(ai.replace(/\n +/g, " "), /no ai coordinator is running: a press asks first, then sends to the board's coordinator \(sfc, pane w4:p6\)/)
    // P: all projects again.
    assert.match(t.pane(95, 40, "ppP").stdout, /^Job board · all projects · 4 need you/m)
    // p after the last project: the first again.
    assert.match(t.pane(95, 40, "pppp").stdout, /^Job board · home/m)
    assert.match(t.pane(95, 40, "ppppp").stdout, /^Job board · sfc-integration/m)
  } finally {
    t.done()
  }
})

test("a click on the strip shows that project; on all, every one", () => {
  const t = setup()
  try {
    const lines = t.pane(95, 40).stdout.split("\n")
    const strip = lines[1]
    const x = (word) => [...strip.slice(0, strip.indexOf(word))].length + 1
    const click = (cx) => `\x1b[<0;${cx};2M\x1b[<0;${cx};2m`
    assert.match(t.pane(95, 40, click(x(" ai 1") + 2)).stdout, /^Job board · ai-config · 1 needs you/m)
    assert.match(t.pane(95, 40, click(x("herdr") + 1)).stdout, /^Job board · herdr-job-board/m)
    assert.match(t.pane(95, 40, `p${click(x("all") + 1)}`).stdout, /^Job board · all projects/m)
  } finally {
    t.done()
  }
})

test("a filtered view still shows another project's blocked job under Waiting, with its tag", () => {
  const board = mockBoard()
  board.items.push({ id: 213, project: "ai-config", column: "doing", title: "Guard v5: block coordinator edits", job: "guard-v5", workspace: "w4", origin: "", desc: "", ask: "", since: ago(20 * MIN), updated: ago(20 * MIN), created: ago(20 * MIN) })
  const t = setup(board, [
    { pane_id: "w4:p6", workspace_id: "w4", agent_status: "idle" },
    { name: "guard-v5", pane_id: "w4:p21", workspace_id: "w4", agent_status: "blocked" },
  ])
  try {
    const sfc = t.pane(95, 40, "p").stdout
    // Blocked first, as always; the tag column as wide as the tags on screen (sfc).
    assert.match(sfc, /^▸213 ! ai  Guard v5: block coordinator edits +blocked +20 min$/m)
    assert.match(sfc, /WAITING ON YOU \(4 · \+1 other\)/)
    assert.doesNotMatch(sfc, /Git access on the LXC/)
  } finally {
    t.done()
  }
})

test("ls --project P draws what the pane shows filtered to P; --project all every card; one project on the board: no tags, no strip", () => {
  const t = setup()
  try {
    const r = t.ls("--width", "95", "--project", "sfc")
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Job board · sfc-integration · 3 need you  \(\+1 in other projects\)/m)
    assert.match(r.stdout, /WAITING ON YOU \(3 · \+1 other\)/)
    assert.match(r.stdout, /^ 170 ! sfc magicwan v343 fleet rollout/m)
    assert.match(t.ls("--width", "95", "--project", "all").stdout, /^ 204 ! ai {4}Git access on the LXC/m)
    assert.equal(t.ls("--project", "nope").status, 2)
  } finally {
    t.done()
  }
  const one = mockBoard()
  one.items = one.items.filter((i) => i.project === "sfc-integration")
  const u = setup(one)
  try {
    const out = u.pane(95, 40).stdout
    assert.doesNotMatch(out, /Projects:/)
    assert.match(out, /^▸108 ! UI consistency plan/m)
    assert.doesNotMatch(out, /answers go to/, "one project: as in 0.4")
  } finally {
    u.done()
  }
})

test("widths: CJK and emoji in project names and titles, tags cut to 4 in compact; every size fits", () => {
  const board = mockBoard()
  board.projects["日本語のプロジェクト"] = { tag: "p", color: "bright magenta", root: "/x", git: "", workspace: "" }
  board.projects["release-notes-manager"] = { tag: "release", color: "bright cyan", root: "/y", git: "", workspace: "" }
  board.items.push(
    { id: 220, project: "日本語のプロジェクト", column: "waiting", title: "日本語のタイトルがとても長いのでここで切れるはずです 🚀", desc: "説明 ✅ with emoji 👨‍👩‍👧 in it", ask: "はい?", options: [{ label: "はい" }], origin: "", workspace: "w4", since: ago(HOUR), updated: ago(HOUR), created: ago(HOUR) },
    { id: 221, project: "release-notes-manager", column: "todo", title: "Release notes: 🧪 wording pass", desc: "", job: "", ask: "", origin: "", workspace: "", since: ago(HOUR), updated: ago(HOUR), created: ago(HOUR) },
  )
  const t = setup(board)
  try {
    for (const [w, h] of [[40, 15], [60, 30], [69, 24], [95, 40], [119, 40], [120, 40], [160, 45], [200, 60]]) {
      for (const keys of ["", " ", "p", "\x1b[B\x1b[B\x1b[B\x1b[B "]) {
        const r = t.pane(w, h, keys)
        assert.equal(r.status, 0, r.stderr)
        fits(r.stdout, w, h)
      }
    }
    const compact = t.pane(60, 30).stdout
    assert.match(compact, / rele /, "release cut to 4 in compact")
    assert.match(t.pane(95, 40).stdout, / release /, "7 in the inbox")
  } finally {
    t.done()
  }
})
