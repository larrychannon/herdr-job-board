# Changelog

## 0.15.0 · unreleased

Queue and start: a card you mark starts without the word check. A job's report never makes a card.

- **Why**: of five cards queued in one evening, four came back as questions, two only because of
  a word in their text (a read-only check that said "live", a title that said "merge" in
  passing). And late job reports made cards titled with the job's short name: one from a check
  job opened by hand (no card carried it), one that came after `job-close` had unlinked the
  job's card.
- **Queue and start**: `s` in a To do card's details, or a click on its new `Queue and start`
  button, puts it in the Queue (last, like `u`) marked **start without asking**. On a queued
  card `s` marks it (`Start without asking`) or takes the mark off (`Ask before starting`). A
  marked card shows `»` before its title and `starts without asking` in the Queue (also in
  `ls`), and its details say `In the Queue for 5 min · starts without asking`. `?` lists `s`.
- **The Stop hook and a marked card**: handed over to start now, without the keyword check, and
  with the same rules (never merge, deploy, release, write live data or change settings, IAM or
  permissions because a card is queued). Still handed over as a question even when marked:
  - any part of the title (split at `: `, ` — `, ` – `, ` - `) that starts with deploy,
    redeploy, merge, release, ship, publish, push, roll out, cut a release, tag, promote, go
    live, delete, drop, purge, wipe or truncate (`Merge: login fix: final tidy`, `App — merge
    the fix`, `Push the fix to main`); release or publish notes are writing and never asked;
  - a title or description that asks for access, IAM, permissions, secrets, credentials, keys,
    settings or DNS, or deletes branches, databases, buckets, records or users (as in 0.14.0);
  - one that destroys data (drop, purge, wipe, truncate, remove, `rm -rf` + tables, buckets,
    backups, data…), force-pushes or `reset --hard`, or mentions ssh or deploy keys, tokens,
    `sudo` or the config for production or live.
  The turn reminder marks such cards `(marked start without asking)`. Marking a card that was
  handed over and didn't start hands it over again. These are keyword checks: the user still
  reads the card before marking it.
- **Only the user sets the mark**: only the pane writes it (`markStart`); no command-line option
  does (`--start` is an unknown option), so neither a job nor the coordinator can. `import` and
  `restore` never bring it in: every card they bring in loses the mark, and a queued one lands in
  To do (only the user queues). A worker can run neither `import` nor `restore <backup>` (exit
  2; listing the backups still works). The mark holds a hash of the card's title, description,
  project and time in the Queue. An edit of the title or description, or a retag, removes it
  for good (an edit back doesn't bring it back), and so does a move out of the Queue. A reorder
  doesn't. Unmarked cards are handed over exactly as in 0.14.0.
- **A report never makes a card** (`job-report`): when no card carries the job, the report goes
  on the card that carried it before (an unlinked card now keeps the old slug in `former_jobs`;
  else the card with the same report file; else the card in the job skill's record of the job,
  `job-skill/jobs/<slug>.json` or its newest `<slug>.closed-*.json`), never on one linked to
  another job since (nor a card from the record that a later job used and was unlinked from). A
  `failed` or `blocked` report reopens that card: Waiting, with the reason as its question (no
  buttons) and the status line `the job failed: it reported after it was closed; read its
  report`, unless open cards under it hold it. Any other report leaves it where it is (a Done
  card stays Done), with the report and the status line `the job reported after it was closed:
  read its report`. Either way the coordinator gets a `[job note]` with the job's status,
  summary, what it asks, and the card. With no such
  card on the board (none at all, or only in the archive), no card is made, not even from the
  archive: the `[job note]` gives the status, summary and report path. A repeat of the same
  report changes nothing and sends no second note.

## 0.14.0 · unreleased

Jobs ask with buttons, cards keep their titles, a press that can't run says so, a card under
a deploy says it waits for the deploy, To do folds like Done, and a Queue the coordinator works
through by itself.

- **Why**: in one day the coordinator got eleven notes to rewrite a job's question before the
  card had buttons; four cards were renamed to their job's short name ("daily-review-1030");
  six presses couldn't run and the card kept the same button while the "type this instead" line
  went to the chat only; and a merged change put under its deploy card printed "#417 now waits
  on #410", the wrong way round.
- **A job's own question** (`job-report`): a report's `needs_user` may be one entry
  `{ "ask": "…", "options": ["…", "…"], "suggest": "…" }`. When it passes the same wording check
  as `add` (2 to 4 labels, a verb plus the thing in 24 characters at most, one suggested, no
  numbers in the ask, no `[board …]` or `[job …]` markers, every option text), the card gets
  that question and its buttons and the coordinator gets no note. Only a `done` report: a
  `blocked` or `failed` one keeps its reason first, without buttons, and the coordinator gets
  the note, so one press can't approve a failed job's work. When it fails, the card gets its
  words as today and the `[job note]` says why, in plain words. Plain text entries work as
  before. A report without such a question keeps its applied-report key.
- **Short-name titles**: the wording check refuses a title that is only a job's short name (one
  lower-case word with dashes, or the card's own job) where a command sets the title: `add`,
  `edit --title`, and a new card from `job-start` (so `job-start <slug>` without `--title` for a
  new card is refused). On a card already titled so it warns, and `lint` warns, so
  `job-start --id` still starts that job's next round.
- **`not-run <ref> --type "<words>" | --run "<command>" [--label L]`**: a press the coordinator
  couldn't carry out. The card goes to Waiting asking `Your press couldn't run this: type "…" in
  the coordinator's chat` (or `run this command: …`), its status line says the same, the pressed
  button is gone (the others stay), and the card and its details show `couldn't run: the "…"
  press · 10:36`. On a card nothing was pressed on yet it asks `A press can't run this: …`, for
  an action the coordinator knows only the user's typed words can do. The literal phrase or
  command isn't checked for numbers. `--label` must name a button of the card or a press on
  record (the card's or the inbox's); a different press still in flight keeps its record. A
  worker can't run it. A new `--ask` or `--option` ends it. `json` shows `not_run`.
- **Labels**: a button label with `[board …]` or `[job …]` (the board's own markers) is refused.
- **Under a deploy**: a card whose parent's title says deploy in its action (after the last
  `: `) says `waits for the deploy on #417 …` (`deployed with #417 … (done)` once done); the
  deploy card says `deploys 2`, `Deploys: …`, and `add`/`edit`/`job-start --parent` print
  `#417 deploys #410, #415`. Any other parent keeps `for #N …` and `waiting on N`: there the
  parent does wait for its parts. The held-report lines of `job-report` follow the same words.
- **To do folds like Done**: the pane starts with TO DO folded to one line, `TO DO · 12 ▸`
  (above `DONE · 3 today ▸`), so Waiting and Doing get the room. `t` or a click on the line opens
  it (`TO DO (12) ▾`, a column beside Doing in the wide layout); `t` or a click on its header
  folds it again. Folded, Tab skips it, and a card that moves into To do doesn't open it; the
  choice holds while the pane runs. `t` used to go to the selected card's job tab from the
  board: it still does in a card's details (`Enter`, then `t`). `ls` shows To do whole, as
  before. The key line and `?` list `t to do`.
- **The Queue**: a column between Doing and To do for To do cards the coordinator starts by
  itself, top first. A To do card's details have `Add to the Queue` (`u`, or a click; a queued
  card's `Back to To do`); `move <ref> queue` and `add queue …` work too. A card goes in last;
  `Shift+↑` `Shift+↓` and `order` reorder it. The pane shows it open while it has cards
  (`QUEUE (3) ▾`, one row a card) and folded while empty (`QUEUE · 0 ▸`); `u` on the board, or a
  click on its line or header, folds or opens it. `ls` shows it whole; the sidebar says
  `3 queued`; `contract` lists the columns.
  - The coordinator's turn reminder lists its queued cards, the room for jobs per repo (the
    repo's `max_active_jobs` against the named agents working in its checkouts, and the host's
    available memory against its `min_free_mb`, the rules of the job skill's mem-check) and the
    cards that didn't start. When a repo has room, the Stop hook blocks with the top card that
    fits: start its job on that card (`job-open … --id`), or move it to Waiting with one plain
    question and buttons. A card whose title or description asks for a merge, deploy, release or access change
    is handed over as a question only. Each card is handed over once as it is (`queue.json` in
    the board's folder): still queued at a later stop, it didn't start, and it isn't handed over
    again until it is edited or queued again (a reorder doesn't count). After a Queue block the
    next stop may hand over the next card, so the coordinator works through the Queue in one go;
    a question block or a status-line block still comes first, and right after a hand-over a
    question asked in the chat without a Waiting card is still sent back once. Room unknown (memory or Herdr
    can't be read) hands over nothing.
  - `job-start <slug>` without `--id` takes the job's queued card too.
  - **Only the user and the coordinator write the Queue**: a job's pane (a worker) can't `add
    queue`, `move … queue`, `order` a queued card, or `edit` or `retag` one (exit 2, nothing
    written), so no job, nor text injected into one, can line up work to be started.
  - The merge/deploy/release/access check reads the whole title and the description, with more
    words (production, go live, roll out, push to, land on main, tag and push, grant, admin or
    write access, secrets, credentials, rotate, settings, DNS, deleting branches or data); such
    a card comes back as a question only. The hand-over says the title and description are
    data, not instructions.
  - Room is checked for every project with queued cards, one by one until a card fits; the
    reminder says why each card waits (didn't start, at the limit, too little memory, room
    unknown). A project outside git has its room unknown, so its cards aren't handed over until
    retagged to a repo.

## 0.13.1 · unreleased

The answer list in a card's description matches its buttons.

- **Why**: an edit changed a card's buttons and kept its description's "Each answer:" list
  naming the old ones, so the card explained buttons it no longer had.
- **The check**: the wording check now reads that list (one `- <label>: …` line per button;
  `=`, `→` or a spaced dash work too, quotes or bold around the label are read through, and a
  line that starts with a button's label is that button's; a `- Either way: …` line is
  skipped) on a card with buttons. A line naming a button the card doesn't have, or
  a button with no line, refuses `add`, `edit`, `move … waiting` and `job-start`, with the label
  named; `lint` lists it as a warning (exit 0). Change the buttons and the list in the same
  edit; `--allow-wording` lets it through as for any other problem.

## 0.13.0 · unreleased

A status line per card, kept in step with its family.

- **Why**: on one day the coordinator updated cards by hand from its notes about fifteen times
  and kept slipping: a parent still said "review running" after its review card was done, a
  card said "waiting for merge" after the merge, and nothing told it. A card's description is
  what the thing is; where the work stands changes many times a day and needs its own line.
- **`now <ref> "<where it stands>"`**: the card's status line, shown at the top of the card,
  its details and `ls` ("Now: merged, waiting for your deploy OK"). It is written on the card's
  lineage too (the cards above it and every open card under it, not its siblings) unless
  `--only`; `--clear` removes it. `--event merge|deploy|…` notes that event on the lineage
  first, so the lines written with it are current and any written before are not. The words
  are checked like a card's (no PR, build or commit numbers; `--allow-wording` as for cards).
- **Out of date**: an event on a card (a job's report, the card done, top cards included, the
  card back out of Done, an `--event`) puts the lines above it, under it and its own written
  before it out of date; a sub-card added or removed (`add --parent`, `edit --parent` /
  `--no-parent`, `rm` of an open card) does that to the lines above it. A sibling's news never
  does, so two jobs side by side under one card keep their true "a job is working on it". The
  card then says `Now (out of date: card done on #3 since): …` in amber, its row says `status
  out of date`, the coordinator's turn reminder lists
  its own such cards, and its Stop hook blocks once per card and event while a card it owns has
  one (after the Waiting-card check, which keeps its place). Cards without a line, and Done
  cards, are never out of date, so boards from before change nothing.
- **job-report** writes the job's card's line itself ("the job finished: its report is ready to
  check", "… needs your answer", "the job is blocked and needs you", "the job failed: read its
  report") and notes a `job report` event on its family.
- A status line or event is not a Waiting card update for the Stop hook's question check.
- **`inbox get <id>`**: one inbox message as JSON, acked or not, so a script can check that a
  board press it was given is a real answer on its card (the job skill's `ship.mjs` does).

## 0.12.0 · unreleased

A job's rounds stay on its card, and its messages reach the coordinator that owns the card;
the board pane's key line moves to the top.

- **Why**: on one busy day seven "job finished" messages went to a workspace no coordinator
  reads, among them a review's "fix first" verdict, which then sat unseen for three hours. Each
  was sent after the wait script had already moved the job's card to Done, and the message only
  looked for open cards. The same day a review wrote a partial `done` ("QA still running") that
  closed its card early, and the real verdict, written over it later, was never applied; a job
  whose card waited on its child check had an FYI turned into the card's question, and another
  round closed the card while the check was still open; and a follow-up round on a Waiting
  card made a second card titled with the job's slug.
- **Messages for a Done card**: a job's stop and its `tell` lines use the job's newest Done card
  changed in the last 24 hours when it has no open one, so they go to that card's owner, with the
  report's status and summary instead of "no report yet". An older Done card is another run's (a
  slug used again later without a card), and isn't used.
- **Messages nobody reads**: the coordinator's turn-start reminder counts the messages not acked
  in a workspace where no coordinator ever wrote to the board (`w8: 7`), with the first few;
  `inbox ls --stray` lists them all, and `inbox ack <id>` acks any of them.
- **A new round on the same card**: `job-start <slug> --id N` puts the round on card N (back to
  Doing, on the new report) and refuses a card linked to another job, so a mistyped number moves
  nothing (`edit N --job <slug>` first when that is meant). Without `--id` it takes the job's
  Waiting card only when the card asks nothing (no question, no buttons, no other `--title`); a
  Waiting card with a question stays the user's, the round gets a new card, and job-start says
  how to use `--id` instead.
- **Rewritten reports apply again**: the outcome a card remembers (`reported`) includes the
  report's summary, so a final report rewritten with a new summary moves the card again, and the
  coordinator gets a `[job note]` with the new summary (the wait that applied the first one has
  ended), even when the card stays Done. Keys written before 0.12.0 (without the summary) still
  count, so a repeat of an old report keeps the coordinator's edits.
- **Cards with open cards under them**: `job-report` never closes such a card, and never puts it
  in Waiting. It stays in Doing (moved there if it was elsewhere) with the report stored on it,
  and the coordinator gets one `[job note]` with the report's status, what it asks, and the
  open cards' ids. Once they are done, the next report applies as usual; the same report run
  again (a restarted wait, a `--once` check) changes nothing, so the coordinator's move stands.
- **`notes`**: a report's FYIs (`"notes": ["…"]`) never become the card's question; the card's
  details show them under "For your information". `needs_user` is for decisions only.
- **The key line at the top**: the pane's key line is drawn right under the title at every
  width, and the pane's last row stays empty. In a terminal that keeps its last row or its
  cursor in view (a phone's, in Collie), a key line at the bottom scrolled the cards at the top
  out of sight; the hidden cursor is now parked on the first row after every frame too. Where
  none of the key line's forms fits, it reads `? keys · q quit`; the new `?` key shows every key
  there, wrapped, until `?` or `Esc`. The board has one row less: the rows below the title move
  down one line, and the bottom one is left empty.

## 0.11.0 · unreleased

The board checks a card's words before it writes them, so a card the user can't read on its
own (a PR or build number instead of the thing's name, a question without answer buttons)
never reaches the board.

- **Why**: the rules for card text were written down many times (no PR, build or commit
  numbers; one plain question with 2 to 4 buttons, one suggested) and still failed, because
  nothing checked them. On one day a Waiting card asked "Review and merge PR #83, then deploy,
  to fix production" (the job's `needs_user`, copied into the ask by `job-report`), two Waiting
  cards had a question and no buttons until the user asked where the suggested answer was, and
  a job's summary "PR #83 (build 674)" showed in the card's details. Before that: "58, merge it"
  as an approval phrase, labels like `Go` / `Only SFC + RNM` / `Hold`, and a description full
  of "#161 (7f96574, build 378)".
- **The check** (`cardWording`): in the title, description, ask and button labels, no PR
  numbers (`PR #83`, `pull request 12`), `#<digits>`, `build <digits>`, commit hashes (7 to 40
  hex characters with a digit and a letter), approvals keyed by a number (`58, merge it`) or
  version strings (`0.7.0`, `v8.5.1`; not a 4-part address). Links and card numbers
  (`card 373`, `card #373`) are fine. A Waiting card with an ask has 2 to 4 buttons, one
  suggested. A label is two words or more, without `+`, `/`, `&`, `next` / `then` /
  `continue`, a step number, an option letter (`Only A and C`) or a code (`1P`, `M3`).
- **Refused or warned**: every problem is refused (exit 2, nothing written, each problem and
  its fix printed), except a version string in a description, which only warns: there it is
  often the thing itself (the firmware a customer runs), while in a title, ask or label it is
  shorthand. `--allow-wording` writes a card that fails anyway; the card keeps the lines it
  allowed (`wording_ok`), so a later edit of something else, and `lint`, leave them alone
  while they are there.
- **Where**: `add`, `edit` (the whole card it leaves, not only the fields it wrote: a card is
  fixed when it is touched), `move … waiting` (which now takes `--option` and `--suggest`, so
  the question and its buttons go in one command) and `job-start`. `done`, `rm`, `order`,
  `retag` and moves out of Waiting are not checked.
- **`job-report` never refuses**: a wait script runs it and shows nobody its output. A
  `needs_user` (or a blocked job's summary) with such numbers stays off the ask, which reads
  "The job needs a decision from you: its coordinator is writing the question in plain words."
  Every card it puts in Waiting (the job's own words, never buttons), and every report whose
  summary names numbers, is also a `[job note]` in the coordinator's inbox (posted to its
  session like any job message) and a line on stderr, naming the card and the one `edit`
  that fixes it. A repeat of the same report sends nothing.
- **The details panel** shows a report summary or need that names numbers under More… only
  ("Its summary names PR, build or commit numbers, so it is under More… only.").
- **`lint [--project P]`**: every open card that fails, each problem with its fix; read-only;
  exit 1 when a card must be fixed. `doctor` says how many fail and points to it.
- Tests: a new `wording.test.mjs` (the matchers on the real failures; add, edit, move and
  job-start refusals with nothing written; `--allow-wording` and what the card remembers;
  `job-report` keeping numbers off the ask and its note, once; the details panel; `lint`
  read-only on old cards). Existing tests whose fixtures are about something else pass
  `--allow-wording` where their cards fail the check; the `job-report` tests use plain words.

## 0.10.1 · unreleased

A job that runs in another Herdr workspace than its coordinator's (its project's) shows its
agent's live state again, and goes to Waiting on you by itself when it is blocked.

- **Why**: jobs now open in their project's workspace (an ai-config job in ai-config's), while
  their card keeps the workspace of the coordinator that wrote it. The board looked for a job's
  agent in the card's workspace only, so such a card said `no agent` while its job was working,
  and a job stuck on a prompt stayed in Doing.
- **A job's agent** (`jobAgent`) is the one with the job's name in the card's workspace first
  (else the board's), as before; when there is none there, the one with that name in any
  workspace. So a namesake elsewhere no longer hides behind `no agent`, and the card's own
  workspace still wins when both run one. The card's state, the move to Waiting on you, the
  details panel, the sidebar count and the turn-start reminder of finished jobs all use it (the
  reminder no longer counts a job working elsewhere as finished).
- **Its tab**: the details panel names the tab from every workspace's tabs (`herdr tab list`
  without `--workspace`), and `t` focuses the pane of the agent the card shows (`herdr agent
  focus <pane>`) rather than an agent of that name.
- Unchanged: a blocked agent that has no card still shows only in its own workspace's board;
  messages and button answers go where they went; the card's `workspace` is still where it was
  written.
- Tests: the namesake test now checks that the card's own workspace wins, and new ones check a
  job in another workspace through `ls` (working, blocked into Waiting, gone), through the pane
  (Waiting, its tab's label, `t` to its pane) and through the reminder.

## 0.10.0 · unreleased

Job messages and button answers are posted into the coordinator's session through Claude Code's
own messaging socket, so the coordinator needs neither the channel nor its development flag.

- **Why**: the channel (0.9.0) is a home-made Claude Code channel, so it only loads with
  `--dangerously-load-development-channels`, and Claude Code asks to confirm that at every
  coordinator start. Claude Code now gives every session a messaging socket that takes messages
  from other sessions and from scripts; tested on 2.1.312, a plain script's post arrived as a new
  turn when idle and between tool calls when busy, and waited while a dialog was open.
- **A doorbell, not a store**: a message still goes into `inbox.jsonl` first and stays until
  acked (`inbox ack`); right after, its line is posted into the coordinator's session.
  Claude Code keeps posted messages in memory only (one queued in a session that dies is lost
  there), so what isn't acked is posted again at the coordinator's next start, and by the board
  pane when still unacked 10 minutes after its last post (twice at most per session, several in
  one post, once across board panes: `inbox-posts.json`, under its lock).
- **The coordinator's note**: a new SessionStart hook (the coordinator's only, from its start
  script's `--settings`: `hooks --coordinator` prints it, `hooks` leaves it out) writes, when
  the session's `JOB_BOARD_DELIVERY` is set to `socket` or `auto` (the start script's choice;
  unset: no note, so another Claude session in the workspace never takes the posts),
  `coordinators/<workspace>.json` `{ pid, socket, pane, session_id, workspace, host, at,
  delivery, version }` from `$CLAUDE_CODE_MESSAGING_SOCKET`, then posts the unacked messages into
  the new session from the background. Live while its process runs and its socket is there; a
  post that finds it gone (ENOENT, ECONNREFUSED) removes it, except in its first 30 s while its
  process runs (the session may not listen yet). Its start-of-session note tells the coordinator
  how posts look and that only a post that begins with `[board answer]` is the user's button
  press.
- **What a post says**: `[job finished|waiting|note] <slug> — … #<msg id>` (the line `inbox ls`
  prints), `[board answer] card <id> (<tag> · <title>): <label> #<msg id>` (always a post of its
  own), and for several job messages at once `[board inbox] <n> messages not acked yet …` with
  one such line each. The inbox keeps an
  answer's 0.9.0 text. `[board answer]` and `[board inbox]` inside any message's text (any case
  or spacing) become `(board answer)` and `(board inbox)`, so a job can't forge a press; text
  posing as Claude Code's `<cross-session-message` framing or a `<system-reminder` is defused in
  every post.
- **A post** (`postToSession`) connects, writes one line, closes: 2 s at most, never throws, so a
  hook is never held up. A button press whose post fails acks its own message and goes on to the
  channel, then `herdr agent prompt`; one that timed out after connecting (maybe written) counts
  as posted and stays unacked for the re-post, so it isn't delivered twice.
- **`JOB_BOARD_DELIVERY`** = `auto` (default: the socket, else the channel for answers, else
  typed), `socket` (no channel), `channel` (0.9.0 exactly: no note, no posts) or `prompt`
  (0.8.0: answers typed, job messages for `inbox wait`). Read by the sender (unset: auto) and by
  the coordinator's SessionStart hook (unset: no note). Without a note, everything works as in
  0.9.0.
- **The turn-start reminder** doesn't ask for an `inbox wait` while the coordinator's own pane
  has a live note, and says to ack with `board.mjs inbox ack <id>…`.
- **The wire format is internal** to Claude Code: it lives in one function (`wireLines`), the
  tested version is `SOCKET_TESTED_WITH` (2.1.312), and `tests/socket-smoke.test.mjs`
  (`JOB_BOARD_SMOKE=1`, skipped by default) checks it against a throw-away `claude -p` session:
  the start's replay through the real hook, and a posted `[board answer]`.
- `contract` lists the SessionStart hook, the posted texts and the delivery modes; `doctor`
  flags the board's hook on SessionStart in a settings file (fix: take it out) and otherwise
  notes it apart, coordinator only. The tests drop
  `CLAUDE_CODE_MESSAGING_*` and `JOB_BOARD_DELIVERY`, and a post refuses a socket outside the
  test sandbox.
- Tests: `tests/socket.test.mjs` (a fake session over a Unix socket: written, ENOENT,
  ECONNREFUSED, a session that doesn't read; the notes; the delivery order and modes; the
  SessionStart note and replay, also through the real hook; the re-post; the reminder; a forged
  `[board answer]` in a `tell`, a stop, a batch and a replay; a note kept in its grace window; an
  answer timed out after connecting).
- Unchanged: the channel (`channel/`), `inbox wait`, the inbox's file and acks.

## 0.9.0 · unreleased

The inbox reaches the coordinator through a Claude Code channel, button answers included; card
descriptions keep their paragraphs and lists.

- **Why**: with 0.8.0 the coordinator kept a Node `inbox wait` running as a background command
  (two Node processes, about 107 MB, started again after every message), and a board button
  press was still typed into the coordinator's input box, where it collided with what was being
  typed there. Card descriptions are now long (what it is, why, what changes, risk, what each
  answer does), and the board flattened them into one block.
- **The channel** (`channel/`): a Claude Code channel plugin, a Go program with no dependencies
  (one static binary; about 4 MB idle, under 9 MB after 400 messages). Claude Code starts it
  with the coordinator's session (`--plugin-dir <board>/channel
  --dangerously-load-development-channels plugin:job-board@inline`: a home-made channel needs
  the development flag, and Claude Code asks to confirm at start). It pushes each unacked inbox
  message for its workspace into the session as a channel event, the ones written while the
  coordinator was down as soon as it starts, and offers `ack` and `inbox` tools. An unacked
  message is pushed again after 10 minutes (twice at most) and at every start. It answers the
  older MCP handshake on purpose: Claude Code skips channels on the newer one.
- **Button answers through it**: the channel keeps a note, `channels/<pid>.json`, renewed every
  30 s. A press (or `answer`) for a pane with a live note goes into the inbox as kind `answer`
  (`card`, `label`, `to` the pane) and nothing is typed; without one, `herdr agent prompt` as
  before. `INBOX_KINDS` has `answer`.
- **The turn-start reminder** doesn't ask for an `inbox wait` while a channel runs for the
  workspace, and says to ack with the channel's tool.
- **Building**: `channel/run.sh` builds the binary (Go 1.22 or later) when it is missing or older
  than its sources, then runs it; `--build` only builds. The binary writes (acks, its note) under
  the same rules as the CLI: only the installed copy writes a board under your home.
- **Card descriptions**: `add` and `edit --desc` keep line breaks (real ones, or `\n`): lines
  cleaned one by one, one blank line between paragraphs. The details panel and an open card in
  `ls` show paragraphs, `- ` / `• ` items (as `• `, with a hanging indent) and leading labels
  (`Why:`, `What changes:`, `Risk:`, `Your answers:`, in bold); a card or row in the pane shows
  the first paragraph only, ending in `…` when more follows. A one-line description shows as
  before, except that a leading label is bold (the colour snapshots changed for that). `c`
  copies a card with its lines.
- Tests: `tests/channel.test.mjs` (the notes, answers into the inbox, the fallback, the Go
  binary against the board's inbox: the startup push, live pushes, acks, routing an answer to
  its pane), `tests/desc.test.mjs`, and `go test` in `channel/`; the Go ones skip without Go.

## 0.8.0 · unreleased

A job's messages go to an inbox file that its coordinator reads, instead of being typed into the
coordinator's pane.

- **Why**: since 0.7.2 a job's stop (`[job finished] …`, `[job waiting] …`, `[job note] …`) was
  typed into the coordinator's input box with `herdr agent prompt`. That broke into whatever was
  being typed there (the two got glued together) and cut the line at 300 characters.
- **The inbox**: the hooks (Stop, Notification) and `tell` append one JSON line per message to
  `inbox.jsonl` in the board's folder: `{ id, at, slug, kind, card, project, workspace, owner,
  pane, key, text }`, with the whole line (up to 4000 characters). Nothing types into a pane for a
  job any more; that path is gone, with no switch to bring it back.
- **Whose it is**: a message belongs to a Herdr workspace: the one the card's owner pane wrote
  from, else the card's, the project's or the job's own. A coordinator restarted in a new pane
  keeps its workspace, so it gets what was written while it was down.
- **Never lost**: messages stay until acked. The write takes the inbox's own lock, and a failed
  write (lock busy, I/O error) is tried again with a growing pause for up to 60 s
  (`JOB_BOARD_INBOX_RETRY_MS`); then it is kept as `pending` in `jobs/<slug>.json` and the job's
  next hook (or `tell`) writes it first. A message is written once per id, and the same stop once
  (as before). Hooks still exit 0 and never block the job. `JOB_BOARD_NOTIFY_RETRY_MS` and the 10
  tries are gone (they were for a coordinator that couldn't take a prompt).
- **New commands**: `inbox wait [--timeout S]` (blocks until there are messages not acked yet,
  prints them one a line ending in `#<id>`, exit 0; at once when some are there already; 124 on
  timeout; watches the folder, with a 5 s look as a fallback), `inbox ls [--all]`, `inbox ack
  <id>… | --all`. A running `inbox wait` notes itself in `inbox-watch/<pid>.json`.
- **The coordinator's turn-start reminder** lists the messages not acked yet (up to 8, quoted, as
  data), and, alongside them, says when no `inbox wait` runs for its workspace: `No inbox watcher
  is running; start: node "…/board.mjs" inbox wait, in the background.` With no messages it says
  nothing about the inbox.
- `tell` prints `in the inbox for workspace <w>'s coordinator: …`; when the inbox can't be written
  for 60 s it keeps the note pending, says so on stderr and exits 0.
- **A follow-up report doesn't add a card**: `job-report` for a job whose card is already Done
  (briefed again without `job-start`), or read by a restarted coordinator (a new pane, a project
  such as `work` that isn't the job's), added a new Waiting card titled with the bare slug. Now
  it uses the job's most recent card (one this pane owns or in this workspace, else a Done one):
  a report that needs nothing from the user leaves it Done (`<id> stays done`), one that does
  reopens it, in its own project. A job never on the board still gets a card, as before.
- Unchanged: button presses and `answer` still reach the coordinator with `herdr agent prompt`;
  "job finished — not reviewed yet"; `json`.

## 0.7.5 · unreleased

The section a card shows in says what it needs from you: a sub-task is drawn under its parent
only when both are in the same section.

- **A sub-task in another section than its parent's** keeps its own row (or card) in its own
  section, with its own state, buttons, age, amber flag and order, and one line under its title:
  `for #231 Node health` (the parent's project first when it is another's, `(done)` when the
  parent is done). No `↳ for …:` in its title. A Waiting sub-task of a To do parent shows in
  Waiting on you, not inside To do; a blocked job's card counts as Waiting on you.
- **A sub-task in its parent's section** is drawn straight under it, as in 0.7.3, now with its
  state as a tag where its state goes: `[waiting on you]`, `[doing]`, `[to do]` (a Doing one
  with an agent shows the agent's state, as before).
- **The parent's `Waiting on:` line** (on its card, its open row and its details, as before)
  gives each open sub-task a state tag in its section's colour: `Waiting on: Node health fixes
  [waiting on you] · Phone alerts move [to do]`; `[waiting on you]` amber, `[working]`, `[idle]`
  or `[doing]` in Doing's blue, `[to do]` grey, `[done]` dim. With `NO_COLOR` (or no terminal)
  the tags are plain text. Where it doesn't fit on one line, the label has its own line and each
  card one line under it; names are cut, tags never. A closed row still says `waiting on N`.
- **Counts**: each section's header counts exactly the cards drawn in it, sub-tasks under a
  parent there included (`TO DO (0) · 1 under its parent` is gone). `N need you` and the sidebar
  count every Waiting card, as before.
- **Shift+↑ ↓**: a sub-task under its parent moves among that parent's sub-tasks; a sub-task in
  another section moves among its section's top cards.
- **The coordinator's turn-start reminder** names a Waiting sub-task's open parent with
  `(for #231 …)` instead of `(under #231 …)`; one whose parent waits too still follows it
  (`↳ #286 …`). `done` on a parent with open cards says they show as `for #<id> <name> (done)`.
- Unchanged: ready to resume, `json`, `waiting_on`, the row of a sub-task whose parent is done
  (now with the `for … (done)` line instead of the title prefix). A Done row no longer names its
  parent.

## 0.7.4 · unreleased

A sub-task shows only under its parent, wherever its parent is.

- **A sub-task in another section than its parent's** is no longer drawn twice (its own row there,
  `↳ for Node health: …`, and a short line under the parent). Its row (or card) moves to under the
  parent, after the parent's sub-tasks of its own section, with its section where its state goes
  (`to do`, `waiting on you` in amber, or its agent's state), and its own buttons and selection:
  ↑ ↓ reach it, Enter opens its details, ← → and Enter answer a Waiting one, Shift+↑ ↓ order it
  among its siblings of its section.
- **Its own section** neither draws nor counts it: `TO DO (0) · 1 under its parent`. A Waiting one
  still counts in `N need you` (and `WAITING ON YOU (0)  1 needs you, under its parent`) and in
  the sidebar.
- **Its parent done**, or another project's in a view of one project: its own row in its section
  again, marked `↳ for Node health (done): …`.
- **The coordinator's turn-start reminder** lists a Waiting sub-task after its parent
  (`↳ #286 …`), or names its open parent (`#290 … (under #231 …)`). `json` is unchanged.
- **A selected sub-task row** highlights only its id, after the `↳`: its empty id column is no
  longer a blank highlighted block.
- **Wide layout, two cards a row** (Waiting at 110+ columns): a sub-task's card stays under its
  parent's, never beside it.

## 0.7.3 · unreleased

Each sub-task is drawn once, and visibly inside its parent.

- **A sub-task in its parent's section is drawn once**: its own row (or card, in the wide
  layout) moves to straight under the parent's, with its own state, buttons and selection, and
  the parent's short line for it goes. Parent first, then its sub-tasks in their order, then the
  next card. A sub-task's own sub-tasks follow it, two cells further in.
- **Inside the parent**: a sub-task's `↳` starts two cells right of where its parent's title
  starts, with its id after it (`↳ 279  Node health fixes … working`), so it never reads as a
  card of its own. The same for the short lines of sub-tasks in other sections.
- **A sub-task in another section** keeps its own row there, marked `↳ for Node health: …`, and
  its short line with its state (`to do`, `waiting on you`, …) under the parent, after the
  parent's own sub-task rows.
- **Shift+↑ ↓** on a sub-task moves it among its parent's sub-tasks; on a top card, among the top
  cards (its sub-tasks go with it). ↑ ↓ step through parent, sub-tasks, next card.
- When the project filter hides a parent, its sub-tasks are top cards again (`↳ for …`).

## 0.7.2 · unreleased

A coordinator hears at once when one of its jobs stops, instead of finding out later from the board.

- **A job's stop is a message**: when a job's pane (a worker) ends its turn, its Stop hook sends
  one prompt to its coordinator, where a button press on its card would go (the card's owner,
  else the project's live coordinator, else the front one):
  `[job finished] search-ui — done — <the report's summary>` (no final report yet: `no report
  yet` and the last line the job wrote), or, when it asks something,
  `[job waiting] search-ui — needs: <its question>`. A permission prompt in the job's tab sends
  `[job waiting] … — needs: approval: <what it asks>` (the Notification hook). Once per stop: the
  same line again is not sent, and a job that is working again by the time the line would go
  (Herdr's status, looked at for a few seconds) sends nothing. When the coordinator can't take a
  prompt, the line is tried again every 30 s, 10 times at most. Sending happens in the
  background; the hook itself returns at once.
- **`tell "<line>"`**: a job may send a line of its own, `[job note] <slug> — <line>`. Its own job
  only: the slug is its pane's Herdr agent name. Not for a coordinator (exit 2).
- **Job finished, not reviewed yet**: a Doing card whose job finished (a final report, or its
  agent idle or done after a finishing stop) and that nobody has changed for 10 minutes since
  shows `job finished — not reviewed yet` in amber, and the coordinator's turn-start reminder
  lists such cards (`Jobs finished, cards not updated: …`), until it job-reports, moves or edits
  the card. A job that stopped on a question doesn't count.
- Each job's last stop is kept in the board's folder (`jobs/<slug>.json`); the board file itself
  is still written by the coordinator only.
- `hooks` now prints a Notification entry too; `contract` lists it.

## 0.7.1 · unreleased

A parent and the cards made for it now read as one group, in words.

- **Grouped**: in every layout (wide, inbox, compact) the open cards under a parent are drawn
  straight under it, whatever section they are in: `↳ 279  Badge and chart fixes   working`
  (the id, the short name, and the card's own state on the right: its agent's, else its section:
  to do, waiting on you, doing). A blocked one comes first, then by section and order. One level:
  a card's own cards are drawn under that card; the open cards under a Done card show under its
  parent in its place. Each card keeps its own card in its own section too, for its buttons and
  details.
- **Words, not numbers**: the parent's state says `waiting on 2` (how many are drawn under it); an
  open card and the details say `Waiting on: Badge and chart fixes, Phone alerts move`. A child
  says `for Node health` (with `(sfc, done)` when the parent is another project's or Done; `for a
  card no longer on the board` when it was archived), and its row `↳ for Node health: …`. A ready
  parent says `Badge and chart fixes and Phone alerts move are done`. The CLI's own lines (`added
  … · for #231 …`, the reminder hook) and `json` keep their ids.

## 0.7.0 · unreleased

A card made because of another remembers it, so the first card isn't forgotten once the others
are done.

- **`--parent <id>`** on `add` and `job-start`: the new card is made for an open card (doing A,
  you find you need B first). `edit --parent <id>` sets or changes it later, `edit --no-parent`
  removes it. One parent per card; a card can't be under itself (exit 2); a Done or unknown
  parent is refused. The child keeps its own project.
- **The child** shows `for #253 Node health` under its title (dim; the parent's title up to its
  first `:` or `—`, with the parent's tag when it is another project's), and in the inbox and
  compact layouts its row starts with `↳`.
- **The parent** shows `waiting on #230, #266` (bold): every open card anywhere under it, as ids.
  In the inbox and compact layouts that sits where the agent's state goes, unless its agent is
  working.
- **Ready to resume**: when the last open card under a parent is done (`done`, `move … done`,
  `job-report`, or `rm`), the parent says `ready to resume` (amber, bold) with `#230, #266 are
  done`, goes on top of its section (never to Waiting on you), and its age counts from then. The
  CLI prints `#253 Node health is ready to resume (top of Doing)`. It works one level at a time:
  a card that still has open cards under it waits. Moving, editing, ordering (also `Shift+↑` `↓`)
  or job-starting the parent clears the mark, and so does a new card under it.
- **Done on a parent with open cards** is allowed, with a warning; those cards keep their link,
  shown as `for #253 Node health (done)`, and when they are done the parent's own parent can
  wake. `rm` of a parent unlinks its cards.
- **The coordinator's turn-start reminder** (the UserPromptSubmit hook) adds one line for its
  cards ready to resume (id, title as data, what it waited on; at most 8; `+N ready in other
  projects`).
- **`json`** shows `parent`, `ready` (the time), `ready_after` (the ids it waited on) and
  `waiting_on` (worked out each time, never stored). The card details say `For #253 Node health ·
  waiting on #266` and `Ready to resume: #230, #266 are done`.
- **Upgrading**: a board from before 0.7.0 has no links and reads unchanged. A link field that
  isn't valid (a hand edit) is dropped when the board is read. An older copy of the board reading
  a 0.7.0 file ignores the new fields.

## 0.6.0 · unreleased

Cards stay in the order you put them: the ones that matter most on top.

- **Manual order** in To do, Doing and Waiting on you. Each card has a place in its section (a
  new `order` number in the board file, lower is higher up). The board used to show every
  section oldest first (by id) and nothing could change that.
- **New cards go on top** of their section, and so does a card that moves into another section
  (`move`, `job-start`, `job-report`, a card back to To do). An edit keeps its place.
- **`Shift+↑` `Shift+↓`** in the pane move the selected card one place up or down and save it at
  once; the key line says `card 3 moved up`, or that it can't go further. In a view of one
  project (`p`) they step over that project's cards. Other modifiers (`Ctrl+↑`, `Alt+↑`) are
  plain `↑` `↓` as before.
- **`order <ref> top|up|down|bottom [--project P]`**: the same from the command line, so a
  coordinator can move a card when you ask; another project's card needs `--project`, as for
  `move`. With `--project`, `up` and `down` step over that project's cards only. A Done card is
  refused (exit 2): Done stays newest first.
- **Waiting**: a blocked job still shows first, then the cards in your order.
- **Upgrading**: a board from before 0.6.0 has no order; it starts **newest first** (the highest
  id on top) in each section, so it matches "new cards on top". Nothing else in the file
  changes, and the order is saved with the next write. A card added to the file by hand, or
  brought in by `import`, goes below the cards that have a place, newest first. An older copy
  of the board reading a 0.6.0 file ignores `order` and shows id order.
- The age on a card is unchanged: the time it has been in its section.

## 0.5.1 · unreleased

Panes follow the installed copy (Herdr 0.9.5's install folders), and text selection works in
the wide layout.

- **Herdr 0.9.5 installs to a new folder each time**:
  `plugins/github-installations/herdr-job-board-<hash>/<n>/checkout` (a new `<n>` per install or
  `herdr plugin update`), not 0.9.3's `plugins/github/herdr-job-board-<hash>/`, which stays
  behind. A pane watching only its own folder never saw the update. Now a board pane also asks
  Herdr where the plugin is installed (`herdr plugin list --json` → `plugin_root`, every 30 s,
  never waiting for it, 5 s timeout); when that is an install Herdr made (from GitHub, in its
  plugins folder: never a checkout linked with `herdr plugin link`) in another folder with a newer
  version, and the pane runs this board as Herdr installed it (by its manifest id, so not a
  sibling plugin such as `herdr-job-board-qa`) or was started as the plugin (`--as-plugin`, which
  `open` and `restart` now add; settled when the pane starts, so it still holds once Herdr has
  removed the pane's own `<n>`), it hands over to that copy in the same pane,
  with every 0.4.0 rule: the settle time, the check of the new copy (it parses, says its version,
  draws a frame), no bare shell, the wait for a busy prompt, the restart log. The new copy's own
  `pane-restart` starts it.
- **`restart`** from the installed copy also restarts board panes running an older install folder
  (even at the same version), and boards started as the plugin from a checkout that was linked
  then; a board started by hand from a checkout is left alone. `restart` and `open` typed from an
  old install folder run in the newer installed copy instead; run from a linked checkout, they
  move nothing onto it.
- **`doctor`** lists panes that run a copy other than the installed one (`restart`, or `open`
  from the pane left of it), and old install folders: 0.9.3's `plugins/github/herdr-job-board-<hash>`
  with the exact `rm -rf` to remove it (printed, never run; after `restart` when a pane still runs
  it, after `hooks` when your Claude Code hooks still run it), and older `<n>` folders as a note
  (Herdr removes those itself). Only folders whose manifest id is `herdr-job-board` and that Herdr
  lists for no plugin count. They don't change the exit code.
- **The write gate** accepts the new layout at any `<n>` (a test for `github-installations/<id>/<n>/checkout`).
- **Selecting text** (`m`, mouse capture off): the pane draws one column (the inbox) at any width,
  so a drag across the pane selects one card's lines, not two columns'; the open card shows its
  whole title, description and question (no `…`); the key line starts "selecting text: m gives the
  mouse and the columns back", with no message in front of it. A card taller than its section
  says "card cut off: Enter shows the rest in its details". `m` again brings the wide layout back.

A 0.5.0 pane can't follow by itself: run `open` once in its tab (or `restart` from the installed
copy); from 0.5.1 on, panes follow.

## 0.5.0 · 2026-10-19

One board for every project on the machine.

- **One store**: `${XDG_STATE_HOME:-~/.local/state}/herdr-job-board/board.json`, not each repo's
  `.git/job-board.json`. Every card has a project (its repo; worktrees count as their repo;
  outside git, the folder, or `home`), an owner (the coordinator pane that wrote it) and a
  workspace. Ids are global and never reused. `JOB_BOARD_HOME` / `JOB_BOARD_FILE` give a board of
  its own.
- **Migration from 0.4**, repo by repo: a read says the repo's 0.4 board isn't in yet; the first
  write there brings it in (ids kept, stale test cards left out, the old file backed up and
  renamed `job-board.migrated.json`), or stops with the `import` to run when an id would be
  renumbered. The first write that creates the store brings in every 0.4 board on the machine.
  `import [--dry-run] [--keep-stale] [--retag ID=PROJECT,…]` does it on purpose and, after an
  automatic import, shows it and applies re-tags. Each import records the exact name it gave the
  old file (`imports[].renamed`), the one a rollback puts back. `export --legacy` writes a project back as a
  0.4 board (rollback).
- **Archive and backups**: Done cards older than 7 days move to `archive/YYYY-MM.jsonl`
  (`json --archive`, `ls --done 30d`); the first write each day keeps a backup (7 kept);
  `restore` puts one back.
- **Ownership**: changing another project's card that your pane doesn't own needs
  `--project <its project>` (exit 2), so a remembered id can't change the wrong card. `retag`,
  `adopt`, `front`, `projects`, `project set` are new.
- **Answers go by card**: a button (and the new `answer <id> <text> [--from telegram]`) goes to
  the card's owner while it runs, else its project's newest running coordinator, else the pane
  that opened the board or the front coordinator: at once for an unowned card of that project,
  after a second press (or `--front`) for another project's. The card notes where it went. The
  text is `Board card <id> (<tag> · <title>): <label>`.
- **Your cards**: `ls`, `json` and the Claude Code hooks show this project's cards and the ones
  your pane owns (the front coordinator also those no running coordinator can take);
  `--project P|all` for more. The reminder counts the others; the Stop check counts only yours
  and any card your pane changed that turn.
- **The pane with several projects**: each row carries its project's tag in the project's colour;
  a strip under the title lists the projects with their need-you counts; `p` shows one project,
  `P` all, a click on the strip shows that one; filtered views count what they hide; an open
  card names its project and says where its answers go. A board of one project looks as in 0.4.
- **Sidebar**: each workspace's `$board` counts its own cards; only changed workspaces are
  reported, every one again after a Herdr restart.
- **`setup`** writes the key binding and the `$board` sidebar row into Herdr's `config.toml`
  (backup first, `herdr config check`, then `herdr server reload-config`; idempotent; only simple
  shapes; a linked config is edited where it points). The default key is `prefix+shift+b`
  (Herdr itself binds `prefix+b` to toggle_sidebar); a taken key stops it with a free one.
  `doctor` points to it.
- **`contract`** (what this copy offers, as JSON) and **`guide`** (the instructions for agents).
- **Workers** are known by `JOB_AGENT_ROLE`, any `*_AGENT_ROLE` variable, or the repo's
  `.claude/job.json` `role_env`: they never bring boards in, own cards or send answers.
- **Safety**: only the installed plugin at 0.5.0 or later writes a board under your home; a
  checkout or an older copy refuses. An empty `HOME` is refused. The tests insist on a scratch
  home and never reach the real Herdr.

## 0.4.0 · 2026-10-18

The board in a narrow pane, colour and emoji that read, and a shorter install and update.

- **Layouts by pane size.** From 120 columns, the wide layout as before (an empty Doing now folds
  to one line). From 70 to 119 columns, the **inbox**: one column, one row a card (`id`, `!` for
  a card that waits on you, the title cut with `…`, the agent's state, the age), the selected
  card open under its row with its description, question and buttons, an empty section folded
  to its header, a count in every header and "N need you" in the title line. Under 70 columns or
  24 rows, **compact**: the same rows with no blank lines; `Space` opens the selected card under
  its row. A row never cuts its id or age; no card is hidden without a count; a resize lays the
  board out again at once.
- **Space** opens or closes the selected card under its row (inbox and compact). On a closed row,
  `←` `→` move between sections.
- **Colour**: a rule in each section's colour after its header, the "need you" count amber, the
  selected row's id in reverse video. Colour is never the only sign (`▸`, `!`, the state in
  words, folded sections that say so); `NO_COLOR` still turns it off.
- **Emoji** in the section headers (🔔 🔨 📋 🏁) in a UTF-8 locale; `BOARD_EMOJI=0` turns them off.
- **Widths by Unicode's East Asian Width** (CJK, Hangul, kana, emoji), from Unicode 15.0 plus the
  emoji blocks' unassigned code points. Text is drawn the one way terminals agree on: no
  variation selectors, joiners or skin tones, and flags as their letters (🇭🇰 → HK). Checked in
  Herdr 0.9.3 by asking it for the cursor position after each string.
- **No borders**: tried boxes around the sections; their right edge shows every cell a terminal
  counts differently (a flag was 2 cells in Herdr and 4 in another emulator; terminals that draw
  ambiguous-width box characters two cells wide), so the sections stay set apart by spacing and
  the coloured rule.
- **Update**: an update rewrites the plugin's folder in place, so `open` used to leave an older
  board running there. The pane now starts with `--version`; `open` restarts a pane on another
  version, and a running pane restarts itself within seconds of an update of its own folder.
- New commands: `doctor` (what works, and the one fix for each thing missing), `restart` (every
  board pane on an older version), `hooks` (the Claude Code hook settings), `version`.
- `open` from the board's own pane (the key binding pressed while the board has the focus) does
  nothing, instead of opening a second board beside it.
- `ls` uses the layout for its width, with every Waiting card open; `ls --width 120` (or `ls`
  piped, with no `--width`) shows every card whole. `board-pane.mjs --once` takes `--layout` and `--emoji`.

- Review fixes before release: a click presses a button only once that button has been drawn
  where it is for a second (the board keeps when each button position first appeared): one that
  a click, the details panel, a refresh or a resize just put under the pointer only selects. This
  replaced a same-cell check that a double click drifting one cell got past. A double click on a
  closed row opens its details; with mouse capture off, click reports are ignored. A pane hands over to an update only after the new version stood
  still for 5 s and the new copy checks out (its files parse, its `version` says so); a broken
  update keeps the old pane running with "update to X failed to start: …" (the check includes
  drawing a frame of the new pane, so a bad import counts), and an older version put there on
  purpose says "quit (q) and open the board again to run X". Restarts are logged to the board's state folder, and a board started
  later in that pane shows a failed one. `restart` looks at each pane again just before typing
  `q`, types it only into a board still on the old version, and leaves alone one with no board
  file, one quit meanwhile, or one already restarted (logged as skips; the restart log's entries
  count for a few minutes).
  `ls` piped with no `--width` shows the wide layout with every card whole, as before 0.4.0.
  pane-restart waits up to 10 s for a shell busy with its prompt hook (before and after starting
  the new board) instead of giving up on it; a check of a new copy that times out backs off and
  fails after 3 tries; a board that started late doesn't report its own restart as failed; the
  pane times clicks and paints with a monotonic clock, so a wall-clock step can't block buttons.

Earlier versions: see the git history.
