// Run: node --test (from the repo root)
// Test proof and the secret screen (0.18.0). A job that changed files says in its report which
// test it ran after its last edit ("tested"); a done report with a commit or PR and no such run
// shows as unverified on its card, never blocking. No card carries a secret: add, edit, move,
// now, job-start, not-run and tell refuse one (exit 2, naming the field and the kind, never the
// text; --allow-wording doesn't change it); job-report hides it and tells the coordinator.
// Every fake secret is built at runtime, so nothing secret-shaped is in this file. Each board
// lives in a temp folder; the user's board is never read.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { HIDDEN_SECRET, buildView, commandSecrets, detailLines, readBoard, readInbox, render, reportProof, reportStatusLine, screenReport, secretsIn } from "../board.mjs"
import { stopMessage } from "../hooks/board-hook.mjs"

const BOARD = fileURLToPath(new URL("../board.mjs", import.meta.url))
const plain = (lines) => lines.map((l) => l.map((s) => s.t).join("").trimEnd())

// Fake secrets, assembled here so no literal in the repo looks like one.
const rep = (s, n) => s.repeat(n)
const FAKE = {
  github: ["gh", "p_", rep("a1B2c3D4e5", 4)].join(""),
  githubPat: ["github", "_pat_", rep("A1b2C3d4E5", 6)].join(""),
  anthropic: ["sk", "-ant-", "api03-", rep("Zx9Yw8Vu7T", 4)].join(""),
  aws: ["AK", "IA", "QWERTYUIOP123456"].join(""),
  slack: ["xo", "xb-", "1234567890-", rep("abcDEF", 4)].join(""),
  slackHook: ["https://hooks.", "slack.com/services/", "T0000000/B0000000/", rep("Xy", 12)].join(""),
  telegram: ["1234567", "89:", "AA", rep("Hk3_q", 7)].join(""),
  bearer: ["Authorization: Bear", "er ", rep("eyJ0eXAi0", 3)].join(""),
  privateKey: ["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
  password: ["pass", "word=", "hunter2", "2x"].join(""),
  token: ["DEPLOY_", "TOKEN=", "q8w7e6r5t4y3"].join(""),
  secret: ["client_", "secret: ", '"', "Zq81", "Lm27Pw", '"'].join(""),
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-proof-")))
  const base = join(root, "app")
  mkdirSync(base)
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(root, "store")
  const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HOME: root, JOB_BOARD_NOW: "2026-11-04T10:00:00Z", TZ: "UTC", NO_COLOR: "1" }
  delete env.JOB_AGENT_ROLE
  const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
  const ok = (...args) => {
    const r = run(...args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex")
  const card = (id) => readBoard(file).items.find((i) => i.id === id)
  const report = join(base, "report.json")
  const write = (r) => writeFileSync(report, JSON.stringify(r))
  return { base, run, ok, file, hash, card, report, write, done: () => rmSync(root, { recursive: true, force: true }) }
}

test("secretsIn: each kind of secret, by kind only; hashes, UUIDs, placeholders, references, paths and prose are fine", () => {
  const kinds = (t) => secretsIn(t)
  assert.deepEqual(kinds(`push with ${FAKE.github}`), ["a GitHub token"])
  assert.deepEqual(kinds(FAKE.githubPat), ["a GitHub token"])
  assert.deepEqual(kinds(`key ${FAKE.anthropic}`), ["an Anthropic API key"])
  assert.deepEqual(kinds(`id ${FAKE.aws}`), ["an AWS access key"])
  assert.deepEqual(kinds(FAKE.slack), ["a Slack token"])
  assert.deepEqual(kinds(`post to ${FAKE.slackHook}`), ["a Slack webhook"])
  assert.deepEqual(kinds(`bot ${FAKE.telegram}`), ["a Telegram bot token"])
  assert.deepEqual(kinds(`https://api.telegram.org/bot${FAKE.telegram}/sendMessage`), ["a Telegram bot token"])
  assert.deepEqual(kinds(FAKE.bearer), ["a bearer token"])
  assert.deepEqual(kinds(`${FAKE.privateKey}\nMIIE…`), ["a private key"])
  assert.deepEqual(kinds(`log in with ${FAKE.password}`), ["a password"])
  assert.deepEqual(kinds(`export ${FAKE.token}`), ["a token"])
  assert.deepEqual(kinds(FAKE.secret), ["a secret"])
  assert.deepEqual(kinds(`https://x.example/hook?${["tok", "en=", "a1b2c3d4e5f6"].join("")}`), ["a token"])
  assert.deepEqual(kinds(`${FAKE.github} and ${FAKE.password}`), ["a GitHub token", "a password"])
  // A token inside a key=value is one secret, of its own kind.
  assert.deepEqual(kinds(`GITHUB_TOKEN=${FAKE.github}`), ["a GitHub token"])
  for (const t of [
    "commit 7f96574abc7f96574abc7f96574abc7f96574abc",
    `token=${"7f96574abc".repeat(4)}`,
    "session 123e4567-e89b-12d3-a456-426614174000",
    "token=123e4567-e89b-12d3-a456-426614174000",
    "password=${DB_PASSWORD} and token=$GH_TOKEN and secret=$(op read x)",
    "api_key: <your key> and token=<token> and password=****",
    "password: op://Private/github/password and token=op://vault/item/field",
    "secret=/run/secrets/db and token=~/.config/gh/hosts.yml and key in ./secrets/x",
    "the token in 1Password, a bearer token, the password: see the vault",
    "max_tokens=4096 and token_count=12345678 and tokens: 900000",
    "secret: rotated, token: expired, password=",
    "Bearer ${TOKEN} and Bearer <token>",
    "/root/.ssh/id_ed25519 and ~/.aws/credentials",
    "PR #83 merged, build 674, version 1.2.3",
  ]) assert.deepEqual(kinds(t), [], t)
})

test("commandSecrets: every flag and the positional text a command writes; never the text", () => {
  assert.deepEqual(commandSecrets("add", ["todo", `Deploy with ${FAKE.github}`], { desc: "plain words" }), [{ field: "the title", kinds: ["a GitHub token"] }])
  assert.deepEqual(commandSecrets("edit", ["4"], { option: ["Merge it", FAKE.password] }), [{ field: "a button", kinds: ["a password"] }])
  assert.deepEqual(commandSecrets("now", ["4", FAKE.token], {}), [{ field: "the status line", kinds: ["a token"] }])
  assert.deepEqual(commandSecrets("tell", [FAKE.slack], {}), [{ field: "the note", kinds: ["a Slack token"] }])
  assert.deepEqual(commandSecrets("not-run", ["4"], { run: `curl -H "${FAKE.bearer}"` }), [{ field: "the command to run", kinds: ["a bearer token"] }])
  assert.equal(JSON.stringify(commandSecrets("add", ["todo", FAKE.github], {})).includes(FAKE.github), false)
})

test("add, edit, move, now, job-start, not-run and tell refuse a secret: exit 2, the field and the kind, never the text; --allow-wording doesn't change it", () => {
  const s = setup()
  try {
    s.ok("add", "doing", "Login page fix: build", "--desc", "The login page fails on Safari.")
    const before = s.hash()
    const refused = (args, field, kind) => {
      for (const extra of [[], ["--allow-wording"]]) {
        if (extra.length && ["not-run", "tell"].includes(args[0])) continue
        const r = s.run(...args, ...extra)
        assert.equal(r.status, 2, `${args[0]}: ${r.stderr}`)
        assert.match(r.stderr, /looks like it holds a secret, so nothing was written/)
        assert.ok(r.stderr.includes(`${field} holds what looks like ${kind}`), r.stderr)
        assert.match(r.stderr, /--allow-wording doesn't change this/)
        for (const v of Object.values(FAKE)) {
          assert.equal(r.stderr.includes(v), false, `${args[0]} echoed the secret`)
          assert.equal(r.stdout.includes(v), false)
        }
        assert.equal(s.hash(), before, `${args[0]} wrote the board`)
      }
    }
    refused(["add", "todo", `Rotate ${FAKE.github}`], "the title", "a GitHub token")
    refused(["add", "todo", "Deploy: run", "--desc", `Use ${FAKE.anthropic} to call it`], "the description", "an Anthropic API key")
    refused(["edit", "1", "--desc", `Then: log in with ${FAKE.password}`], "the description", "a password")
    refused(["edit", "1", "--title", `Bot: ${FAKE.telegram}`], "the title", "a Telegram bot token")
    refused(["move", "1", "waiting", "--ask", `Use ${FAKE.token}?`, "--option", "Use the token", "--option", "Wait for a new one", "--suggest", "Use the token"], "the question", "a token")
    refused(["edit", "1", "--option", FAKE.slack, "--option", "Wait"], "a button", "a Slack token")
    refused(["now", "1", `deployed with ${FAKE.aws}`], "the status line", "an AWS access key")
    refused(["job-start", "fix", "--title", "Login fix: build", "--desc", FAKE.privateKey], "the description", "a private key")
    refused(["not-run", "1", "--run", `curl -H "${FAKE.bearer}" https://x.example`], "the command to run", "a bearer token")
    refused(["tell", `the hook is ${FAKE.slackHook}`], "the note", "a Slack webhook")
    // Placeholders and references are fine.
    s.ok("edit", "1", "--desc", "Then: log in with password=${DB_PASSWORD} from op://Private/db/password")
  } finally {
    s.done()
  }
})

test("reportProof: tested, unverified (missing with a commit or PR, a failed run, a run before the last edit, unreadable), read-only, older reports", () => {
  const done = (extra) => ({ status: "done", summary: "Fixed it.", ...extra })
  const ok = { command: "npm test", exit: 0, after_last_edit: true }
  assert.deepEqual(reportProof(done({ ids: { commit: "abc1234" }, tested: ok })), { ok: true, text: "tested (npm test, exit 0)" })
  assert.deepEqual(reportProof(done({ ids: { commit: "abc1234" } })), { ok: false, text: "unverified: no test run after the last edit" })
  assert.deepEqual(reportProof(done({ ids: { pr: 12 } })), { ok: false, text: "unverified: no test run after the last edit" })
  assert.deepEqual(reportProof(done({ ids: { prs: ["https://x.example/pull/3"] } })).ok, false)
  assert.deepEqual(reportProof(done({ ids: { commit: "a" }, tested: { ...ok, exit: 1 } })), { ok: false, text: "unverified: the test run failed (npm test, exit 1)" })
  assert.deepEqual(reportProof(done({ ids: { commit: "a" }, tested: { ...ok, after_last_edit: false } })), { ok: false, text: "unverified: the test ran before the last edit (npm test)" })
  assert.equal(reportProof(done({ tested: { command: "npm test", exit: 0 } })).ok, false, "after_last_edit missing")
  assert.equal(reportProof(done({ tested: { command: "npm test", exit: "0", after_last_edit: true } })).text, "unverified: no exit code for npm test")
  assert.equal(reportProof(done({ tested: { exit: 0, after_last_edit: true } })).text, "unverified: no test command in its report")
  assert.equal(reportProof(done({ tested: "yes" })).ok, false)
  // A run without a commit or PR still says what it ran.
  assert.equal(reportProof(done({ tested: ok })).ok, true)
  // Read-only, and an older report (no "tested", no commit or PR): nothing to show.
  assert.equal(reportProof(done({ tested: "read-only" })), null)
  assert.equal(reportProof(done({ tested: "Read-Only", ids: { pr: "https://x.example/pull/3" } })), null, "a review job names the PR it read")
  assert.equal(reportProof(done({})), null)
  assert.equal(reportProof(done({ ids: { branch: "feat/x", commit: "", pr: "" } })), null)
  assert.equal(reportProof({ status: "blocked", ids: { commit: "a" } }), null)
  assert.equal(reportProof({ status: "running", ids: { commit: "a" } }), null)
  // A command is cut to fit the status line, and one that looks like a secret is never shown.
  const long = reportProof(done({ tested: { ...ok, command: `node --test ${"tests/a-long-name.test.mjs ".repeat(5)}` } }))
  assert.ok(long.text.length <= 80 && long.text.includes("…"), long.text)
  const hidden = reportProof(done({ tested: { ...ok, command: `GH_TOKEN=${FAKE.github} npm test` } }))
  assert.equal(hidden.text, "tested (the command hidden: it looked like a secret, exit 0)")
  // The status lines.
  assert.equal(reportStatusLine("done", "done", false, { ok: true, text: "tested (npm test, exit 0)" }), "the job finished, tested (npm test, exit 0): its report is ready to check")
  assert.equal(reportStatusLine("done", "waiting", false, { ok: false, text: "unverified: no test run after the last edit" }), "the job finished, unverified: no test run after the last edit, and needs your answer")
  assert.equal(reportStatusLine("done", "done"), "the job finished: its report is ready to check")
})

test("job-report: tested, missing with a commit, a failed run, read-only and an older report; shown on the card, its row and its details, never blocking", () => {
  const s = setup()
  try {
    // Each job its own report file: the details panel reads the card's.
    const report = (slug, title, r) => {
      const path = join(s.base, `${slug}.json`)
      s.ok("job-start", slug, "--title", title, "--report", path)
      writeFileSync(path, JSON.stringify({ status: "done", summary: "Fixed the export.", ...r }))
      return s.ok("job-report", slug)
    }
    // Tested after its last edit.
    let r = report("tested", "Export fix: build", { ids: { commit: "abc1234" }, tested: { command: "npm test", exit: 0, after_last_edit: true } })
    assert.equal(s.card(1).column, "done")
    assert.deepEqual(s.card(1).proof, { ok: true, text: "tested (npm test, exit 0)" })
    assert.equal(s.card(1).now.text, "the job finished, tested (npm test, exit 0): its report is ready to check")
    assert.match(r.stdout, /1 → done: Export fix: build\n {2}tested \(npm test, exit 0\)/)
    assert.equal(r.stderr, "")
    // Missing, with a commit: unverified, and still Done.
    r = report("missing", "Search page fix: build", { ids: { commit: "abc1234", pr: "https://x.example/pull/9" } })
    assert.equal(s.card(2).column, "done")
    assert.deepEqual(s.card(2).proof, { ok: false, text: "unverified: no test run after the last edit" })
    assert.equal(s.card(2).now.text, "the job finished, unverified: no test run after the last edit: its report is ready to check")
    assert.match(r.stdout, /unverified: no test run after the last edit/)
    // A failed run.
    report("failed-run", "Cost page fix: build", { ids: { pr: 14 }, tested: { command: "npm test", exit: 1, after_last_edit: true } })
    assert.equal(s.card(3).proof.text, "unverified: the test run failed (npm test, exit 1)")
    // Read-only, and an older report with no "tested" and no commit: nothing said.
    report("research", "Login options: compare", { tested: "read-only" })
    report("old", "Notes: tidy", {})
    for (const id of [4, 5]) {
      assert.equal(s.card(id).proof, undefined)
      assert.equal(s.card(id).now.text, "the job finished: its report is ready to check")
    }
    // The Done rows: the unverified ones say so.
    const view = buildView(readBoard(s.file), null, { now: new Date("2026-11-04T10:00:00Z") })
    const text = render(view, { width: 120, color: false, now: new Date("2026-11-04T10:00:00Z"), layout: "wide", scroll: { doneOpen: true } })
    const row = (title) => text.split("\n").find((l) => l.includes(title)) || ""
    assert.match(row("Search page fix: build"), /unverified/)
    assert.match(row("Cost page fix: build"), /unverified/)
    for (const t of ["Export fix: build", "Login options: compare", "Notes: tidy"]) assert.doesNotMatch(row(t), /unverified/, t)
    // The details panel says it, with its reason.
    assert.match(plain(detailLines(s.card(2), 100).lines).join("\n"), /Unverified: no test run after the last edit\./)
    assert.match(plain(detailLines(s.card(1), 100).lines).join("\n"), /Tested after its last edit: npm test, exit 0\./)
    assert.doesNotMatch(plain(detailLines(s.card(5), 100).lines).join("\n"), /Tested after|Unverified/)
  } finally {
    s.done()
  }
})

test("job-report: a repeat of an older report is unchanged; a rewrite that adds its proof applies again; a new round clears it; a question shows it", () => {
  const s = setup()
  try {
    s.ok("job-start", "fix", "--title", "Export fix: build", "--report", s.report)
    s.write({ status: "done", summary: "Fixed the export.", ids: { commit: "abc1234" } })
    s.ok("job-report", "fix")
    assert.equal(s.card(1).proof.ok, false)
    assert.match(s.ok("job-report", "fix").stdout, /1 unchanged/)
    // The job adds its proof: the card is verified.
    s.write({ status: "done", summary: "Fixed the export.", ids: { commit: "abc1234" }, tested: { command: "npm test", exit: 0, after_last_edit: true } })
    assert.doesNotMatch(s.ok("job-report", "fix").stdout, /unchanged/)
    assert.equal(s.card(1).proof.ok, true)
    assert.match(s.ok("job-report", "fix").stdout, /1 unchanged/)
    // A new round: no proof until its report.
    s.ok("job-start", "fix", "--id", "1", "--report", s.report)
    assert.equal(s.card(1).proof, undefined)
    // A done report with a question and no proof: Waiting, and its line says unverified.
    s.write({ status: "done", summary: "Built it.", ids: { pr: "https://x.example/pull/4" }, needs_user: ["Merge the export fix now or wait for the review?"] })
    s.ok("job-report", "fix")
    assert.equal(s.card(1).column, "waiting")
    assert.equal(s.card(1).now.text, "the job finished, unverified: no test run after the last edit, and needs your answer")
    const view = buildView(readBoard(s.file), null, { now: new Date("2026-11-04T10:00:00Z") })
    assert.match(render(view, { width: 120, color: false, now: new Date("2026-11-04T10:00:00Z"), layout: "wide" }), /Now: the job finished, unverified/)
  } finally {
    s.done()
  }
})

test("a Doing card whose job's done report has no proof reads \"report done, unverified\" on its row", () => {
  const s = setup()
  try {
    s.ok("job-start", "fix", "--title", "Export fix: build", "--report", s.report)
    s.write({ status: "done", summary: "Fixed the export.", ids: { commit: "abc1234" } })
    const now = new Date("2026-11-04T10:00:00Z")
    const view = buildView(readBoard(s.file), null, { now })
    assert.equal(view.doing[0].reportProof.ok, false)
    assert.match(render(view, { width: 120, color: false, now, layout: "wide" }), /report done, unverified/)
    s.write({ status: "done", summary: "Fixed the export.", ids: { commit: "abc1234" }, tested: { command: "npm test", exit: 0, after_last_edit: true } })
    assert.doesNotMatch(render(buildView(readBoard(s.file), null, { now }), { width: 120, color: false, now, layout: "wide" }), /unverified/)
  } finally {
    s.done()
  }
})

test("screenReport: the summary, needs and notes that hold a secret are hidden in a copy; the fields are named", () => {
  const r = { status: "done", summary: `Pushed with ${FAKE.github}.`, needs_user: [{ ask: "Rotate it?", options: ["Rotate the token", FAKE.password], suggest: "Rotate the token" }], notes: ["plain note", FAKE.slack], ids: { commit: "abc" } }
  const { report, hidden } = screenReport(r)
  assert.deepEqual(hidden, ["summary", "needs_user", "notes"])
  assert.equal(report.summary, HIDDEN_SECRET)
  assert.deepEqual(report.needs_user[0].options, ["Rotate the token", HIDDEN_SECRET])
  assert.deepEqual(report.notes, ["plain note", HIDDEN_SECRET])
  assert.equal(r.summary.includes(FAKE.github), true, "the report itself is not changed")
  assert.deepEqual(screenReport({ status: "done", summary: "Plain." }).hidden, [])
})

test("job-report never refuses a secret: hidden on the card, in the details and in the notes; the coordinator hears which field", () => {
  const s = setup()
  try {
    s.ok("job-start", "fix", "--title", "Export fix: build", "--report", s.report)
    s.write({ status: "done", summary: `Deployed with ${FAKE.github}.`, needs_user: [`Rotate ${FAKE.anthropic} now or keep it?`], notes: [`the hook is ${FAKE.slackHook}`], tested: "read-only" })
    const r = s.ok("job-report", "fix")
    const card = s.card(1)
    assert.equal(card.column, "waiting")
    assert.equal(card.ask, HIDDEN_SECRET)
    const notes = readInbox(s.file).messages
    assert.equal(notes.length, 1)
    assert.match(notes[0].text, /has text that looked like a secret in its summary, needs_user, notes: shown as "\(hidden: looked like a secret\)"/)
    const panel = plain(detailLines(card, 100, { more: true }).lines).join("\n")
    const board = readFileSync(s.file, "utf8")
    const inbox = JSON.stringify(readInbox(s.file))
    for (const v of [FAKE.github, FAKE.anthropic, FAKE.slackHook]) {
      for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["board", board], ["inbox", inbox], ["details", panel]]) assert.equal(text.includes(v), false, `${where} shows the secret`)
    }
    assert.match(panel, /hidden: looked like a secret/)

    // A plain done report with a secret only in its summary still tells the coordinator.
    s.ok("job-start", "docs", "--title", "Docs links: fix", "--report", s.report)
    s.write({ status: "done", summary: `Used ${FAKE.password} to log in.`, tested: "read-only" })
    const d = s.ok("job-report", "docs")
    assert.equal(s.card(2).column, "done")
    assert.match(d.stderr, /card 2 \(Docs links: fix\): job docs's report has text that looked like a secret in its summary/)
    assert.equal(readInbox(s.file).messages.length, 2)
    assert.equal(d.stderr.includes(FAKE.password), false)
    // The same report again: nothing more is sent.
    assert.match(s.ok("job-report", "docs").stdout, /2 unchanged/)
    assert.equal(readInbox(s.file).messages.length, 2)
  } finally {
    s.done()
  }
})

test("the Stop hook's inbox line hides a summary or last message that looks like a secret", () => {
  const stop = { hook_event_name: "Stop", last_assistant_message: `Done. I used ${FAKE.github}.` }
  const finished = stopMessage("fix", stop, { status: "done", summary: `Pushed with ${FAKE.token}` })
  assert.equal(finished.text, `[job finished] fix — done — ${HIDDEN_SECRET}`)
  const none = stopMessage("fix", stop, null)
  assert.equal(none.text, `[job finished] fix — no report yet — ${HIDDEN_SECRET}`)
  assert.equal(stopMessage("fix", { ...stop, last_assistant_message: "Done. Tests pass." }, null).text, "[job finished] fix — no report yet — Done. Tests pass.")
})
