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
  assert.equal(reportProof(done({ ids: { commit: "a" }, tested: "yes" })).text, 'unverified: its "tested" is neither a test run nor "read-only"')
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
  // A question that also holds a secret still waits on the user, with its words hidden.
  const asking = stopMessage("fix", { ...stop, last_assistant_message: `I pushed with ${FAKE.token}. Should I merge the login fix now?` }, null)
  assert.equal(asking.state, "waiting")
  assert.equal(asking.text.includes(FAKE.token), false)
})

// --- review fixes ------------------------------------------------------------------------------

// Markdown an agent writes around a key and its value, built at runtime like FAKE.
const MARKDOWN = {
  backticks: ["The DB pass", "word: `", "Xk29fLq8w", "`"].join(""),
  bold: ["**pass", "word**: ", "Xk29fLq8w"].join(""),
  envName: ["- `API_TO", "KEN`=", "q8w7e6r5t4y3"].join(""),
  underscores: ["__pass", "word__: ", "Xk29fLq8w"].join(""),
  colonInBold: ["**DB pass", "word:** ", "Xk29fLq8w"].join(""),
  colonInBackticks: ["`pass", "word:` ", "Xk29fLq8w"].join(""),
  colonInItalics: ["_pass", "word:_ ", "Xk29fLq8w"].join(""),
}
const BARE = ["Xk29fLq8w", "q8w7e6r5t4y3"]

// Ordinary text that names where a secret is kept, or something else entirely: never refused.
const FINE = [
  "keys moved; the deploy token is in 1Password: Service-Accounts-Vault",
  "Read it from arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:release-notes-manager/app-AbCdEf",
  "CI needs the repo secret: ANTHROPIC_API_KEY set before the deploy.",
  "The proxy config reads api_key: os.environ/ANTHROPIC_API_KEY.",
  ["The AWS docs example key AK", "IAIOSFODNN7EXAMPLE is in the test fixture."].join(""),
  "the reset token=4f2a91c link works now",
  "password: DB_PASSWORD_PROD in 1Password",
  "token: 2026-11-04 expiry",
  "Bearer auth/v2/endpoints for the API",
  "firmware token=fw8.5.1s024",
  "secret: release-notes-manager",
  "secret: prod/db-credentials",
  "the Slack token: see vars.SLACK_TOKEN in the repo settings, and secret: secrets.DEPLOY_KEY",
  'const token = "readTokenFromKeychain(name)" in the setup script',
  "password: DB_PASSWORD_PROD, rotated 2026-11-04",
  "**Token:** expired, **Secret:** see 1Password, **API key:** ANTHROPIC_API_KEY",
  "`password:` see the vault",
  "it reads HIDDEN_SECRET : input.last_assistant_message, and password = config.db_password",
  "Deploy token: 1Password (Dev vault)",
  "**API token:** 1Password, vault Dev",
  "1Password: Service-Accounts-Vault, 1Password: op://Dev/deploy/token",
  ["access_key: AK", "IAIOSFODNN7EXAMPLE"].join(""),
  "Read it from arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db/Pw-Xy12Ab",
  'A card reaches the pane, the coordinator and Telegram: leave the secret out and say where it is kept ("the deploy token in 1Password"). --allow-wording doesn\'t change this.',
]

test("secretsIn: a key and value inside markdown (backticks, bold, an env name) is a secret; a soft hyphen or zero-width space can't hide one", () => {
  assert.deepEqual(secretsIn(MARKDOWN.backticks), ["a password"])
  assert.deepEqual(secretsIn(MARKDOWN.bold), ["a password"])
  assert.deepEqual(secretsIn(MARKDOWN.envName), ["a token"])
  assert.deepEqual(secretsIn(MARKDOWN.underscores), ["a password"])
  for (const t of [MARKDOWN.colonInBold, MARKDOWN.colonInBackticks, MARKDOWN.colonInItalics]) assert.deepEqual(secretsIn(t), ["a password"], t)
  // A lower-case name is only a name after a bare "secret:"; after "passphrase" it is the secret.
  assert.deepEqual(secretsIn(["pass", "phrase: ", "correct-horse-battery-staple"].join("")), ["a password"])
  assert.deepEqual(secretsIn(["client_", "secret: ", "correct-horse-battery-staple"].join("")), ["a secret"])
  const [head, tail] = [FAKE.github.slice(0, 20), FAKE.github.slice(20)]
  assert.deepEqual(secretsIn(`Rotate ${head}­${tail}: do it`), ["a GitHub token"])
  assert.deepEqual(secretsIn(`Rotate ${head}​${tail}`), ["a GitHub token"])
  // An AWS key that isn't the documented example is still one.
  assert.deepEqual(secretsIn(FAKE.aws), ["an AWS access key"])
})

// A key=value right after ":" or after "1Password:" is still read (only an ARN's ":secret:" is skipped).
const AFTER_COLON = {
  npmrc: ["Add //registry.npmjs.org/:_auth", "Token=npm_", "Ab3dE6gH9jKm2nP5qR8sT1vW4yZ7aC0eF3hJ"].join(""),
  github: ["//npm.pkg.github.com/:_auth", "Token=", "Ab3dE6gH9jKm2nP5qR8sT1vW4yZ7aC0eF3hJ6kL9"].join(""),
  stored: ["Stored in 1Password: pass", "word=Xk29fLq8w"].join(""),
  env: ["env:DB_PASS", "WORD=Xk29fLq8w"].join(""),
  label: ["label:pass", "word=Xk29fLq8w"].join(""),
}

test("secretsIn: a key right after a colon or after \"1Password:\" is read (.npmrc auth lines, env:, label:)", () => {
  assert.deepEqual(secretsIn(AFTER_COLON.npmrc), ["a token"])
  assert.deepEqual(secretsIn(AFTER_COLON.github), ["a token"])
  assert.deepEqual(secretsIn(AFTER_COLON.stored), ["a password"])
  assert.deepEqual(secretsIn(AFTER_COLON.env), ["a password"])
  assert.deepEqual(secretsIn(AFTER_COLON.label), ["a password"])
  // The CLI refuses it, and the Stop hook hides it.
  const s = setup()
  try {
    s.ok("add", "doing", "Package publish: set up", "--desc", "Publish the package to the registry.")
    const before = s.hash()
    for (const args of [["edit", "1", "--desc", `${AFTER_COLON.npmrc} to .npmrc`], ["now", "1", AFTER_COLON.stored]]) {
      const r = s.run(...args)
      assert.equal(r.status, 2, `${args[0]}: ${r.stderr}`)
      assert.equal(s.hash(), before)
    }
  } finally {
    s.done()
  }
  const token = AFTER_COLON.npmrc.split("=").at(-1)
  const said = stopMessage("fix", { hook_event_name: "Stop", last_assistant_message: `${AFTER_COLON.npmrc} to .npmrc` }, null).text
  for (const v of [token, token.replace(/_/g, "")]) assert.equal(said.includes(v), false, said)
})

// Values the id and name exemptions used to let through (0.19.0): a passphrase in capitals, a
// password with a version inside it, 8 to 12 hex after a secret's key.
const LOOK_LIKE_IDS = [
  ["pass", "word: ", "XKCDHORSE", "BATTERYSTAPLE"],
  ["pass", "word: ", "Hunt3", ".14-love"],
  ["pass", "word: ", "Pw1.2", "Secret-9"],
  ["pass", "word: ", "deadbeef", "42"],
  ["tok", "en=", "ab12cd", "34ef"],
  ["tok", "en=", "7d3658ba", "4126"],
].map((parts) => parts.join(""))

test("secretsIn: a capitals-only passphrase, a password shaped like a version and 8 to 12 hex are secrets; a real version, git's short hash and a variable's name are not", () => {
  for (const t of LOOK_LIKE_IDS) assert.equal(secretsIn(t).length, 1, t)
  for (const t of ["firmware token=fw8.5.1s024", "token: v2.0.0-rc.1", "token: 1.2.3-beta.2", "token: 1.0.0+build.5", "api key: node18.2", "the reset token=4f2a91c link", "secret: DEPLOYTOKEN", "password: GITHUB_TOKEN"]) assert.deepEqual(secretsIn(t), [], t)
  // Read in time linear in the value, however its dots and marks repeat.
  const started = Date.now()
  for (const v of [`1.${"2.".repeat(40000)}!`, `1.2${"-1".repeat(40000)}!`, `1.2-rc${".1".repeat(40000)}!`]) secretsIn(`password: ${v}`)
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`)
})

test("secretsIn: where a secret is kept, an ARN, a variable name, a reference, the AWS example key, a short hash, a date, a version and the refusal's own advice are fine", () => {
  for (const t of FINE) assert.deepEqual(secretsIn(t), [], t)
})

test("secretsIn: many matches take time in proportion to the text (no overlap check per match)", () => {
  const many = `${FAKE.password} `.repeat(55000)
  const started = Date.now()
  assert.deepEqual(secretsIn(many), ["a password"])
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms for 1 MB of matches`)
})

test("the CLI refuses a secret in markdown or split by a format character, and takes ordinary text about where one is kept", () => {
  const s = setup()
  try {
    s.ok("add", "doing", "Staging DB: set up", "--desc", "The staging database for the login tests.")
    const before = s.hash()
    for (const args of [
      ["edit", "1", "--desc", `${MARKDOWN.backticks} (rotate it).`],
      ["now", "1", MARKDOWN.bold],
      ["edit", "1", "--title", `Rotate ${FAKE.github.slice(0, 20)}­${FAKE.github.slice(20)}: do it`, "--allow-wording"],
    ]) {
      const r = s.run(...args)
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`)
      assert.equal(s.hash(), before)
      for (const v of [...BARE, FAKE.github.slice(20)]) assert.equal(r.stderr.includes(v), false)
    }
    for (const t of FINE) {
      const r = s.run("now", "1", t, "--allow-wording")
      assert.notEqual(r.status, 2, `${t}: ${r.stderr}`)
      assert.doesNotMatch(r.stderr, /looks like it holds a secret/, t)
    }
  } finally {
    s.done()
  }
})

test("the Stop hook never puts a bare secret in the inbox after it tidies the markdown away", () => {
  for (const said of Object.values(MARKDOWN)) {
    for (const message of [stopMessage("fix", { hook_event_name: "Stop", last_assistant_message: `Set up staging. ${said}` }, null), stopMessage("fix", { hook_event_name: "Stop", last_assistant_message: `Set up staging. ${said} Should I rotate it now?` }, null), stopMessage("fix", { hook_event_name: "Stop", last_assistant_message: said }, { status: "done", summary: "" })]) {
      for (const v of BARE) assert.equal(message.text.includes(v), false, message.text)
      assert.ok(message.text.includes(HIDDEN_SECRET), message.text)
    }
  }
  // Ordinary words about where a secret is kept are shown as written.
  assert.equal(stopMessage("fix", { hook_event_name: "Stop", last_assistant_message: FINE[0] }, null).text, `[job finished] fix — no report yet — ${FINE[0]}`)
})

test("reportProof: 'n/a', 'none', 'read only' or any other words without a commit or PR say nothing; a list of runs; a command as a list of words", () => {
  const done = (extra) => ({ status: "done", summary: "Compared.", ...extra })
  const ok = { command: "npm test", exit: 0, after_last_edit: true }
  for (const tested of ["n/a", "none", "read only", "readonly", "Read Only", false, 0, [], ["npm test"]]) assert.equal(reportProof(done({ tested })), null, JSON.stringify(tested))
  // "read only" in any spelling is read-only even with a PR named (a review job names the PR it read).
  for (const tested of ["read only", "readonly"]) assert.equal(reportProof(done({ tested, ids: { pr: 3 } })), null, tested)
  // With a commit or PR, words that aren't a run are no proof.
  for (const tested of ["n/a", "none", false]) assert.equal(reportProof(done({ tested, ids: { pr: 3 } })).text, 'unverified: its "tested" is neither a test run nor "read-only"', JSON.stringify(tested))
  assert.equal(reportProof(done({ tested: [], ids: { pr: 3 } })).text, "unverified: no test run after the last edit")
  // Several runs: verified when all passed after the last edit, else the first that didn't.
  assert.deepEqual(reportProof(done({ ids: { pr: 3 }, tested: [{ ...ok, command: "npm run lint" }, ok] })), { ok: true, text: "tested (npm run lint and 1 more, exit 0)" })
  assert.equal(reportProof(done({ ids: { pr: 3 }, tested: [{ ...ok, command: "npm run lint" }, { ...ok, exit: 1 }] })).text, "unverified: the test run failed (npm test, exit 1)")
  // A command as a list of words reads as one; any other non-text command is none.
  assert.deepEqual(reportProof(done({ tested: { ...ok, command: ["npm", "test"] } })), { ok: true, text: "tested (npm test, exit 0)" })
  assert.equal(reportProof(done({ tested: { ...ok, command: { run: "npm test" } } })).text, "unverified: no test command in its report")
  assert.equal(reportProof(done({ tested: { ...ok, command: ["npm", 1] } })).text, "unverified: no test command in its report")
})

test("job-report: a report applied before the upgrade (a 0.17.0 key) is unchanged on a re-run, and a card closed since stays closed", () => {
  const s = setup()
  try {
    const hash16 = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)
    // What 0.17.0 wrote: "r2-" over path, column, ask, summary, held, the question; no proof.
    const asIn017 = (id, column, ask, summary) => {
      const state = JSON.parse(readFileSync(s.file, "utf8"))
      const item = state.items.find((i) => i.id === id)
      const old = `r2-${hash16([item.report, column, ask, summary, ""])}`
      for (const key of Object.keys(state.reports)) if (key === item.reported) delete state.reports[key]
      state.reports[old] = { id, at: "2026-11-03T10:00:00.000Z" }
      item.reported = old
      delete item.proof
      writeFileSync(s.file, JSON.stringify(state))
    }
    // A review job's question, read-only: Waiting, then closed by the coordinator.
    const review = join(s.base, "review.json")
    s.ok("job-start", "review", "--title", "Login fix: review", "--report", review)
    const ask = "Merge the login fix now or wait for QA?"
    writeFileSync(review, JSON.stringify({ status: "done", summary: "Reviewed it.", needs_user: [ask], tested: "read-only" }))
    s.ok("job-report", "review")
    assert.equal(s.card(1).column, "waiting")
    s.ok("done", "1")
    asIn017(1, "waiting", ask, "Reviewed it.")
    // A job with its proof: Done, and the coordinator wrote its own status line since.
    const fix = join(s.base, "fix.json")
    s.ok("job-start", "fix", "--title", "Export fix: build", "--report", fix)
    writeFileSync(fix, JSON.stringify({ status: "done", summary: "Fixed the export.", ids: { commit: "abc1234" }, tested: { command: "npm test", exit: 0, after_last_edit: true } }))
    s.ok("job-report", "fix")
    asIn017(2, "done", "", "Fixed the export.")
    s.ok("now", "2", "merged and installed")
    const before = s.hash()
    const notes = readInbox(s.file).messages.length
    // The upgrade: the same unchanged reports again.
    for (const [slug, id] of [["review", 1], ["fix", 2]]) {
      // As a watcher runs it (quiet), then by hand.
      const quiet = s.ok("job-report", slug, "--if-final")
      assert.equal(quiet.stderr, "")
      assert.equal(s.hash(), before, slug)
      const r = s.ok("job-report", slug)
      assert.match(r.stdout, new RegExp(`^${id} unchanged \\(done\\)`), r.stdout)
      assert.equal(r.stderr, "")
    }
    assert.equal(s.card(1).column, "done")
    assert.equal(s.card(2).now.text, "merged and installed")
    assert.equal(s.hash(), before)
    assert.equal(readInbox(s.file).messages.length, notes)
    // A rewrite after the upgrade still applies.
    writeFileSync(fix, JSON.stringify({ status: "done", summary: "Fixed the export and its test.", ids: { commit: "abc1235" }, tested: { command: "npm test", exit: 0, after_last_edit: true } }))
    assert.doesNotMatch(s.ok("job-report", "fix").stdout, /unchanged/)
    assert.match(s.card(2).reported, /^r3-/)
  } finally {
    s.done()
  }
})

test("details agree with the row: a card applied before 0.18.0 says nothing of its tests; a Doing card says what its report says", () => {
  const s = setup()
  try {
    const path = join(s.base, "old.json")
    s.ok("job-start", "old", "--title", "Docs fix: build", "--report", path)
    writeFileSync(path, JSON.stringify({ status: "done", summary: "Fixed the docs.", ids: { pr: 12 } }))
    s.ok("job-report", "old")
    assert.equal(s.card(1).proof.ok, false)
    // As 0.17.0 left it: no proof on the card.
    const state = JSON.parse(readFileSync(s.file, "utf8"))
    delete state.items[0].proof
    writeFileSync(s.file, JSON.stringify(state))
    const now = new Date("2026-11-04T10:00:00Z")
    const text = render(buildView(readBoard(s.file), null, { now }), { width: 120, color: false, now, layout: "wide", scroll: { doneOpen: true } })
    assert.doesNotMatch(text.split("\n").find((l) => l.includes("Docs fix: build")) || "", /unverified/)
    assert.doesNotMatch(plain(detailLines(s.card(1), 100).lines).join("\n"), /Unverified|Tested after/)
    // A Doing card whose report isn't applied yet: the report's own, as on its row.
    s.ok("job-start", "next", "--title", "Search fix: build", "--report", s.report)
    s.write({ status: "done", summary: "Fixed the search.", ids: { pr: 13 } })
    const view = buildView(readBoard(s.file), null, { now })
    const entry = view.doing.find((e) => e.title === "Search fix: build")
    assert.equal(entry.reportProof.ok, false)
    assert.match(plain(detailLines(entry, 100).lines).join("\n"), /Unverified: no test run after the last edit\./)
  } finally {
    s.done()
  }
})
