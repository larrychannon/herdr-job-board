// Run: node --test (from the repo root)
// Phase 2 of the one board: where an answer goes (the card's owner, its project's coordinator,
// the front after a second press), `answer`, the front's default, the hooks' "mine" scope, the
// scope of ls and json, and each workspace's sidebar count. Herdr is faked by
// fixtures/fake-herdr.mjs; every test has its own temp HOME and store.
import "./guard.mjs"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answerText, frontOf, routeAnswer, secondPressNote, tokenFor, writeRefusal } from "../board.mjs"
import { handle, mineOf, reminder, snapshot, waitingTouched } from "../hooks/board-hook.mjs"

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url))
const BOARD = join(SCRIPTS, "board.mjs")
const PANE = join(SCRIPTS, "board-pane.mjs")
const FAKE_HERDR = join(SCRIPTS, "tests", "fixtures", "fake-herdr.mjs")
chmodSync(FAKE_HERDR, 0o755)
import { spawnSync } from "node:child_process"

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=test", ...args], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

/**
 * A temp HOME with repos, its store, and a fake Herdr whose agents are the coordinators given
 * (every one ready for input).
 */
function home() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-routing-")))
  const store = join(base, ".local", "state", "herdr-job-board")
  const file = join(store, "board.json")
  const fake = join(base, "herdr.json")
  const repo = (name) => {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    return dir
  }
  const live = (...panes) =>
    writeFileSync(fake, JSON.stringify({ agents: panes.map((p) => ({ name: "", pane_id: p, workspace_id: p.split(":")[0], agent_status: "idle", interactive_ready: true })), log: [] }))
  live()
  const envFor = (extra = {}) => ({ ...process.env, HOME: base, XDG_STATE_HOME: "", JOB_BOARD_HOME: "", JOB_BOARD_FILE: "", TZ: "UTC", NO_COLOR: "1", JOB_BOARD_NOW: "2026-10-19T12:03:00Z", ...extra })
  // A pane inside Herdr (pane, workspace), with the fake.
  const at = (pane, extra = {}) => ({ HERDR_ENV: "1", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: fake, HERDR_PANE_ID: pane, HERDR_WORKSPACE_ID: pane.split(":")[0], ...extra })
  const run = (cwd, args, extra) => spawnSync(process.execPath, [BOARD, ...args], { cwd, env: envFor(extra), encoding: "utf8" })
  const ok = (cwd, args, extra) => {
    const r = run(cwd, args, extra)
    assert.equal(r.status, 0, `board ${args.join(" ")}: ${r.stderr}`)
    return r.stdout
  }
  const pane = (cwd, keys, origin, extra = {}) =>
    spawnSync(process.execPath, [PANE, "--once", "--width", "100", "--height", "30", "--origin", origin, "--keys", keys], { cwd, env: envFor({ ...at(origin), ...extra }), encoding: "utf8" })
  const log = () => JSON.parse(readFileSync(fake, "utf8")).log || []
  const prompts = () => log().filter((a) => a[0] === "agent" && a[1] === "prompt")
  const state = () => JSON.parse(readFileSync(file, "utf8"))
  const card = (id) => state().items.find((i) => i.id === id)
  return { base, store, file, fake, repo, live, envFor, at, run, ok, pane, log, prompts, state, card, done: () => rmSync(base, { recursive: true, force: true }) }
}
const flat = (text) => text.replace(/\n +/g, " ")

test("routeAnswer: the owner while it runs, else the project's newest live coordinator, else the fallback (a second press for another project's), else nowhere", () => {
  const state = {
    front: "",
    panes: {},
    projects: { "sfc-integration": { tag: "sfc" }, "ai-config": { tag: "ai" } },
    coordinators: {
      "w4:p6": { project: "sfc-integration", seen: "2026-10-19T10:00:00Z" },
      "w4:p7": { project: "sfc-integration", seen: "2026-10-19T11:00:00Z" },
      "wA:p1": { project: "ai-config", seen: "2026-10-19T09:00:00Z" },
    },
  }
  const agents = (...panes) => panes.map((pane_id) => ({ pane_id }))
  const sfc = { id: 170, project: "sfc-integration", origin: "w4:p6" }
  assert.deepEqual(routeAnswer(state, sfc, agents("w4:p6", "w4:p7")), { pane: "w4:p6", to: "sfc coordinator (w4:p6)", second: false })
  assert.deepEqual(routeAnswer(state, sfc, agents("w4:p7")), { pane: "w4:p7", to: "sfc coordinator (w4:p7)", second: false }, "the owner is gone: the project's newest")
  const ai = { id: 9, project: "ai-config", origin: "wA:p1" }
  const viaFront = routeAnswer(state, ai, agents("w4:p6"), { fallback: "w4:p6" })
  assert.deepEqual(viaFront, { pane: "w4:p6", to: "sfc coordinator (w4:p6)", second: true })
  assert.equal(secondPressNote(state, ai, viaFront, "Go"), "no ai coordinator is running: press Go again to send it to the board's coordinator (sfc, pane w4:p6)")
  assert.deepEqual(routeAnswer(state, ai, agents()), { error: "no ai coordinator is running; start one there, or use Other… (no front coordinator: none set, and no pane has opened the board; board.mjs front, from a coordinator's pane, sets one)" })
  // A card nobody owns, with a fallback of its own project (or one that never wrote): straight away, as in 0.4.
  assert.equal(routeAnswer(state, { id: 1, project: "sfc-integration", origin: "" }, agents("w4:p6"), { fallback: "w4:p6" }).second, false)
  assert.equal(routeAnswer(state, { id: 1, project: "ai-config", origin: "" }, agents("w9:p1"), { fallback: "w9:p1" }).second, false)
  assert.equal(routeAnswer(state, { id: 1, project: "ai-config", origin: "" }, agents("w4:p6"), { fallback: "w4:p6" }).second, true)
  // No agent list (Herdr not asked): the owner or the fallback as they are.
  assert.equal(routeAnswer(state, sfc, null).pane, "w4:p6")
  // The front: `front`, else the pane that last opened the board.
  assert.equal(frontOf({ front: "", panes: { "w4:t1": { pane: "w4:p9", origin: "w4:p6", at: "2026-10-19T10:00:00Z" }, "w8:t1": { pane: "w8:p3", origin: "w8:p1", at: "2026-10-19T11:00:00Z" }, old: "w1:p1" } }), "w8:p1")
  assert.equal(frontOf({ front: "w4:p6", panes: { x: { origin: "w8:p1", at: "z" } } }), "w4:p6")
  // The text: the tag before the title; from Telegram, said so.
  assert.equal(answerText({ id: 170, tag: "sfc", title: "magicwan v343 fleet rollout: approve the waves" }, "Go"), "Board card 170 (sfc · magicwan v343 fleet rollout: approve the waves): Go")
  assert.equal(answerText({ id: 170, tag: "sfc", title: "t" }, "LON only first", "telegram"), "Board card 170 (sfc · t): LON only first (from Telegram)")
})

test("buttons end to end: to the owner, then the project's coordinator; another project's coordinator only on a second press; the card says where it went", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    // The ai coordinator (wA:p1) asks; the sfc coordinator (w4:p6) opened the board.
    h.live("w4:p6", "wA:p1", "w4:p7")
    h.ok(ai, ["add", "waiting", "Guard v5: approve", "--ask", "go?", "--option", "Go", "--option", "Not now", "--allow-wording"], h.at("wA:p1"))
    h.ok(sfc, ["add", "todo", "sfc card"], h.at("w4:p6"))
    let r = h.pane(sfc, "\x1b[C\r", "w4:p6")
    assert.deepEqual(h.prompts(), [["agent", "prompt", "wA:p1", "Board card 1 (ai · Guard v5: approve): Go"]], "to its owner, not the pane's coordinator")
    assert.equal(h.card(1).sent.to, "ai coordinator (wA:p1)")
    r = h.pane(sfc, "", "w4:p6")
    assert.match(flat(r.stdout), /sent: Go · 12:03 · to ai coordinator \(wA:p1\)/)

    // The owner is gone, and no other ai coordinator runs: the first press warns, the second sends to w4:p6.
    // A new card goes on top of its section, so it is the first one selected.
    h.ok(ai, ["add", "waiting", "Second question", "--option", "Yes", "--allow-wording"], h.at("wA:p1"))
    h.live("w4:p6")
    r = h.pane(sfc, "\x1b[C\r", "w4:p6")
    assert.equal(h.prompts().length, 0)
    assert.match(flat(r.stdout), /no ai coordinator is running: press Yes again to send it to the board's coordinator \(sfc, pane w4:p6\)/)
    r = h.pane(sfc, "\x1b[C\r\r", "w4:p6")
    assert.deepEqual(h.prompts(), [["agent", "prompt", "w4:p6", "Board card 3 (ai · Second question): Yes"]])
    assert.equal(h.card(3).sent.to, "sfc coordinator (w4:p6)")

    // No coordinator at all: couldn't send, nothing sent.
    h.ok(ai, ["add", "waiting", "Third", "--option", "Ok", "--allow-wording"], h.at("wA:p1"))
    h.live()
    r = h.pane(sfc, "\x1b[C\r\r", "w4:p6")
    assert.equal(h.prompts().length, 0)
    assert.match(flat(r.stdout), /couldn't send: no ai coordinator is running; start one there, or use Other…/)

    // The owner gone, another sfc coordinator running: an sfc card goes to it at once.
    h.live("w4:p7")
    h.ok(sfc, ["add", "todo", "x"], h.at("w4:p7"))
    h.ok(sfc, ["add", "waiting", "sfc question", "--option", "Ship", "--allow-wording"], h.at("w4:p6"))
    h.live("w4:p7", "w4:p9")
    r = h.pane(sfc, "\x1b[C\r", "w4:p9")
    assert.deepEqual(h.prompts(), [["agent", "prompt", "w4:p7", "Board card 6 (sfc · sfc question): Ship"]])
  } finally {
    h.done()
  }
})

test("answer: a label (any case), a button's number or free text; routed like a press; --front for another project's coordinator; refused for workers", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.live("w4:p6", "wA:p1")
    h.ok(sfc, ["add", "waiting", "magicwan v343 fleet rollout: approve the waves", "--option", "Go", "--option", "LON only first", "--option", "Not today", "--allow-wording"], h.at("w4:p6"))
    h.ok(ai, ["add", "waiting", "Git access: pick", "--option", "Tokens", "--allow-wording"], h.at("wA:p1"))
    h.ok(sfc, ["front"], h.at("w4:p6"))
    // The front (w4:p6) relays Telegram replies.
    assert.equal(h.ok(sfc, ["answer", "2", "tokens", "--from", "telegram"], h.at("w4:p6")).trim(), "sent to ai coordinator (wA:p1): Tokens")
    assert.deepEqual(h.prompts().at(-1), ["agent", "prompt", "wA:p1", "Board card 2 (ai · Git access: pick): Tokens (from Telegram)"])
    assert.deepEqual([h.card(2).sent.label, h.card(2).sent.from, h.card(2).sent.to], ["Tokens", "telegram", "ai coordinator (wA:p1)"])
    // The front owns card 1: nothing is sent to itself; it acts.
    assert.match(h.ok(sfc, ["answer", "1", "2"], h.at("w4:p6")), /^card 1 is this pane's \(sfc coordinator \(w4:p6\)\): act on it here: LON only first$/m)
    assert.equal(h.prompts().length, 1)
    // Free text, up to 300 characters.
    h.ok(ai, ["add", "waiting", "Free", "--ask", "say", "--allow-wording"], h.at("wA:p1"))
    assert.match(h.ok(sfc, ["answer", "3", "keep as is, thanks"], h.at("w4:p6")), /^sent to ai coordinator \(wA:p1\): keep as is, thanks$/m)
    assert.equal(h.run(sfc, ["answer", "3", "x".repeat(301)], h.at("w4:p6")).status, 2)
    // The ai coordinator is gone: the front gets it only with --front.
    h.live("w4:p6")
    const refused = h.run(sfc, ["answer", "2", "Tokens"], h.at("w4:p6"))
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /no ai coordinator is running; nothing sent\. To send it to the board's coordinator \(sfc, pane w4:p6\): add --front/)
    assert.match(h.ok(sfc, ["answer", "2", "Tokens", "--front"], h.at("w4:p6")), /card 2 is this pane's/)
    // Workers never answer; not a Waiting card; not in Herdr.
    const worker = h.run(sfc, ["answer", "1", "Go"], h.at("w4:p51", { SFC_AGENT_ROLE: "worker" }))
    assert.equal(worker.status, 2)
    assert.match(worker.stderr, /answer is the coordinator's; a worker doesn't send answers/)
    h.ok(sfc, ["add", "todo", "not waiting"], h.at("w4:p6"))
    assert.match(h.run(sfc, ["answer", "4", "x"], h.at("w4:p6")).stderr, /isn't waiting on you/)
    assert.match(h.run(sfc, ["answer", "1", "Go"]).stderr, /answer sends through Herdr/)
  } finally {
    h.done()
  }
})

test("front: by default the pane that last opened the board", () => {
  const h = home()
  try {
    const app = h.repo("app")
    writeFileSync(h.fake, JSON.stringify({ agents: [{ pane_id: "w4:p6" }], panes: [{ pane_id: "w4:p6", tab_id: "w4:t1", workspace_id: "w4", cwd: app }] }))
    assert.match(h.ok(app, ["front", "show"]), /no front coordinator: none set, and no pane has opened the board/)
    h.ok(app, ["open"], h.at("w4:p6"))
    assert.equal(h.ok(app, ["front", "show"]).trim(), "w4:p6 (the pane that last opened the board; board.mjs front sets one)")
  } finally {
    h.done()
  }
})

test("ls and json: this project's cards and the ones this pane owns by default; --project P, --project all", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.ok(sfc, ["add", "todo", "sfc one"])
    h.ok(ai, ["add", "todo", "ai one"])
    h.ok(sfc, ["add", "todo", "ai card the sfc coordinator owns", "--project", "ai-config"], h.at("w4:p6"))
    const mine = h.ok(sfc, ["ls", "--width", "80"])
    assert.match(mine, /^Job board · sfc-integration/m)
    assert.match(mine, /sfc one/)
    assert.doesNotMatch(mine, /ai one/)
    assert.match(mine, /^\+2 open cards in other projects: board\.mjs ls --project all$/m)
    assert.match(h.ok(sfc, ["ls", "--width", "80"], h.at("w4:p6")), /ai card the sfc coordinator owns/, "owned by this pane")
    assert.match(h.ok(sfc, ["ls", "--width", "80", "--project", "ai"]), /ai one/)
    assert.match(h.ok(sfc, ["ls", "--width", "80", "--project", "all"]), /^Job board · all projects/m)
    const json = JSON.parse(h.ok(sfc, ["json"]))
    assert.deepEqual([json.version, json.scope, json.items.map((i) => i.id)], [2, "sfc-integration", [1]])
    assert.ok(json.projects["ai-config"], "projects come along")
    assert.equal(JSON.parse(h.ok(sfc, ["json", "--project", "all"])).items.length, 3)
    assert.equal(h.run(sfc, ["json", "--project", "nope"]).status, 2)
  } finally {
    h.done()
  }
})

test("hooks: the reminder shows this coordinator's Waiting cards and counts the others; Stop isn't satisfied by another coordinator's write", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.ok(sfc, ["add", "waiting", "sfc question"], h.at("w4:p6"))
    h.ok(ai, ["add", "waiting", "ai question"], h.at("wA:p1"))
    h.ok(sfc, ["add", "waiting", "ai card owned by sfc's pane", "--project", "ai-config"], h.at("w4:p6"))
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w4:p6", HOME: h.base }
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: sfc, prompt: "hi" }
    const text = JSON.parse(handle(prompt, env).stdout).hookSpecificOutput.additionalContext
    assert.match(text, /#1 "sfc question"; #3 "ai card owned by sfc's pane"\./)
    assert.doesNotMatch(text, /ai question/)
    assert.match(text, /\+1 waiting in other projects \(not yours; the board shows them\)\./)
    // Stop: the reply asks something; only the ai coordinator wrote a Waiting card meanwhile.
    h.ok(ai, ["add", "waiting", "another ai question"], h.at("wA:p1"))
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: sfc, stop_hook_active: false, last_assistant_message: "Built it.\n\nShip it now?" }
    assert.equal(JSON.parse(handle(stop, env).stdout).decision, "block", "another coordinator's card doesn't count")
    // The pure pieces.
    const state = { items: [{ id: 1, project: "a", column: "waiting", updated: "x" }, { id: 2, project: "b", column: "waiting", updated: "y" }] }
    const turn = snapshot(state)
    const mineA = (i) => i.project === "a"
    assert.equal(waitingTouched({ items: [...state.items, { id: 3, project: "b", column: "waiting", updated: "z" }] }, turn, mineA), false)
    assert.equal(waitingTouched({ items: [...state.items, { id: 3, project: "a", column: "waiting", updated: "z" }] }, turn, mineA), true)
    assert.equal(reminder({ items: [{ id: 2, project: "b", column: "waiting", title: "t" }] }, "/b", mineA), "Job board: +1 waiting in other projects (not yours; the board shows them).")
    assert.equal(typeof mineOf, "function")
  } finally {
    h.done()
  }
})

test("sidebar: each workspace counts its own cards; only the workspaces whose text changed are reported; token reports every one", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.live("w4:p6", "wA:p1")
    const reports = () => h.log().filter((a) => a[0] === "workspace" && a[1] === "report-metadata").map((a) => [a[2], a.slice(5).join(" ")])
    h.ok(sfc, ["add", "waiting", "sfc q"], h.at("w4:p6"))
    h.ok(ai, ["add", "todo", "ai todo"], h.at("wA:p1"))
    // The sfc coordinator starts an ai job in workspace w4: counted in w4 (where it runs) and in wA (ai's).
    h.ok(sfc, ["job-start", "guard", "--project", "ai-config"], h.at("w4:p6"))
    const state = h.state()
    assert.equal(tokenFor(state, null, "w4"), "1 doing · 1 needs you")
    assert.equal(tokenFor(state, null, "wA"), "1 doing · 1 to do")
    // Each write reported only what changed: w4 twice (q, then the job), wA twice (its todo, then the job).
    // (Reported without waiting: two in one write may land in either order.)
    assert.deepEqual(reports().slice(0, 2), [
      ["w4", "--token board=1 needs you"],
      ["wA", "--token board=1 to do"],
    ])
    assert.deepEqual(reports().slice(2).sort(), [
      ["w4", "--token board=1 doing · 1 needs you"],
      ["wA", "--token board=1 doing · 1 to do"],
    ])
    // A write that changes nothing in a workspace's count: only the writer's own is reported again.
    h.ok(sfc, ["edit", "1", "--desc", "more words"], h.at("w4:p6"))
    assert.deepEqual(reports().slice(4), [["w4", "--token board=1 doing · 1 needs you"]])
    // `token`: every workspace, and this one's text printed.
    assert.equal(h.ok(sfc, ["token"], h.at("w4:p6")).trim(), "1 doing · 1 needs you")
    assert.equal(reports().length, 7)
  } finally {
    h.done()
  }
})

test("an empty HOME is refused (the store and the migration would land in the current folder); plugins beside HERDR_CONFIG_PATH count as installed", () => {
  const h = home()
  try {
    const app = h.repo("app")
    for (const bad of ["", "relative/home"]) {
      const r = h.run(app, ["add", "todo", "x"], { HOME: bad })
      assert.equal(r.status, 1, bad)
      assert.match(r.stderr, /HOME is (empty|"relative\/home", not an absolute path): set HOME \(or JOB_BOARD_HOME\) so the board isn't put in the current folder/)
    }
    assert.ok(!existsSync(join(app, ".local")), "nothing in the repo")
    // Herdr told to use another config file: its plugins folder is beside it.
    const config = join(h.base, "herdr-config", "config.toml")
    const installed = join(h.base, "herdr-config", "plugins", "github", "herdr-job-board-abc")
    mkdirSync(installed, { recursive: true })
    const env = { HOME: h.base, JOB_BOARD_PROTECT: h.base, XDG_CONFIG_HOME: join(h.base, "x") }
    assert.match(writeRefusal(join(h.store, "board.json"), env, { version: "0.5.0", scripts: installed }), /isn't the installed plugin/)
    assert.equal(writeRefusal(join(h.store, "board.json"), { ...env, HERDR_CONFIG_PATH: config }, { version: "0.5.0", scripts: installed }), "")
  } finally {
    h.done()
  }
})

test("orphans: an unowned card re-tagged to a project with no coordinator is the front's: its reminder lists it, ls shows it, editing it claims it, and Stop counts it", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    h.repo("ai-config")
    // A person (no Herdr) wrote the cards: nobody owns them. Card 2 was re-tagged to ai-config.
    h.ok(sfc, ["add", "todo", "sfc card"])
    h.ok(sfc, ["add", "waiting", "Git access on the LXC: narrower tokens instead of Touch-ID: pick", "--ask", "pick one", "--allow-wording"])
    h.ok(sfc, ["retag", "2", "ai-config"])
    assert.deepEqual([h.card(2).project, h.card(2).origin], ["ai-config", ""])
    // The sfc coordinator (w4:p6) opened the board: it is the front; no ai-config coordinator runs.
    h.live("w4:p6")
    h.ok(sfc, ["front"], h.at("w4:p6"))
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w4:p6", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: h.fake, HOME: h.base }
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: sfc, prompt: "hi" }
    assert.match(JSON.parse(handle(prompt, env).stdout).hookSpecificOutput.additionalContext, /#2 "Git access on the LXC/)
    assert.match(h.ok(sfc, ["ls", "--width", "100"], h.at("w4:p6")), /Git access on the LXC/)
    // Another pane, not the front: only counted.
    assert.doesNotMatch(JSON.parse(handle(prompt, { ...env, HERDR_PANE_ID: "w4:p7" }).stdout).hookSpecificOutput.additionalContext, /#2/)
    // The coordinator works on it and asks the user: the edit claims it, and Stop doesn't block.
    h.ok(sfc, ["edit", "2", "--ask", "tokens or Touch-ID?", "--project", "ai-config"], h.at("w4:p6"))
    assert.equal(h.card(2).origin, "w4:p6")
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: sfc, stop_hook_active: false, last_assistant_message: "Tokens or Touch-ID?" }
    assert.equal(handle(stop, env).stdout, "")
    // A live ai-config coordinator appears: the card is its project's again for everyone but its owner.
    h.ok(h.repo("ai-config-2"), ["ls"])
  } finally {
    h.done()
  }
})

test("Stop counts a card this pane changed this turn, even one it doesn't own; import --retag gives unowned cards to the importing coordinator", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.live("w4:p6", "wA:p1")
    h.ok(ai, ["add", "waiting", "ai question"], h.at("wA:p1"))
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w4:p6", HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: h.fake, HOME: h.base }
    handle({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: sfc, prompt: "hi" }, env)
    h.ok(sfc, ["edit", "1", "--ask", "now?", "--project", "ai-config", "--allow-wording"], h.at("w4:p6"))
    assert.equal(h.card(1).by, "w4:p6")
    assert.equal(h.card(1).origin, "wA:p1", "owned by its live coordinator: not claimed")
    assert.equal(handle({ hook_event_name: "Stop", session_id: "s2", cwd: sfc, stop_hook_active: false, last_assistant_message: "Now?" }, env).stdout, "")

    // import --retag by a coordinator: the re-tagged unowned card is its.
    const h2 = home()
    try {
      const s2 = h2.repo("sfc-integration")
      h2.repo("ai-config")
      const legacyFile = join(s2, ".git", "job-board.json")
      writeFileSync(legacyFile, JSON.stringify({ version: 1, next_id: 205, items: [{ id: 204, title: "Git access", column: "waiting", created: "2026-10-18T09:00:00.000Z", since: "2026-10-18T09:00:00.000Z", updated: "2026-10-18T09:00:00.000Z" }] }))
      h2.ok(s2, ["import", "--retag", "204=ai-config"], h2.at("w4:p6"))
      assert.deepEqual([h2.card(204).project, h2.card(204).origin], ["ai-config", "w4:p6"])
    } finally {
      h2.done()
    }
  } finally {
    h.done()
  }
})

test("routing only reaches a coordinator: a job's worker in an owner's pane, a gone front", () => {
  const state = {
    front: "w4:p6",
    panes: { "w4:t1": { pane: "w4:p9", origin: "w8:p1", at: "2026-10-19T11:00:00Z" } },
    projects: { s: { tag: "sfc" } },
    coordinators: { "w4:p6": { project: "s", seen: "a" } },
    items: [{ id: 1, project: "s", origin: "w4:p6", job: "usage-redesign" }],
  }
  // The owner's pane now runs the job "usage-redesign" (a worker): not a coordinator.
  const viaWorker = routeAnswer(state, state.items[0], [{ pane_id: "w4:p6", name: "usage-redesign" }, { pane_id: "w8:p1" }])
  assert.equal(viaWorker.pane, "w8:p1", "the front (w4:p6) isn't live as a coordinator: the newest live opener")
  assert.equal(frontOf(state, new Set(["w8:p1"])), "w8:p1")
  assert.equal(frontOf(state, new Set(["w4:p6", "w8:p1"])), "w4:p6")
  assert.equal(frontOf(state), "w4:p6", "without a list, as set")
})

test("sidebar after a Herdr restart: every workspace is reported again; and again after 10 minutes", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    const ai = h.repo("ai-config")
    h.live("w4:p6", "wA:p1")
    const socket = join(h.base, "herdr.sock")
    writeFileSync(socket, "")
    const at = (pane) => h.at(pane, { HERDR_SOCKET_PATH: socket })
    const reports = () => h.log().filter((a) => a[1] === "report-metadata").map((a) => a[2])
    h.ok(sfc, ["add", "waiting", "q"], at("w4:p6"))
    h.ok(ai, ["add", "todo", "t"], at("wA:p1"))
    assert.deepEqual(reports(), ["w4", "wA"])
    h.ok(sfc, ["edit", "1", "--desc", "x"], at("w4:p6"))
    assert.deepEqual(reports().slice(2), ["w4"], "the writer's own only")
    // Herdr restarted: a new socket. Every workspace's token is reported again.
    rmSync(socket)
    writeFileSync(socket, "")
    h.ok(sfc, ["edit", "1", "--desc", "y"], at("w4:p6"))
    assert.deepEqual(reports().slice(3).sort(), ["w4", "wA"])
    // Reported long ago: again.
    const kept = JSON.parse(readFileSync(join(h.store, "tokens.json"), "utf8"))
    kept.at.wA = "2026-01-01T00:00:00.000Z"
    writeFileSync(join(h.store, "tokens.json"), JSON.stringify(kept))
    h.ok(sfc, ["edit", "1", "--desc", "z"], at("w4:p6"))
    assert.deepEqual(reports().slice(5).sort(), ["w4", "wA"])
  } finally {
    h.done()
  }
})

test("answer: a bare number past the last button is refused; json says how many cards it hides", () => {
  const h = home()
  try {
    const sfc = h.repo("sfc-integration")
    h.live("w4:p6")
    h.ok(sfc, ["add", "waiting", "Pick", "--option", "A", "--option", "B", "--allow-wording"], h.at("w4:p6"))
    const r = h.run(sfc, ["answer", "1", "3"], h.at("w4:p6"))
    assert.equal(r.status, 2)
    assert.match(r.stderr, /card 1 has 2 buttons; 3 is none of them/)
    h.ok(h.repo("other"), ["add", "todo", "elsewhere"])
    assert.equal(JSON.parse(h.ok(sfc, ["json"])).hidden, 1)
  } finally {
    h.done()
  }
})

test("open from a plain shell pane: it opens the board but can't take answers; front and the routing note say which pane and why", () => {
  const h = home()
  try {
    const app = h.repo("app")
    // wS:p1 is a plain shell (no agent); the only agent is a job's worker elsewhere.
    writeFileSync(h.fake, JSON.stringify({ agents: [{ name: "build", pane_id: "wS:p9", workspace_id: "wS" }], panes: [{ pane_id: "wS:p1", tab_id: "wS:t1", workspace_id: "wS", cwd: app }] }))
    h.ok(app, ["add", "waiting", "Pick", "--option", "Go", "--job", "build", "--allow-wording"])
    h.ok(app, ["open"], h.at("wS:p1"))
    assert.equal(h.ok(app, ["front", "show"], h.at("wS:p1")).trim(), "(no front coordinator: the pane that last opened the board (wS:p1) runs no coordinator; board.mjs front, from a coordinator's pane, sets one)")
    const state = h.state()
    const r = routeAnswer(state, state.items[0], [{ name: "build", pane_id: "wS:p9" }], { fallback: "wS:p1" })
    assert.match(r.error, /no app coordinator is running; start one there, or use Other… \(no front coordinator: the pane that last opened the board \(wS:p1\) runs no coordinator; board\.mjs front, from a coordinator's pane, sets one\)/)
    // A front that is set but gone says that instead.
    assert.match(routeAnswer({ ...state, front: "wS:p7" }, state.items[0], [], {}).error, /the front coordinator \(wS:p7\) isn't running/)
  } finally {
    h.done()
  }
})

test("a coordinator's project is its own pane's (Herdr's agent list), not the folder a command runs in", () => {
  const h = home()
  try {
    const one = h.repo("one")
    const two = h.repo("two")
    writeFileSync(h.fake, JSON.stringify({ agents: [{ pane_id: "wF:p1", workspace_id: "wF", cwd: two, interactive_ready: true }, { pane_id: "wA:p1", workspace_id: "wA", cwd: one, interactive_ready: true }] }))
    // Two's coordinator (wF:p1) writes from one's folder.
    h.ok(one, ["add", "waiting", "Two's question", "--project", "two", "--option", "Go", "--allow-wording"], h.at("wF:p1"))
    assert.equal(h.state().coordinators["wF:p1"].project, "two")
    assert.equal(h.state().projects.two.workspace, "wF")
    // So an answer to its card names it right.
    assert.match(h.ok(one, ["answer", "1", "Go"], h.at("wA:p1")), /^sent to two coordinator \(wF:p1\): Go$/m)
    // Herdr can't say where the pane works (not in the list): the project it was noted with stays.
    writeFileSync(h.fake, JSON.stringify({ agents: [] }))
    h.ok(one, ["add", "todo", "x", "--project", "two"], h.at("wF:p1"))
    assert.equal(h.state().coordinators["wF:p1"].project, "two")
  } finally {
    h.done()
  }
})
