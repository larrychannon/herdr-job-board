// Run: node --test (from the repo root)
// The wording check: card text the user reads on its own (no PR, build or commit numbers, no
// version strings; a Waiting question with 2 to 4 buttons, one suggested; labels a verb plus the
// thing), refused by add, edit, move to Waiting and job-start, kept off the card by job-report,
// and listed by lint. Each board lives in a temp folder; the user's board is never read.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { answerLabels, cardWording, detailLines, labelProblems, numberedIn, readBoard, readInbox } from "../board.mjs"

const BOARD = fileURLToPath(new URL("../board.mjs", import.meta.url))
const plain = (lines) => lines.map((l) => l.map((s) => s.t).join("").trimEnd())

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-wording-")))
  const base = join(root, "app")
  mkdirSync(base)
  spawnSync("git", ["-C", base, "init", "-q"])
  const store = join(root, "store")
  const env = { ...process.env, HERDR_ENV: "0", JOB_BOARD_FILE: "", JOB_BOARD_HOME: store, HOME: root, JOB_BOARD_NOW: "2026-10-29T10:00:00Z", TZ: "UTC", NO_COLOR: "1" }
  const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { cwd: base, env, encoding: "utf8" })
  const ok = (...args) => {
    const r = run(...args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    return r
  }
  const file = join(store, "board.json")
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex")
  const card = (id) => readBoard(file).items.find((i) => i.id === id)
  return { base, run, ok, file, hash, card, done: () => rmSync(root, { recursive: true, force: true }) }
}

const BUTTONS = ["--option", "Merge the login fix", "--option", "Wait for the review", "--suggest", "Merge the login fix"]

test("numberedIn: PR, build and # numbers, commit hashes, versions and approval numbers; links, card numbers and addresses are fine", () => {
  const found = (t) => numberedIn(t).map((n) => `${n.text} = ${n.what}`)
  assert.deepEqual(found("Review and merge PR #83, then deploy, to fix production"), ["PR #83 = a PR number"])
  assert.deepEqual(found("PR #83 (build 674)"), ["PR #83 = a PR number", "build 674 = a build number"])
  assert.deepEqual(found("#161 (7f96574, build 378)"), ["build 378 = a build number", "#161 = a number with #", "7f96574 = a commit hash"])
  assert.deepEqual(found("pull request 12 and merge request 4"), ["pull request 12 = a PR number", "merge request 4 = a PR number"])
  assert.deepEqual(found('Reply "58, merge it"'), ["58 = a number for the thing to approve"])
  assert.deepEqual(found("install 0.7.0, then v8.5.1."), ["0.7.0 = a version string", "v8.5.1 = a version string"])
  // Not a number for a thing.
  assert.deepEqual(found("#325 then #325 again"), ["#325 = a number with #"], "each number once")
  for (const t of ["card 373 and card #373", "the brief: /tmp/claude-0/-root-work/d89a46e1-912a-491f-a7ca-130a5f27b64a/scratchpad/brief.md", "in ~/work/notes/7f96574a.md and ./out/abc1234f", "https://github.com/a/b/pull/83 and https://x.example/c/commit/7f96574abc", "ping 10.0.0.1", "defaced, effaced", "2026-10-29 at 10:30", "Move the 6 to history", "3.5 days"]) {
    assert.deepEqual(numberedIn(t), [], t)
  }
})

test("labelProblems: a verb plus the thing, in full words, one decision", () => {
  const why = (l) => labelProblems(l).map((p) => p.why)
  // The labels the user had to ask back about.
  assert.deepEqual(why("Go"), ["one word"])
  assert.deepEqual(why("Hold"), ["one word"])
  assert.deepEqual(why("Only SFC + RNM"), ["a symbol for a word"])
  assert.deepEqual(why("Archive the 6, next"), ['"next", "then" or "continue"'])
  assert.deepEqual(why("Merge #158"), ["a number with #"])
  assert.deepEqual(why("Go steps 3–5"), ["a step number"])
  assert.deepEqual(why("1P key, start"), ["a code of letters and digits"])
  assert.deepEqual(why("Redraw as M3"), ["a code of letters and digits"])
  assert.deepEqual(why("Only A and C"), ["an option letter"])
  // The ones pressed without a question.
  for (const l of ["Move the 6 to history", "Deploy with agent key", "Pause the tidy-up", "Close it for me", "Only the 2 biggest notes", "Merge the 2nd fix"]) assert.deepEqual(why(l), [], l)
})

test("add: a Waiting question needs 2 to 4 buttons, one suggested, and words, not numbers; nothing is written when refused", () => {
  const s = setup()
  try {
    s.ok("add", "todo", "Login page: fix the error message")
    const before = s.hash()
    // The real cases: an ask with a PR number and no buttons; an approval keyed by a number.
    let r = s.run("add", "waiting", "Workbench fix: merge", "--ask", "Review and merge PR #83, then deploy, to fix production")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /card 2 is not in plain words yet, so nothing was written/)
    assert.match(r.stderr, /the ask says "PR #83", a PR number: name the thing instead/)
    assert.match(r.stderr, /its buttons: no answer buttons: a Waiting card with a question needs 2 to 4, one suggested/)
    assert.match(r.stderr, /--allow-wording/)
    assert.equal(s.hash(), before, "nothing written")
    r = s.run("add", "waiting", "Vault rules: merge", "--ask", 'Say "58, merge it"', ...BUTTONS)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the ask says "58", a number for the thing to approve/)
    // Labels like "Go / Only SFC + RNM / Hold", and two buttons with none suggested.
    r = s.run("add", "waiting", "Tidy the notes: pick one", "--ask", "Tidy which notes now?", "--option", "Go", "--option", "Only SFC + RNM", "--option", "Hold", "--suggest", "Go")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the button "Go" says "Go", one word/)
    assert.match(r.stderr, /the button "Only SFC \+ RNM" says "\+", a symbol for a word/)
    assert.match(r.stderr, /the button "Hold" says "Hold", one word/)
    r = s.run("add", "waiting", "Login fix: merge", "--ask", "Merge the login fix now?", "--option", "Merge the login fix", "--option", "Wait for the review")
    assert.match(r.stderr, /its buttons: no suggested answer/)
    r = s.run("add", "waiting", "Login fix: merge", "--ask", "Merge the login fix now?", "--option", "Merge the login fix", "--suggest", "Merge the login fix")
    assert.match(r.stderr, /its buttons: one answer button/)
    // A description full of numbers ("#161 (7f96574, build 378)"): each one named.
    r = s.run("add", "todo", "Node health: deploy", "--desc", "Merged #161 (7f96574, build 378).")
    assert.equal(r.status, 2)
    for (const bad of ['"#161", a number with #', '"7f96574", a commit hash', '"build 378", a build number']) assert.ok(r.stderr.includes(`the description says ${bad}`), bad)
    assert.equal(s.hash(), before, "still nothing written")

    // Plain words, one question, buttons: written.
    s.ok("add", "waiting", "Login fix: merge", "--desc", "The sign-in page shows the real error. Pull request: https://github.com/a/b/pull/83", "--ask", "Merge the login fix now?", ...BUTTONS)
    // A Waiting card without a question yet, and other columns, need no buttons.
    s.ok("add", "waiting", "Release notes: read")
    // A version in a description only warns: there it is often the thing itself.
    r = s.ok("add", "todo", "Firmware release notes: review", "--desc", "Customers on firmware 8.5.1 see the new cellular settings.")
    assert.match(r.stderr, /card \d+: the description says "8\.5\.1", a version string: .*a warning: written as it is/)
    assert.equal(readBoard(s.file).items.length, 4)
  } finally {
    s.done()
  }
})

test("edit and move: the card as it is left is checked; a job-report card can't stay without buttons once touched", () => {
  const s = setup()
  try {
    const report = join(s.base, "report.json")
    s.ok("job-start", "workbench", "--title", "Workbench fix: build", "--report", report)
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Built and tested.", needs_user: ["Merge the Workbench fix and deploy it"] }))
    s.ok("job-report", "workbench")
    assert.equal(s.card(1).column, "waiting")
    // Rewriting only the title (what the coordinator used to do) leaves a question with no
    // buttons: refused, as is a second button without a suggested one.
    const before = s.hash()
    let r = s.run("edit", "1", "--title", "Workbench fix: merge and deploy")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /its buttons: no answer buttons/)
    r = s.run("edit", "1", "--option", "Merge and deploy it", "--option", "Wait until Monday")
    assert.match(r.stderr, /no suggested answer/)
    assert.equal(s.hash(), before)
    s.ok("edit", "1", "--title", "Workbench fix: merge and deploy", "--ask", "Merge the Workbench fix and deploy it to production?", "--option", "Merge and deploy it", "--option", "Wait until Monday", "--suggest", "Merge and deploy it")
    assert.deepEqual(s.card(1).options, [{ label: "Merge and deploy it", suggested: true }, { label: "Wait until Monday" }])
    // Clearing the buttons of a card that asks: refused.
    assert.equal(s.run("edit", "1", "--clear-options").status, 2)

    // move … waiting takes its buttons in the same command.
    s.ok("add", "todo", "Cost page: approve")
    r = s.run("move", "2", "waiting", "--ask", "Ship the new Cost page?")
    assert.equal(r.status, 2)
    assert.equal(s.card(2).column, "todo")
    s.ok("move", "2", "waiting", "--ask", "Ship the new Cost page?", "--option", "Ship the Cost page", "--option", "Keep the old page", "--suggest", "Ship the Cost page")
    assert.equal(s.card(2).column, "waiting")
    // Out of Waiting the question goes: nothing to check.
    s.ok("move", "2", "todo")
  } finally {
    s.done()
  }
})

test("job-start and --allow-wording: refused titles, an explicit escape the card remembers, until the text changes", () => {
  const s = setup()
  try {
    let r = s.run("job-start", "review", "--title", "Review PR #31")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the title says "PR #31", a PR number/)
    assert.equal(readBoard(s.file).items.length, 0)
    s.ok("job-start", "review", "--title", "Login fix: review")

    r = s.ok("add", "waiting", "Firmware 8.5.1 notes: approve", "--ask", "Publish the 8.5.1 notes?", "--option", "Publish the notes", "--option", "Hold the notes", "--suggest", "Publish the notes", "--allow-wording")
    assert.match(r.stderr, /written with --allow-wording, although the title says "8\.5\.1"/)
    assert.equal(s.card(2).wording_ok.length, 2)
    // An edit of something else keeps what was allowed; a new number is refused again.
    s.ok("edit", "2", "--desc", "The release notes for the next firmware.")
    r = s.run("edit", "2", "--desc", "See PR #90.")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the description says "PR #90"/)
    assert.doesNotMatch(r.stderr, /8\.5\.1/, "the allowed text isn't listed again")
    // Lint leaves allowed text alone.
    assert.equal(s.run("lint").status, 0)
    // Fixed: the card forgets the allowance.
    s.ok("edit", "2", "--title", "Firmware notes: approve", "--ask", "Publish the firmware notes?")
    assert.equal(s.card(2).wording_ok, undefined)
  } finally {
    s.done()
  }
})

test("job-report: a needs_user or summary with numbers stays off the card; the coordinator is told, once", () => {
  const s = setup()
  try {
    const report = join(s.base, "report.json")
    s.ok("job-start", "workbench", "--title", "Workbench fix: build", "--report", report)
    // The real case: the ask was "Review and merge PR #83, then deploy, to fix production".
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Fixed the export. PR #83 (build 674).", needs_user: ["Review and merge PR #83, then deploy, to fix production"] }))
    const r = s.ok("job-report", "workbench")
    const card = s.card(1)
    assert.equal(card.column, "waiting")
    assert.equal(card.ask, "The job needs a decision from you: its coordinator is writing the question in plain words.")
    assert.equal(card.options, undefined)
    assert.match(r.stdout, /ask: The job needs a decision from you/)
    assert.doesNotMatch(r.stdout, /#83/)
    assert.match(r.stderr, /card 1 \(Workbench fix: build\) is waiting on the user with the job's own words and no answer buttons\. Its report names "PR #83", "build 674": kept off the card/)
    assert.match(r.stderr, /board\.mjs edit 1 --title .* --option .* --suggest/)
    const notes = readInbox(s.file).messages
    assert.equal(notes.length, 1)
    assert.equal(notes[0].kind, "note")
    assert.equal(notes[0].card, 1)
    assert.match(notes[0].text, /^\[job note\] workbench — card 1 .* no answer buttons\./)
    // The same report again: nothing changes, nothing more is sent.
    assert.match(s.ok("job-report", "workbench").stdout, /1 unchanged/)
    assert.equal(readInbox(s.file).messages.length, 1)

    // The details panel: the summary and need with numbers are not shown up top.
    const panel = plain(detailLines(s.card(1), 100).lines).join("\n")
    assert.doesNotMatch(panel.split("▸ More…")[0], /#83|674/)
    assert.match(panel, /Its summary names PR, build or commit numbers, so it is under More… only\./)
    assert.match(panel, /One more need names PR, build or commit numbers: under More…/)
    const more = plain(detailLines(s.card(1), 100, { more: true }).lines).join("\n")
    assert.match(more, /Full summary\n {2}Fixed the export\. PR #83 \(build 674\)\./)

    // A plain report is copied as before, and the coordinator still hears it needs buttons.
    s.ok("job-start", "qa", "--title", "Workbench fix: test")
    writeFileSync(report, JSON.stringify({ status: "blocked", summary: "The staging server is down." }))
    const blocked = s.ok("job-report", "qa", report)
    assert.equal(s.card(2).ask, "blocked: The staging server is down.")
    assert.match(blocked.stderr, /card 2 .* no answer buttons\. Rewrite it in one edit/)
    assert.doesNotMatch(blocked.stderr, /kept off/)
    // Done with a numbered summary: the card stays done; the coordinator is asked for a description.
    s.ok("job-start", "docs", "--title", "Docs links: fix")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Merged as PR #90." }))
    const finished = s.ok("job-report", "docs", report)
    assert.equal(s.card(3).column, "done")
    assert.match(finished.stderr, /card 3 \(Docs links: fix\) is done\. Its report names "PR #90": kept off the card/)
    // Done in plain words: nothing to say.
    s.ok("job-start", "tidy", "--title", "Notes: tidy")
    writeFileSync(report, JSON.stringify({ status: "done", summary: "Tidied the notes." }))
    assert.equal(s.ok("job-report", "tidy", report).stderr, "")
    assert.equal(readInbox(s.file).messages.length, 3)
  } finally {
    s.done()
  }
})

test("lint: lists every open card that fails, with each fix; read-only; exit 1 when one must be fixed", () => {
  const s = setup()
  try {
    s.ok("add", "todo", "Login page: fix the error message")
    assert.match(s.ok("lint").stdout, /all 1 open card pass the wording check/)
    // Old cards, written before the check (or by hand): as on the live board.
    const state = readBoard(s.file)
    const at = "2026-10-29T09:00:00Z"
    const base = { project: state.items[0].project, origin: "", workspace: "", job: "", created: at, since: at, updated: at, desc: "" }
    state.items.push(
      { ...base, id: 2, title: "Workbench fix: merge", column: "waiting", ask: "Review and merge PR #83, then deploy, to fix production", order: 0 },
      { ...base, id: 3, title: "Search export: approve", column: "waiting", ask: "Approve the search export?", order: 1 },
      { ...base, id: 4, title: "Firmware notes", column: "todo", ask: "", desc: "For firmware 8.5.1.", order: 2 },
      { ...base, id: 5, title: "Old PR #12", column: "done", ask: "", order: 3 },
    )
    state.next_id = 6
    writeFileSync(s.file, JSON.stringify(state))
    const before = s.hash()
    const r = s.run("lint")
    assert.equal(r.status, 1)
    assert.equal(s.hash(), before, "lint writes nothing")
    const out = r.stdout
    assert.match(out, /^card 2 \(waiting on you · \S+\): Workbench fix: merge\n {2}fix  the ask says "PR #83", a PR number: .*\n {2}fix  its buttons: no answer buttons/m)
    assert.match(out, /^card 3 \(waiting on you · \S+\): Search export: approve\n {2}fix  its buttons: no answer buttons/m)
    assert.match(out, /^card 4 \(to do · \S+\): Firmware notes\n {2}warn the description says "8\.5\.1", a version string/m)
    assert.doesNotMatch(out, /card 5/, "Done cards are not listed")
    assert.match(out, /2 of 4 open cards fail the wording check \(1 more with a warning only\)/)
    assert.equal(s.run("lint", "--project", "nope").status, 2)
    assert.equal(s.run("lint", "extra").status, 2)
  } finally {
    s.done()
  }
})

test("cardWording: what a stored card shows is what is checked (buttons as stored, Waiting only)", () => {
  const problems = (item) => cardWording(item).map((p) => `${p.field}: ${p.why}`)
  assert.deepEqual(problems({ id: 1, title: "A", column: "todo", ask: "Merge it?" }), [])
  assert.deepEqual(problems({ id: 1, title: "A", column: "waiting", ask: "Merge it?", options: [{ label: "Merge it now" }, { label: "Wait a day", suggested: true }] }), [])
  assert.deepEqual(problems({ id: 1, title: "A", column: "waiting", ask: "Merge it?", options: [{ label: "Go", suggested: true }, { label: "Wait a day" }] }), ['button "Go": one word'])
})

test("answerLabels: the labels of an \"Each answer:\" list, whichever separator the line uses", () => {
  assert.deepEqual(answerLabels("What: x\n\nEach answer:\n- Close this card: drop the idea.\n- Keep it open: you still want it."), ["Close this card", "Keep it open"])
  assert.deepEqual(answerLabels("Each answer:\n- It works → I close this.\n- Something's wrong → tell me what"), ["It works", "Something's wrong"])
  assert.deepEqual(answerLabels("Each answer:\n- Move the 6 to history = I move them.\n- Keep them\nThen: the next note."), ["Move the 6 to history", "Keep them"])
  assert.deepEqual(answerLabels("Each answer: Check headroom = a job. No = nothing."), [], "an inline sentence isn't a list")
  assert.deepEqual(answerLabels("No list here.\n- Close this card: x"), [])
})

test("Each answer: a list naming buttons the card no longer has: edit refused naming the label, lint warns; buttons and list changed together pass", () => {
  const s = setup()
  try {
    const desc = "What: make every press count as typing.\n\nEach answer:\n- Close this card: drop the idea.\n- Keep it open: you still want it."
    s.ok("add", "waiting", "Typed press idea: close or keep", "--desc", desc, "--ask", "Close this idea?", "--option", "Close this card", "--option", "Keep it open", "--suggest", "Close this card")
    // The buttons change, the list doesn't: refused, the old label named, nothing written.
    const before = s.hash()
    let r = s.run("edit", "1", "--option", "Drop the typed press", "--option", "Keep it open", "--suggest", "Drop the typed press")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the description says "Close this card", its "Each answer:" list names a button the card doesn't have: make the description's "Each answer:" list name the buttons as they are now, one line each \("Drop the typed press", "Keep it open"\), as "- <label>: …", "- <label> = …" or "- <label> → …", in the same edit as the buttons/)
    assert.match(r.stderr, /the button "Drop the typed press": it has no line in the description's "Each answer:" list/)
    assert.equal(s.hash(), before)
    // An edit of only the description that drops a button's line: refused too.
    r = s.run("edit", "1", "--desc", "What: x.\n\nEach answer:\n- Close this card: drop the idea.")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /the button "Keep it open": it has no line/)
    // Buttons and list changed in one edit: written.
    s.ok("edit", "1", "--option", "Drop the typed press", "--option", "Keep it open", "--suggest", "Drop the typed press", "--desc", "What: x.\n\nEach answer:\n- Drop the typed press: the idea goes.\n- Keep it open: you still want it.")
    assert.deepEqual(s.card(1).options.map((o) => o.label), ["Drop the typed press", "Keep it open"])
    // A card with a list and no buttons isn't checked.
    s.ok("add", "todo", "Notes tidy-up: plan", "--desc", "Each answer:\n- Archive them: x.")
    // A list gone stale on the stored card (written before the check): lint warns, exit 0.
    const state = readBoard(s.file)
    state.items[0].options = [{ label: "Drop the typed press", suggested: true }, { label: "Wait until Monday" }]
    writeFileSync(s.file, JSON.stringify(state))
    const hash = s.hash()
    r = s.run("lint")
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^ {2}warn the description says "Keep it open", its "Each answer:" list names a button the card doesn't have/m)
    assert.match(r.stdout, /^ {2}warn the button "Wait until Monday": it has no line/m)
    assert.match(r.stdout, /0 of 2 open cards fail the wording check \(1 more with a warning only\)/)
    assert.equal(s.hash(), hash, "lint writes nothing")
    // --allow-wording lets it through, as for any other problem.
    s.ok("edit", "1", "--title", "Typed press idea: drop or wait", "--allow-wording")
  } finally {
    s.done()
  }
})

test("Each answer: lists that do match the buttons pass, whatever their dash, quotes or bold; a line for any answer is no button's; a refusal names the forms read", () => {
  const s = setup()
  try {
    const buttons = ["--option", "Merge it now", "--option", "Ship it: today", "--suggest", "Merge it now"]
    s.ok("add", "waiting", "Login fix: merge", "--ask", "Merge the login fix?", ...buttons)
    for (const list of [
      "- Merge it now — I merge it.\n- Ship it: today – it goes out today.",
      '- "Merge it now": I merge it.\n- "Ship it: today": it goes out today.',
      "- **Merge it now**: I merge it.\n- **Ship it: today** = it goes out today.\n- Either way: you get a note.",
    ]) {
      const r = s.run("edit", "1", "--desc", `What: the login fix.\n\nEach answer:\n${list}`)
      assert.equal(r.status, 0, `${list}\n${r.stderr}`)
    }
    assert.deepEqual(answerLabels("Each answer:\n- **Merge it now**: x\n- Either way: y", ["Merge it now"]), ["Merge it now"])
    const r = s.run("edit", "1", "--desc", "Each answer:\n- Merge it now: x\n- Ship it tomorrow: y")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /as "- <label>: …", "- <label> = …" or "- <label> → …"/)
  } finally {
    s.done()
  }
})
