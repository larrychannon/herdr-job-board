# herdr-job-board

A board beside your chat for work you hand to coding agents: **WAITING ON YOU** first, then
**DOING**, the **QUEUE** (what the coordinator starts next, by itself), **TO DO** and **DONE**. It is a [Herdr](https://herdr.dev) plugin: the board
opens in a split pane next to the pane you are in and redraws itself every 3 seconds.

It is made for a *coordinator*: the agent (or person) that starts jobs in other panes and
asks you for decisions. The coordinator writes the board with a small CLI; you read it at a
glance, without scrolling the chat to find what needs you.

**One board for every project** on the machine (0.5): each card belongs to a project (its repo)
and to the coordinator pane that wrote it, so several coordinators in several repos share one
board, and a button's answer goes to the coordinator the card is about. With cards of more than
one project on the board, each row carries a coloured tag and a strip under the title lets you
look at one project at a time (`p`, `P`, or a click):

```
Job board · all projects · 4 need you                                                     11:57
Projects: ▸all  sfc 3  ai 1  herdr  home                                       p filter · P all

▸ WAITING ON YOU (4) ──────────────────────────────────────────────────────────────────────────
▸108 ! sfc   UI consistency plan: answer 10 questions                                    3 days
             Fable plan (docs PR #143): audit of every page with screenshots, one wording
             guide, shared components (CitySummaryRow, CountChip, DefaultVersion…)
             Question: Accept all 10 suggested answers (then mockup M1 first), or go through
               them?
             [ Accept all suggested ✓ ]  [ Go through them ]  [ Later ]  [ Other… ]
             answers go to: sfc coordinator (w4:p6)
 170 ! sfc   magicwan v343 fleet rollout: approve the waves                          2 h 52 min
 204 ! ai    Git access on the LXC: narrower tokens instead of Touch-ID: pick              16 h
```

A board with one project looks as below, exactly as in 0.4.

The layout follows the pane's size. In a pane narrower than 120 columns (the usual case: a
quarter of the screen) it is an **inbox**: one column, one row a card, the selected card open
under its row with its description, question and buttons. This is 95 × 30:

```
Job board · my-app · 3 need you                                                           10:30

▸ 🔔 WAITING ON YOU (3) ───────────────────────────────────────────────────────────────────────
▸ 1 ! Login page redesign: approve                                                   2 h 20 min
      New sign-in screen with SSO buttons and a clearer error message. 3 small choices to
      confirm.
      Question: Open the mockup, reply ok or change
      [ OK all ✓ ]  [ I'll comment ]  [ Other… ]
  2 ! Search filters mockup: approve                                                 1 h 30 min
  3 ! Billing fix (PR #12): review                                                       50 min

🔨 DOING (2) ──────────────────────────────────────────────────────────────────────────────────
  4   Search filters: build                                              working [=   ]  25 min
  5   Docs site: fix broken links                                                   idle  2 min

📥 QUEUE (2) ▾ ─────────────────────────────────────────────────────────────────────────────────
  6   Export to CSV: build                                                               30 min
  7   Dark mode: follow the system theme                                                 30 min

📋 TO DO · 4 ▸
🏁 DONE · 1 today ▸

Tab section · ↑↓ card · Enter details · c copy · u queue · t to do · d done · m mouse: board · q quit
```

| Pane | Layout |
|---|---|
| 120 columns or wider | **wide**: WAITING ON YOU across the top (two cards a row, each with its description, question and buttons), DOING below (opened, TO DO and DONE are each a column beside it; an empty Doing folds to one line over them), then the QUEUE across the width (one row a card, at most a quarter of the height), and TO DO and DONE folded to a line each under it |
| 70 to 119 columns | **inbox**, as above: the sections stacked, one row a card (`id`, `!` for a card that waits on you, the title, the agent's state, the age), the selected card open; an empty section folds to its header ("DOING (0) · nothing running") |
| under 70 columns, or under 24 rows | **compact**: the same rows, no blank lines, a shorter key line; `Space` opens the selected card under its row (a peek), `Enter` its details |

A row never cuts the id or the age; a title that doesn't fit ends in `…`, and a section that
can't show every card says how many are above and below it. Resize the pane and the board lays
itself out again at once.

- **WAITING ON YOU** is first: what needs you. A card shows its title, a description of up to
  3 lines and what you should do, as plain text after a dim label: `Question:` when the card's
  buttons answer it, else `Needs you:`; its **answer buttons** (below) come straight under the
  question. In the inbox that is the selected card; `ls` and the wide layout show every Waiting
  card that way. The title line counts what needs you ("3 need you"). An agent that is
  **blocked** on a question or an approval shows here by itself, even when nobody put it on the
  board.
- **DOING** shows the live state of each job's agent from `herdr agent list` (working, done,
  idle, no agent) and its age. A job's agent is the one named after it in the card's workspace,
  else in any workspace (a job may run in its project's workspace: 0.10.1). A card whose agent is **working** shows a small ASCII bar
  bouncing beside the word (`working [=   ]`); idle, done, blocked and gone agents stand still,
  so the motion itself says what is running.
- **Order**: To do, Doing and Waiting on you are in your order, so the cards that matter most
  can sit on top. A new card goes on top of its section, and so does a card that moves into
  another section (To do → Doing, Doing → Waiting, back to To do), except into the Queue, where it goes last. `Shift+↑` `Shift+↓` move the
  selected card one place up or down in the pane; `order <ref> top|up|down|bottom` does it from
  the command line (a coordinator, when you ask it to). One rule stays above your order: in
  Waiting, a **blocked** job shows first, since it is stuck until you answer it. Done is newest
  first. A board from before 0.6.0 starts newest first (the highest id on top) in each section.
- **Came from** (0.7.0): a card made because of another (doing A, you find you need B first, and
  doing B you find C) has a **parent**: `add … --parent <A>`. The cards under a card are its
  **parts**. **A card shows where its most urgent open part is** (0.20.0), worked out each time
  the board draws, never stored: a part asking you puts it in **Waiting on you**; else a part in
  Doing, or a job, a run or a press of its own going on, in **Doing**; else a card not started
  yet (To do, the Queue) or a Done one stays where it is; else it is **To do** while real work is
  left under it; else, its only open parts being **follow-ups** (cards titled `Follow-up: …`, or
  added with `--follow-up`: what a merge or a check files for later), it is **Done**, and the
  follow-ups show as plain To do cards. A card with no open parts shows in its own column. Its
  parts are drawn **straight under it** when they show in its section, in every layout (0.7.3):
  their numbers in the id column with every other card's, their titles two cells further in per
  level, after a `↳`, with their state as a tag (`[to do]`). A part in another section keeps its
  own row (or card) there, with its own state, buttons, age and order, counted there, and one
  line under its title, `for #1 Node health` (with the parent's project when it is another's;
  `(done)` when the parent shows Done). A blocked job's card counts as Waiting on you. A
  section's header counts the cards drawn in it; `N need you` and the sidebar count the cards
  that ask (a parent shown in Waiting for its part is not one more question). The details and
  `get` say why a card shows elsewhere: `Shows in Waiting on you: #4 asks you (its own column:
  Doing)`; `json` gives it as `shown_column`. Shift+↑ ↓ moves a sub-task drawn under its parent
  among that parent's sub-tasks, any other card among its section's top cards. The
  coordinator's turn-start reminder lists a Waiting card after its parent when that waits too
  (`↳ #286 …`), else with its link (`#290 … (for #231 …)`). **Under a deploy** (0.14.0): when
  the parent's title says deploy in its action (after its last `: `, as in `Release Notes
  Manager: deploy the three merged changes`), a card under it says `waits for the deploy on #417
  Release Notes Manager` (`deployed with #417 … (done)` once it is done). In a 60-column pane:

  ```
  WAITING ON YOU (2) ─────────────────────────────────────────
   1 ! Node health: goes live after its fixes         just now
   4 !   ↳ Phone alerts: go live t… [waiting on you]  just now
           Question: Tonight?
           [ Go live tonight ✓ ]  [ Wait for tomorrow ]
  DOING (1) ──────────────────────────────────────────────────
   3   Badge and chart fixes before going live        just now
       for #1 Node health
  TO DO (1) ──────────────────────────────────────────────────
   2   Phone alerts move: then merge it               just now
       for #1 Node health
  ```

  After `done 3` and `done 4` the only work left is To do, so card 1 shows there with it; with
  card 2 a follow-up (`edit 2 --follow-up`), card 1 is Done:

  ```
  TO DO (2) ──────────────────────────────────────────────────
   1   Node health: goes live after its fixes         just now
   2     ↳ Phone alerts move: then merge it  [to do]  just now

  TO DO (1) ──────────────────────────────────────────────────
   2   Phone alerts move: then merge it               just now
       for #1 Node health (done)
  ```
- **Two amber flags** (0.20.0), where a card's state goes and in the coordinator's turn-start
  reminder ("Cards that look stuck"): `pressed 12 min ago, nothing started` (a press 5 minutes
  ago that nothing started since) and `in Doing, nothing running` (no agent working, no run and
  no running mark on it or a part in Doing, 10 minutes after its last change; only when Herdr's
  agent list could be read). A narrow row says `pressed, not started` and `nothing running`.
- **Rounds** (0.20.0): a check of a change, and the fix after it, run as rounds on the change's
  own card (`job-start <slug> --id <card> --round check|fix`), not as cards of their own. The
  card shows them on one line, `check 1: 2 problems · fix: done · check 2: running`, and its
  details list each with its job.
- **Sub-card names** (0.19.0): a check or a review made for a card shows as its parent's number
  and its kind, its own number beside it: `500 · check (511)`, the second review under 500
  `500 · review2 (515)`, where the number goes (the plain number when drawn under a card,
  the row above, or when the pane is too narrow for the name). Its details say `card 511, also
  500-check`. Every command that takes a card (`move`, `edit`, `done`, `now`, `answer`,
  `--parent`, `--id`, …) takes `500-check`, `500-review`, `500-review2` as well as `511`. The kind
  is the title's last `: <action>` when it starts with check or review (one word before it at
  most: `: check`, `: second review`, `: re-check`; not `: built — in independent review`), else
  the job's slug (`board-find-review`). Numbered by card number among the cards of the same
  parent and kind, the archived ones counted too, so a name never moves to another card when an
  older one is archived (a name that stands for an archived card is refused, naming it).
  Removing a card (`rm`), giving a card another parent or a title edit that changes its kind
  renumbers the ones after it.
- **QUEUE** (0.14.0): To do cards you want started next, without asking for each. Put a To do
  card in it from its details (`u`, or a click on `Add to the Queue`; `Back to To do` takes a
  queued one out) or with `move <ref> queue`; a card goes in last, and `Shift+↑` `Shift+↓` (or
  `order`) change the order. The coordinator works it **top first, by itself**: its turn
  reminder lists the Queue with the room for jobs (each repo's `max_active_jobs` and the host's
  memory floor, `min_free_mb`, as the job skill counts them), and when a repo has room its Stop
  hook hands over the next card: it starts that card's job (the card goes to Doing) or, when the
  card needs a decision first, moves it to Waiting with a question and buttons. A card handed
  over that didn't start isn't handed over again until it is edited or queued again. The Queue
  only decides what gets started: a card whose title or description asks for a merge, deploy,
  release, production, settings or access change (a keyword check, anywhere in the text) comes
  back to you as a question, never as a job, and no limit is passed for it.
  **Queue and start** (0.15.0): `s` in a To do card's details (or a click on `Queue and start`)
  queues it marked **start without asking**; on a queued card `s` marks it (`Start without
  asking`) or takes the mark off (`Ask before starting`). A marked card shows `»` and `starts
  without asking` in the Queue, and the coordinator starts its job without the keyword check, so
  a read-only check that mentions "live", or a title that says "merge" in passing, isn't sent
  back as a question. Still a question when marked: any part of the title (split at `: ` or a
  dash) that starts with deploy, merge, release, ship, publish, push, roll out, cut a release,
  tag, promote, go live, delete, drop, purge, wipe or truncate (`Merge: login fix: final tidy`);
  a card that asks for access, IAM, secrets, credentials, keys, tokens, `sudo`, settings or
  DNS; and one that deletes or drops data, force-pushes or `rm -rf`s. Release notes are never
  asked. These are keyword checks, a safety net: read the card before you mark it. The
  coordinator still never merges, deploys or releases because a card is queued. Only you set the
  mark, from the pane: no command sets it, so neither a job nor the coordinator can, and
  `import` and `restore` drop it (and put queued cards they bring in into To do); a job can run
  neither. It holds for the card as you marked it: an edit of its title or description or a
  retag removes it (editing back doesn't restore it), and so does a move out of the Queue. **Only you and the
  coordinator write the Queue**: a job's pane can't add to it, move a card into it, reorder it,
  or edit or retag a queued card (the CLI refuses, and the job skill's guard blocks the first
  two). The Queue sits
  between Doing and To do, open while it has cards; empty, it folds to `QUEUE · 0 ▸`. `u` (or
  a click on its line or header) folds or opens it; the choice holds until the pane closes.
- **TO DO** is folded to one line, `TO DO · 12 ▸`, so Waiting and Doing get the room. `t` or a
  click on that line opens it (its cards under `TO DO (12) ▾`; a column beside Doing in the
  wide layout); `t` or a click on its header folds it again. Folded, `Tab` skips it. A card
  that moves into To do while it is folded doesn't open it. The choice holds until the pane
  closes; it always starts folded.
- **DONE** is folded to one line, `DONE · 3 today ▸`, so it takes no room. `d` or a click on
  that line opens it (today's finished cards, newest first, with the time they finished, under
  `DONE (3) ▾`; a column in the wide layout); `d` or a click on its header folds it
  again. Folded, `Tab` skips it. The choice holds until the pane closes; it always starts
  folded.
- In the wide layout Waiting gets about half the height; with nothing waiting it shrinks to one
  line ("Nothing needs you"). In the inbox and compact layouts the selected section's open card
  is placed first, then each section gets a fair share.
- **Every section scrolls on its own**, and the place you scrolled to holds while the board
  redraws and new cards arrive. "↑ 2 above" and "↓ 3 more" say what is out of view; a card is
  never hidden without saying so. A card taller than its section (in a short pane) is cut with
  "↓ card cut off: open it for the rest" under it; open it to see the rest, buttons included.
- **Colour**, from the terminal's standard 16 colours so it reads on dark and light themes:
  WAITING ON YOU amber, DOING blue, QUEUE cyan, TO DO plain, DONE dim green, each header followed by a rule
  in its colour in the inbox and compact layouts; the "need you" count amber; the selected row's
  id in reverse video; the agent's state green (working), red (blocked), cyan (idle or done) or
  grey (no agent); every button filled grey (the suggested one bold, with ✓; the chosen one
  blue), while the question stays plain text in no button's colour; and a Waiting card's age red
  after a day. Colour is never the only sign: the selection is marked `▸`, a waiting card `!`,
  the agent's state is a word, an empty section says so, and the buttons keep their `[ … ]` and
  `< … >`. `NO_COLOR` turns colour off.
- **Emoji**: each section's header starts with one (🔔 Waiting, 🔨 Doing, 📥 Queue, 📋 To do, 🏁 Done) in a
  UTF-8 locale. Each is a single character that Unicode makes two cells wide, with no variation
  selector or joiner, so terminals agree on its width. `BOARD_EMOJI=0` turns them off
  (`BOARD_EMOJI=1` turns them on outside a UTF-8 locale).
- **Wide text**: widths follow Unicode's East Asian Width, so Chinese, Cantonese, Japanese and
  Korean titles and emoji line up. Where terminals disagree, the board draws the one form they
  all agree on: no variation selectors (`❤️` shows as `❤`), no joiners (a family emoji shows as
  the people in it), no skin tones (`👍🏽` shows as `👍`), and a flag as its letters (`🇭🇰` shows
  as `HK`). Herdr 0.9.3 was checked to agree with the board's count on every one of these.
- **No borders**: the sections are set apart by spacing and the coloured rule after each header,
  not by boxes. A box's right edge shows every cell a terminal counts differently from the board
  (a newer emoji than the terminal knows, a terminal set to draw ambiguous-width characters such
  as `─` and `│` two cells wide), and it costs 4 columns of a narrow pane.
- **The working bar** ticks about 6 times a second, and only while one is on screen: with no
  working card in view (none working, scrolled away, or under the details) there is no timer at
  all. Each tick rewrites only the bar's cells, and the layout, the selection and the scroll
  position never move with it. `JOB_BOARD_ANIMATION=0` (or a `TERM=dumb` terminal) keeps it
  still; with `NO_COLOR` it moves uncoloured.

### Keys and mouse

| | |
|---|---|
| `Tab` / `Shift-Tab`, `←` `→` | select a section (its header is marked ▸); the Queue, To do and Done only while open |
| `↑` `↓`, `j` `k` | select a card in the section (marked ▸); the view follows. In the inbox the selected card is open under its row |
| `Shift+↑` `Shift+↓` | move the selected card one place up or down in its section, and save it (Queue, To do, Doing, Waiting; not Done). In a view of one project (`p`) it steps over that project's cards; the key line says `card 3 moved up`, or that it can't go further |
| `Space` | in the inbox and compact layouts: open or close the selected card under its row (the inbox opens it by itself, compact doesn't) |
| `Enter` | open the selected card's details (with no button chosen); `Esc` closes them |
| `←` `→` on a card with buttons | choose a button (the suggested one first); the key line then says `Enter to send`, `Enter` presses it, `Esc` un-chooses it. Only buttons on screen count: a card whose job is blocked shows none, so none can be chosen; on a card cut off above its buttons none can be chosen either, and `Enter` opens its details. On a closed row (compact) `←` `→` move between sections |
| `o` | Other… on a card with buttons |
| in the details | `↑` `↓` `PgUp` `PgDn` `g` `G` scroll; `←` `→` choose one of the card's buttons and `Enter` presses it; with no button chosen, `Enter` or `f` shows or hides More… (the rest of the job's report), and `Enter` closes the details when there is no More…; `o` is Other…; `t` goes to the job's tab; `u` puts a To do card in the Queue (last), or a queued one back in To do; `s` queues a To do card marked start without asking, or marks or unmarks a queued one; `Esc` closes them |
| `c` | copy the card's result (0.19.0), else its first link, else its text; `c` again: the next of them (result, each link, the whole card as text), round to the first (Alt+c does nothing). See Links and copying |
| `u` | open the Queue or fold it to its one line (it opens by itself while it has cards); a click on the line, or on the open header, does the same. In a To do card's details `u` puts it in the Queue (a queued card's: back to To do) |
| `t` | open To do (a column beside Doing) or fold it back to its one line; a click on the line, or on the open header, does the same. In a card's details `t` goes to the job's tab |
| `d` | open Done (a column) or fold it back to its one line; a click on the line, or on the open header, does the same |
| `p`, `P`, a click on the strip | with cards of several projects on the board: `p` shows the next project's cards only (in the strip's order), `P` every project again; a click on a project in the strip shows it, on `all` every one. A view of one project counts what it hides (`TO DO (6 · +4 other)`, `(+1 in other projects)` in the title); another project's blocked job still shows under Waiting. The filter is the pane's own |
| `m` | mouse capture off (select text in the terminal) and on again. While it is off the board draws one column (the inbox) at any width, so a drag across the pane selects one card's lines and never the column beside it, and the open card shows all of its title, description, result and question (nothing cut with `…`); a card taller than its section says `card cut off: Enter shows the rest in its details`; the key line starts `selecting text: m gives the mouse and the columns back` |
| `PgUp` `PgDn`, `g` `G` | scroll a page; first / last card |
| mouse | wheel scrolls the section under the pointer; a click selects a card, a double click opens it, a click on a button presses it, a click on a card's question chooses its suggested button (or the first) for `Enter`, and never sends; a click on To do's or Done's line or header opens or folds it. A click on a button presses it only once the button has been drawn where it is for a second: a button that just appeared or moved there (a click opened a card and moved the rows, the details opened, closed or scrolled, a refresh moved a section) only selects its card, wherever the click lands, on the board or in the details. The second click of a double click on a card's row opens its details. With mouse capture off (`m`), click reports are ignored |
| `?` | show every key under the title (wrapped, in place of the key line); `?` again or `Esc` hides the list |
| `q`, `r` | quit; redraw |

The key line sits right under the title, at every width, and the pane's last row is always
empty, with the (hidden) cursor parked on the first row after every frame: a terminal that
keeps its last row or its cursor in view (a phone's, in Collie) would otherwise scroll the cards
at the top out of sight. It shows the main keys and the mouse mode
(`mouse: board` or `mouse: select`), plus a short message after `c`, `t` or `m`. Where none of
its forms fits (a phone), it reads `? keys · q quit`, and `?` shows the rest.

### Card details

`Enter` (or a double click) opens the selected card over the lower half of the pane. The panel
covers everything from the middle down to the row above the pane's (empty) last row: nothing of the board shows through it,
and a rule closes it at the bottom ("── end of card 1 ──", or "── ↓ 12 more lines ──" while
there is more to scroll). It reads top to bottom:

```
── card 1 ──────────────────────────────────────────────────────────────────────
Checkout redesign mockup: approve
  Waiting on you for 7 h 30 min

  What it is
  12 before/after boards on the design canvas (page 'Checkout v2'). 6 small
  choices, each with a suggested answer.

  What you need to do
  Question: Open the canvas, then OK all suggestions or comment
  [ OK all suggestions ✓ ]  [ I'll comment ]  [ Other… ]

  From the job
  Job checkout-mockup finished · its tab: checkout-mockup (press t)

  What the job reported
  Mockup of the new checkout is on the design canvas. It has 12 boards.
  Needs you:
  • The saved-card preview drops the billing address. Make saved cards editable
    anyway?
  Links:
  Design canvas  https://canvas.example/boards/checkout-v2
  PR #57         https://github.com/example/app/pull/57
  3 things checked · 1 skipped · 1 finding

  ▸ More… (f or Enter)  full summary, suggested answers, findings, checks, skips

  Added 03:00 · last changed 03:01
── end of card 1 ───────────────────────────────────────────────────────────────
```

- **The title**, then where the card is, in words: "Waiting on you for 7 h 30 min", "Doing for
  2 h", "Done at 01:10".
- **What it is**: the description, whole: its paragraphs, list items and labels (`Why:`) as
  written (0.9.0). **Result** (0.19.0): the card's result, whole and as written (code lines
  and columns of figures are broken at the width, never re-flowed), under "Written 14:02 · 14
  lines · c copies it". **What you need to do**: the ask and the card's buttons
  right under it, which work here as on the card (`←` `→` or a click on the question choose
  one, `Enter` or a click on the button presses it), then what was sent. Choosing a button
  below the panel's fold scrolls it into view, and `Enter` presses only a button on screen.
- **From the job**: one line with the agent's live state and its tab (`t` goes there).
- **What the job reported**, rewritten for people, from the card's report file: the summary's
  first one or two sentences; **Needs you**, what the report asks of you (each over at most two
  lines, and left out when the card's ask already says it); **Links** to PRs, artifacts and
  other URLs in the report's `ids` or text, one per line and labelled ("PR #57", "Design
  canvas", "Dev server"); and how much was checked and skipped. The report's path and its field
  names never show. A job that hasn't written its report yet shows "Nothing yet".
- **More…** (`f`, or `Enter` while no button is chosen, or a click on the line) shows the rest:
  the full summary, the needs with their suggested answers, findings, what was checked and
  skipped, what's next, the branch and commit. It starts hidden; `f` hides it again.
- **Times** last, short and local: "Added 03:00 · last changed 03:17" (a weekday or a date
  when not today).

`↑` `↓`, `PgUp` `PgDn`, `g` `G` and the mouse wheel scroll it, `c` copies, `t` goes to the
job's tab, `Esc` closes it (`Enter` too on a card with no More… and no chosen button). Report
text is written by agents: it is cleaned like card text (no control or invisible characters,
cut to a fixed length) and only ever shown, links follow the same strict rule as everywhere (the
visible text is the URL), and a field that isn't text, a number or true/false shows as
"(not text)". Labels made from the report's `ids` names keep only letters and digits. The report
is read again only when the file changes.

### Links and copying

- **Links.** `http://` and `https://` URLs in cards and reports are terminal hyperlinks (OSC 8)
  whose visible text is the URL itself, never other words. In Herdr, Ctrl-click opens them
  (Herdr's own `ui.mouse_capture` setting decides whether Herdr or your terminal handles it). A URL that the
  pane had to cut short is plain text, even when the cut fell just after a dot, a hyphen or a
  port's colon (`https://a.example.…`). Only `http` and `https` count: not `javascript:`,
  `data:` or `file:`, never a `user:password@` part, and never an invisible character.
- **Copy.** `c` puts text of the selected card on the clipboard (OSC 52, at most 8000
  characters), on the board or in its details, and the key line says what was copied. It steps
  through (0.19.0): the card's **result**, exactly as stored (indentation and spaces kept, never
  the drawn lines); then each **link**, in the order the card, its result and its report show
  them; then the **whole card as text** (title, status line, description, result, question and
  the buttons it shows: a blocked job's card shows none, so none are copied); then round to the
  first. The key line says which: `copied 1/3: the result, 14 lines`, `copied 2/3: PR #57
  https://…`, `copied 3/3: card 12 as text`; a card with only its text says `copied card 12`.
  Where it fits, the key line reads `c copy (again: next)`. Another card, or opening or closing
  the details, starts at the first again. It happens only when you press `c`. Herdr passes a
  pane's clipboard writes on to the terminal you are attached from (its client has a clipboard
  forwarding step for a server it reaches remotely); that terminal must allow them (most do;
  some ask first or need a setting such as "allow clipboard access").
- **Select text yourself.** The board takes the mouse (clicks select cards and press buttons),
  so a drag selects nothing until `m` turns its mouse capture off: Herdr's own drag-select then
  works in the board's pane (`ui.copy_on_select` decides whether selecting copies), the board
  draws one column, and the open card shows its title, description, question and result whole.
  Scrolling and buttons then need the keys; `m` gives the mouse back to the board. A drag copies
  the drawn lines, wrapped and indented as on screen: for a command or figures, `c` copies the
  text itself.

### Answer buttons

When the coordinator asks you something, it can put the answers it expects on the card, the
suggested one first:

```sh
node board.mjs add waiting "Release notes: approve" \
  --desc "Draft notes for v1.4, written from the merged PRs." \
  --ask "Read the draft: publish the notes as they are?" \
  --option "Publish the notes" --option "Ask for changes" --suggest "Publish the notes"
```

```
5 Release notes: approve                                            12 min
  Draft notes for v1.4, written from the merged PRs.
  Question: Read the draft, then answer
  [ Approve ✓ ]  [ Needs changes ]  [ Other… ]
```

The question is text, the buttons are the filled boxes right under it. Choose a button with
`←` `→`, or click the question (either way the suggested one, ✓, comes first; the chosen one
shows as `< … >`, and the key line says `Enter to send`), then press `Enter`; or click the
button itself. A click on the question never sends.

- Click a button, or choose it and press Enter: the board hands
  `Board card <id> (<tag> · <title>): <label>` (the tag when the card has a project) to the
  card's coordinator, with `herdr agent prompt`. Nothing else from the card is sent. A
  coordinator whose session keeps an inbox-socket note (0.10.0) gets it posted into its session
  instead, as `[board answer] card <id> (<tag> · <title>): <label> #<msg id>`, and one with the
  job-board channel (0.9.0) through the channel; neither types into its input box (see The
  inbox socket).
- **Which coordinator**: the card's owner (the coordinator pane that wrote it) while it runs;
  else the newest running coordinator of the card's project; else the pane that opened the board
  (or the front coordinator, `board.mjs front`). That last one gets a card nobody owns of its
  own project at once, but another project's card only after a second press: the card first
  says `no ai coordinator is running: press Go again to send it to the board's coordinator (sfc,
  pane w4:p6)`. When that pane is gone too (after a restart the card's owner, the front and the
  pane that opened the board can all be dead panes), the newest running coordinator of any
  project, by when it last wrote to the board or its session started (0.19.0), again after a
  second press: `no ai coordinator is running (the card's own, wA:p1, is gone): press Go again
  to send it to the newest live coordinator (work, pane w2:p1)`, and the card then shows
  `sent: Go · 18:30 · to the newest live work coordinator (w2:p1)`. A coordinator that has
  neither written to the board nor noted its session (no inbox socket) isn't known yet. With no
  coordinator at all: `couldn't send: no ai coordinator is running; start
  one there, or use Other…`. With several projects on the board, an open Waiting card says
  where a press goes now (`answers go to: sfc coordinator (w4:p6)`). Only a coordinator's pane
  counts: an agent Herdr names after a job on the board is a worker and never gets answers.
- **Other…** (`o`) switches to that pane so you can type your answer; nothing is typed for you.
- **From the command line, or Telegram**: `board.mjs answer <id> "<label, its number, or
  text>" [--from telegram]` does what a press does (free text up to 300 characters); another
  project's coordinator only with `--front`. Workers can't. A Telegram bot is held by one
  coordinator, the front: it turns a reply such as `170 go` into `answer 170 go --from
  telegram`, and the text then ends with `(from Telegram)`.
- **A press takes the card off Waiting at once** (0.19.0): once it is delivered, the card goes
  to Doing with the status line `your press "Approve": being carried out`, its question and
  buttons gone, so nothing you answered still asks for you. It comes back to Waiting only when
  a new question is written on it (`move <id> waiting --ask … --option …`). The card keeps what
  you pressed, the question it answered and where it went: `get` shows `Answered: Approve (a
  press · 10:42 · to sfc coordinator (w4:p6))`, the details a "Your answer" section. The press
  itself stays in the coordinator's inbox (`inbox get <id>`, which `ship.mjs --approved-by
  board:<id>` reads). A question written while the press was on its way stays on the card (the
  press answered the old one), and the card says so. Presses run one at a time, so a double
  click sends once. A card from before 0.19.0 still in Waiting after a press shows `sent:
  Approve · 10:42 · to …` under its buttons, and pressing again there asks "send again?" first.
- **An answer typed in the chat** (0.19.0): `board.mjs answered <id> "<your words>"` (the
  coordinator's) does the same for a Waiting card you answered in the chat instead: Doing, `your
  answer "<your words>": being carried out` (cut to fit; the card keeps them whole, 300
  characters at most), nothing sent. Workers can't.
- **A press runs the work** (0.20.0): a merge question's button can carry what it runs. The
  coordinator writes it with the buttons: `--option "Merge and install it" --option "Hold the
  merge" --suggest "Merge and install it" --action "Merge and install it=merge+install"` (the
  stage merge, release, deploy, install or verify, or several joined by `+`); the board stores
  `{ stage, repo, card }` on that button, the repo being the card's project folder. Only a
  coordinator writes an action (a job's pane is refused, and a job's own buttons never carry
  one); `import` and `restore` drop them; a new set of buttons drops them unless given again. A
  press of such a button (in the pane, or `answer`, which a Telegram reply becomes) is not sent
  to the coordinator as words: the board puts the press in the inbox as an answer, acked at once
  (the board carries it out, so no coordinator acts on it a second time), takes the card to
  Doing with `your press "Merge and install it": starting merge+install`, and starts
  `board.mjs run-press <card> <message id>` in the background, detached, so closing or
  restarting the pane doesn't stop it. The runner checks again that the action is this card's,
  asks the merge script whether it can run a press (`node ship.mjs contract` prints JSON whose
  `stages` lists `run`; the script is `JOB_BOARD_SHIP`, else the job skill's
  `~/.claude/skills/job/scripts/ship.mjs`), then runs `ship.mjs <repo> <card> run --approved-by
  board:<message id> --stages merge,install` in the repo. Its output goes to the store's
  `runs/<card>-<message id>.log`; the card shows the run where a job's state goes (`merge+install
  · 3 min`), the log's last line in its details, and the merge script writes the card's status
  line at each stage. At the end the coordinator gets one message, `[board run] card 12 (sfc ·
  Login fix: merge and install): the "Merge and install it" press ran merge+install: done —
  <the last line>` (or `failed (exit 1)`, and the card's line says so). One run per card at a
  time. **Until the merge script has a run stage, nothing runs**: the card says `the press is
  recorded; run not available yet`, and the coordinator's message says to carry the press out as
  before, with `--approved-by board:<message id>`. Exact button words stay accepted when the user
  types them in the chat; other buttons (choices, plans) still go to the coordinator.
- **A parent and its cards**: a parent shows in Waiting while a card under it asks (0.20.0, see
  Came from); a card under it that you answered leaves Waiting with its press, and the parent
  with it. The turn reminder also says to use `answered <id> "<their words>"` for an answer typed
  in the chat.
- If the answer can't be handed over, the card says `couldn't send: …` in red and nothing is
  sent: the coordinator's pane is gone, or it is waiting on a question of its own (answer that,
  then press again), or Herdr can't prompt it (next point).
- **Which coordinators can receive a button.** Any coordinator Herdr sees as an agent in that
  pane, including a Claude Code session started by typing `claude`: the board sends to the pane
  id, and Herdr 0.9.3 delivered there both while the session was idle and while it was working
  (checked 2026-10-13). Herdr declines (`agent_not_ready`) while the agent shows a prompt or is
  otherwise not ready for input, and refuses one that is blocked on a question; the card then
  says so, and you press again later or use Other… and type the answer.
- Up to 4 buttons of up to 24 characters; `--clear-options` removes them. They are for Waiting
  cards only and go away when the card leaves Waiting.
- **A press that couldn't run** (0.14.0): some answers need your own typed words (a settings or
  permission change, a live database write), so the coordinator can't carry out the press. It
  then runs `not-run <id> --type "<words>"` (or `--run "<command>"`): the card goes to Waiting
  asking `Your press couldn't run this: type "deploy the fixes" in the coordinator's chat` (or
  `run this command: …`), its status line says the same, the pressed button is gone, and the
  card shows `couldn't run: the "Deploy the fixes" press · 10:36` in amber. The other buttons
  stay: on a card the press took to Doing, the ones it had come back with it (without `--label`,
  the press on record is the one it took). `--label` must name a button of the card, one it had
  before a press took it off Waiting, or a press on record (the card's or the inbox's), else
  nothing is written; a different press still in flight keeps its record.
  Workers can't run it. A new question (`--ask` or `--option`) ends it. For an action the coordinator knows no
  press can run, it does the same before anything is pressed (a Waiting card without `--ask`,
  then `not-run`): `A press can't run this: type "…" in the coordinator's chat`, no button.

## Install

Needs Herdr 0.9.3 or newer, Node.js 20 or newer, and git.

1. Install it:

   ```sh
   herdr plugin install larrychannon/herdr-job-board
   ```

2. Check it, from a Herdr pane: `doctor` says what works and, for anything missing, the one
   command that fixes it.

   ```sh
   BOARD="$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id == "herdr-job-board") | .plugin_root')/board.mjs"
   node "$BOARD" doctor
   ```

   ```
   herdr-job-board 0.5.1 at /home/me/.config/herdr/plugins/github-installations/herdr-job-board-2d3b6201c876/3898869-0/checkout
   ok    Node.js 22.23.2
   ok    Herdr 0.9.5
   ok    plugin installed: herdr-job-board 0.5.1 from larrychannon/herdr-job-board @ 1a2b3c4
   ok    the board: /home/me/.local/state/herdr-job-board/board.json (12 cards, 3 projects)
   add   no key binding for the board in /home/me/.config/herdr/config.toml
   add   no "$board" in the sidebar's space rows
         node '…/board.mjs' setup --dry-run   (to see the change), then: node '…/board.mjs' setup
         (until then: node '…/board.mjs' open)
   opt   Claude Code hooks not set up (only for a Claude Code coordinator): print them with
         node '…/board.mjs' hooks
   ok    1 board pane open
   fix   /home/me/.config/herdr/plugins/github/herdr-job-board-2d3b6201c876: an old install of the board (0.4.0) that Herdr no longer uses
         rm -rf '/home/me/.config/herdr/plugins/github/herdr-job-board-2d3b6201c876'
   ```

   It exits 1 only when something the board needs is missing (Node, Herdr, the plugin, or a
   board pane on an older version or an older install folder), or a settings file runs the
   board's hook on SessionStart (the coordinator's start script's `--settings` carries that one;
   see The inbox socket); the key binding, the sidebar and the hooks are optional, and so is
   removing an old install folder (see Update).

3. The key binding and the sidebar count: `setup` writes both into Herdr's `config.toml`
   (below). Look first, then write:

   ```sh
   node "$BOARD" setup --dry-run
   node "$BOARD" setup
   ```

4. Open the board: `prefix+shift+b`, or `node "$BOARD" open` from the pane you work in.

`open` splits the calling pane to the right (30% wide), keeps your focus where it is and
remembers the pane: a second `open` in the same tab reuses it, starts the board again if it
was quit, and restarts it if another copy or an older version of the board runs there. The
pane that runs `open` is where answer buttons send a card nobody owns (see Answer buttons). Run from the board's own pane, it does
nothing. Don't use `herdr plugin action invoke open` from a shell: Herdr runs a plugin action for
the pane that has the focus in its window, not for the shell that asked, so it opens the board
beside whatever pane is focused.

### Update

Herdr 0.9.5 has `herdr plugin update`; on 0.9.3, install it again.

```sh
herdr plugin update herdr-job-board      # Herdr 0.9.5 (-y: no question first)
herdr plugin install larrychannon/herdr-job-board   # Herdr 0.9.3
```

What `herdr plugin update` is, from its help and messages (not run here): it updates plugins
installed from GitHub (the ones named, or all of them), asks first unless `-y`, says "… is
already up to date." when there is nothing new, and refuses a plugin linked with
`herdr plugin link`.

Where the copy goes depends on Herdr. 0.9.3 cloned the plugin to
`~/.config/herdr/plugins/github/herdr-job-board-<hash>/` and an update rewrote that folder in
place. 0.9.5 puts each install in a new folder,
`~/.config/herdr/plugins/github-installations/herdr-job-board-<hash>/<n>/checkout` (`<n>` such
as `3898869-0`, a new one each time, with an `.in-use` marker beside `checkout`), and
`herdr plugin list --json` names it as `plugin_root`. It leaves the 0.9.3 folder behind, and
removes its own older `<n>` folders once nothing uses them. The board doesn't depend on the
folder name: the plugin action (the key binding) runs from `plugin_root`, and so does
`$BOARD` under Install.

An open board pane (0.4.0 or newer) sees a new version in its own folder, and (0.5.1 or newer)
also asks Herdr every 30 seconds where the plugin is installed (`herdr plugin list --json`, with
a 5-second timeout; the pane never waits for it). When that is an install Herdr made (from
GitHub, in its plugins folder; never a checkout linked with `herdr plugin link`) in another folder
with a newer version, and the pane runs this board as Herdr installed it (its manifest id is
`herdr-job-board`) or was started as the plugin (`--as-plugin` on its command line, which `open`
and `restart` add when they run as the plugin), that copy is the new one. A board started by hand
from a checkout is left alone. The pane waits until the new copy has stood still for 5 seconds (an update writes several
files), checks it (its files parse, its `version` says that version, and its pane draws a frame of
this board outside Herdr, which links every import) and only then restarts itself with it, in the
same pane, with the same board and coordinator: the new copy's own `pane-restart` starts it. It
waits while a card's details are open or a button is chosen, and says so. A copy that fails the
check is never started: the pane keeps running and says why, with "run herdr plugin install
larrychannon/herdr-job-board again" for a broken update, or "quit (q) and open the board again to
run X" for an older version put there on purpose (a board before 0.4.0 can't take over a pane by
itself). An installed copy older than the pane is not followed. A check that takes too long is
tried again a minute later, then later still; after 3 timeouts in a row the pane says "the new
copy took too long to start". Once the old board has quit, the restart waits up to 10 seconds for
the shell to get back to its prompt (a prompt hook such as a zsh `precmd`, a git prompt or direnv
shows as busy for a moment) and for the new board to show; a pane that stays busy is logged as a
failed restart. Restarts are logged to
`${XDG_STATE_HOME:-~/.local/state}/herdr-job-board/restart.log` (beside the board when
`JOB_BOARD_HOME` gives it a folder of its own); a board started in a pane within a
few minutes of a failed restart there says why, once. Panes left alone on purpose are logged as
skips, not failures.

A pane from before 0.5.1 only watches its own folder, so under Herdr 0.9.5 it doesn't see the
update (and one from before 0.4.0 can't restart itself at all): run `open` once from the pane
left of it, or `node "$BOARD" restart`. `restart` restarts every board pane, in every workspace,
that runs an older version of the installed board, a copy whose files are gone, or (run from the
installed copy) an older install folder, even at the same version, or a checkout the board was
started from as the plugin while it was linked; `doctor` lists them. Typed from
an old install folder, `restart` and `open` run in the newer installed copy instead. `restart`
looks at each pane again right before typing `q` into it, and types it only into a board still
stale; it leaves alone a pane with no board file to start again, one whose board was quit
meanwhile, and one that already restarted itself. If a new board doesn't stay running, the reason
is printed in the pane only when the pane is a shell at that moment. `open` in a tab does the same
for that tab's pane.

`doctor` also lists the install folders Herdr no longer uses: 0.9.3's
`plugins/github/herdr-job-board-<hash>` with the exact `rm -rf` to remove it (after `restart`
when a pane still runs it, and after `hooks` when your Claude Code hooks still run it), and older
`<n>` folders as a note, since Herdr removes those itself. A folder counts only when its
`herdr-plugin.toml` says `id = "herdr-job-board"` and Herdr lists it for no plugin, so a sibling
plugin's `herdr-job-board-qa-<hash>` is never one. It prints the command and never removes
anything.

The key binding and the sidebar token don't change after an update. The hooks name a path (see
the hooks section): under Herdr 0.9.5 that path changes with each update, and `doctor` says when
the hooks in your settings run an older install folder, with `hooks` to print the current ones.

### Upgrading from 0.4

0.4 kept one board per repo, in `.git/job-board.json`; 0.5 keeps one for every project, in
`${XDG_STATE_HOME:-~/.local/state}/herdr-job-board/board.json`. The old boards come in once:

1. **Nothing to do for a repo you work in**: its 0.4 board is brought in by the first command
   that writes in that repo (a coordinator's `add`, `job-start`, `open`, a wait script's
   `job-report`), ids kept, and the old file is renamed `job-board.migrated.json` beside itself
   (after a copy in the store's `backups/import-<time>/`). A read (`ls`, `json`, the pane, the
   prompt hook) only says the board isn't in yet. The first write that creates the store brings
   in every repo's 0.4 board (this repo's and those under `~/*` and `~/*/*`), the biggest first.
   A board whose ids would clash with ones already in the store is never renumbered by itself:
   the write stops with the `import` to run. A job's worker never brings a board in.
2. **To look first, and re-tag cards that are about another project**:

   ```sh
   node "$BOARD" import --dry-run                          # what would happen; writes nothing
   node "$BOARD" import --retag 200=home,204=ai-config     # bring them in, re-tag those cards
   ```

   The dry run lists each board (ids kept, or renumbered with the map), the test leftovers it
   leaves out (a Waiting card whose report was in `/tmp`, is gone, and is older than 3 days;
   `--keep-stale` keeps them), and the re-tags it suggests from titles and running jobs. If a
   write already brought the boards in, `import --dry-run` shows that import and its
   suggestions, and `import --retag …` applies them; `ls`, the prompt hook and the pane say so
   until you run `import`. Later, `retag <id> <project>` moves one card.
3. **Back to 0.4** (rollback), in this order (while 0.5.0 is installed, any write in a repo
   brings a 0.4 file that is back in `.git` in again):
   - keep the cards as they are now: `export --legacy --project <name> > /tmp/<name>.json`
     writes that project's cards as a 0.4 board (it only reads);
   - the plugin: Herdr's `plugin install` takes no version, so `herdr plugin uninstall
     herdr-job-board`, then link a checkout of 0.4.0 (commit `6f4047a`: `git clone …; git
     checkout 6f4047a`, then `herdr plugin link <that folder>`);
   - the boards back: either that export as `<repo>/.git/job-board.json`, or, for the board as it
     was at the import, the exact file the import renamed. The import's output names it, and the
     store keeps it in `imports[].renamed` (read the store's `board.json` with `jq`, since the
     0.5 CLI is gone). It is `job-board.migrated.json`, or `job-board.migrated-<time>.json` when
     that name was taken, so never assume the plain name;
   - the board panes: 0.4.0's `restart` doesn't move a 0.5 pane (another copy). In each tab with
     a board, run the 0.4.0 copy's `open` from the pane you work in: it switches the board pane
     to that copy, on the repo's file.

   Cards written after the import are only in the 0.5 store unless exported.

Run the board's commands from the installed plugin: a git checkout of it (and any copy before
0.5.0) writes no board under your home. To try a checkout, give it a board of its own:
`JOB_BOARD_HOME=/tmp/board-trial node board.mjs …` (no migration either).

### Key binding and sidebar: `setup`

`setup` writes into Herdr's `config.toml` (`HERDR_CONFIG_PATH`, else
`~/.config/herdr/config.toml`, the place `herdr --help` names on every platform):

- a key that opens the board:

  ```toml
  [[keys.command]]
  key = "prefix+shift+b"
  type = "plugin_action"
  command = "herdr-job-board.open"
  description = "open the job board"
  ```

  The default is `prefix+shift+b` (Herdr itself uses `prefix+b` for `toggle_sidebar`); `--key K`
  picks another. A key that your config or Herdr's defaults (`herdr --default-config`) bind
  stops it, and it names a free one.
- `"$board"` in the sidebar's space rows, so each workspace shows its own counts
  (`2 need you · 1 doing · 4 to do`: the cards whose job runs there, and those of the project
  whose workspace it is):

  ```toml
  [ui.sidebar.spaces]
  rows = [
    ["state_icon", "workspace"],
    ["branch", "git_status"],
    ["$board"],
  ]
  ```

It edits only the simple shapes (no `[ui.sidebar.spaces]` yet; `rows` on one line, or one row a
line); anything else gets the lines to paste. It copies the file to `config.toml.bak-<time>`
first, asks `herdr config check` (a file Herdr can't read is put back as it was), then runs
`herdr server reload-config` (`--no-reload` skips it). `--dry-run` shows the change and writes
nothing; `--no-key` and `--no-sidebar` skip a part. A second run says `ok` for both and writes
nothing.

## The CLI

`node board.mjs <command>`, from anywhere: one board for every project. A new card goes to the
current folder's project (its repo; a worktree counts as its repo; outside git, the folder, or
`home` for `~`), unless `--project` or `--worktree` says another. `node board.mjs help` prints
this list; `node board.mjs <command> --help` (or `help <command>`) prints one command's usage
and the flags it takes.

| Command | What it does |
|---|---|
| `add <column> <title> [--desc D] [--job slug] [--ask A] [--option L]… [--suggest L] [--action L=S]… [--project P] [--parent ID] [--follow-up]` | Add a card; prints its id. Columns: `todo`, `queue`, `doing`, `waiting`, `done` (a card added to or moved into `queue` goes last). `--option` (Waiting only, up to 4) adds answer buttons, `--suggest` marks one, `--action "<label>=<stage>"` (the coordinator's only, 0.20.0) makes that button run the work on a press (see Answer buttons). `--parent`: the open card it is made for, a part of it (see Came from); it may be another project's. `--follow-up` (0.20.0): a card filed for later, which never holds the card it is for. |
| `move <ref> <column> [--ask A] [--desc D] [--option L]… [--suggest L] [--action L=S]…` | Move a card. `<ref>` is its id, its job slug, or a sub-card's name (`500-review`, 0.19.0). A move to `waiting` takes the question's buttons in the same command (see Writing cards). |
| `edit <ref> [--title T] [--desc D] [--ask A] [--job slug] [--option L]… [--suggest L] [--clear-options] [--parent ID \| --no-parent]` | Change a card. New `--option`s replace the old ones. A new `--ask` (edit or move) needs `--desc` with a `Now:` line in the same call, or a current status line (see Writing cards). A `Now:` line in `--desc` (add, edit, move, job-start) becomes the card's status line and leaves the description: a card shows one Now. `--parent` sets or changes the card it is made for (one; never itself or a card under it: exit 2), `--no-parent` removes it (the old parent is not marked ready: nothing was finished). |
| `answered <ref> "<the user's words>"` | The user answered a Waiting card in the chat (0.19.0): it goes to Doing as after a press, with `your answer "<words>": being carried out`, the words kept on the card (`get` shows them; 300 characters at most). Nothing is sent. Not for workers; exit 2 for a card not in Waiting. |
| `not-run <ref> --type "<words>" \| --run "<command>" [--label L]` | A press its coordinator couldn't carry out (see Answer buttons): the card goes to Waiting, asking and saying in its status line what to type or run; the pressed button (`--label`, else the one sent) is gone. |
| `lint [--project P]` | Every open card whose words fail the check (see Writing cards), each problem with its fix. It also warns (0.17.0) on a description that still has a `Now:` line next to the card's status line, on a plain description line over about three lines (60 columns each), and (0.19.0) on a file in a temporary folder (`/tmp`, `/private/tmp`, `/var/folders`) in the title, description, question, status line or result: a restart deletes it, so the card would point nowhere (it says when the file is gone already); and on a result's line of prose over about three lines (never its numbers or code lines). Read-only; exit 1 when a card must be fixed, 0 when only warnings are left. |
| `find <words…> [--project P]` | Which card holds these words (0.19.0): every project's cards (or P's), Done and archived ones too, in the title, description, result, question, status line, job, project (tag or name) and the job report's summary, needs and notes. Any case, each word at the start of a word (`node` finds `nodes`, not `anode`). Most words first, then the newest; at most 20 (then `+N more`). Each: `#511 (500-check) · done Tue 16:00 · sfc · for #500 … · <title>  [3 of 3 words]` and the line that matches (`description: …`; text that looks like a secret hidden). Read-only; exit 1 when no card matches. |
| | `add`, `edit`, `move … waiting` and `job-start` check the card they leave and write nothing when it fails; `--allow-wording` writes it anyway (see Writing cards). |
| `done <ref>` | Same as `move <ref> done`. Done on a parent with open cards is allowed, with a warning: they keep their link, and the parent shows where the most urgent of them is until they are done (0.20.0). |
| `rm <ref>` | Remove a card. |
| `retag <id>… <project>` | Move cards to another project. |
| `order <ref> top\|up\|down\|bottom [--project P]` | Move a card in its section (see Order above). With `--project`, `up` and `down` step over that project's cards only. Done cards keep their order (exit 2). |
| | `move`, `edit`, `done`, `rm`, `order` and `retag` change another project's card only with `--project <its project>`, unless your pane owns it (exit 2 otherwise): ids are global, and a remembered id may be another project's. |
| `answer <id> <text> [--from telegram] [--front]` | What a button press does (see Answer buttons): a button with an action runs on the board (0.20.0). |
| `run-press <card> <message id>` | The board's own runner, started in the background by a press of a button with an action (0.20.0); not for people or workers. |
| `tell "<line>"` | From a job's pane: put `[job note] <its slug> — <line>` in its coordinator's inbox (see Job messages). Its own job only (the slug is the pane's Herdr agent name); not for a coordinator. |
| `inbox wait [--timeout S]` | A coordinator's: wait until its inbox has messages not acked yet (at once when it has some), print them one a line, `[job finished] <slug> — <status> — <summary> #<id>`, and exit 0; exit 124 after S seconds. Not needed with the inbox socket (see Job messages). |
| `inbox ls [--all]` | This coordinator's messages not acked yet (`--all`: the acked ones too, marked `(acked)`). |
| `inbox ls --stray` | The messages not acked in a workspace where no coordinator ever wrote to the board (a job's own workspace, say), with their workspace. The turn-start reminder counts them. Handle any that is yours, then `inbox ack <id>…`. |
| `inbox ack <id>… \| --all` | Mark messages handled (`#` before an id is fine). They stay in the inbox until acked. |
| `inbox get <id>` | One message as JSON, acked or not, any workspace's (0.13.0): its kind, card, button label and time. A script reads a board press with it (the job skill's `ship.mjs`). |
| `front [show]` | This coordinator pane gets the answers no other coordinator can take, and holds Telegram (default: the pane that last opened the board). |
| `adopt <id>…` / `adopt --project P --gone` | This coordinator pane owns these cards (`--gone`: P's open cards whose owner pane is gone). |
| `projects` | Every project: tag, colour, open cards, folder, coordinators (live or gone). |
| `project set <name> [--tag T] [--color C] [--name N]` | A project's tag (at most 7 characters), colour (magenta, cyan, blue, green, bright magenta, bright cyan) or name. |
| `ls [--width N] [--project P\|all] [--done 30d]` | Print the board as the pane shows it at that width (wide from 120, the inbox from 70, else compact), with live agent status and every Waiting card open, with Done open: today's finished cards (`--done 30d`: the last 30 days', the archive's too). By default your cards: this project's and the ones your pane owns; `--project P` draws the pane's view of P, `all` every card. Piped with no `--width` (an agent reading it), or with `--width 120`, the wide layout: every card whole. |
| `json [--project P\|all] [--archive YYYY-MM]` | `{ version, scope, hidden, items, projects }` for your cards (`--project all`: the whole file), or a month's archived Done cards. A card has `parent` when set, `waiting_on` (the open ids under it) when it has any, `shown_column` when it shows in another column than its own (0.20.0; from the stored cards: the pane and `ls` also put a blocked job's card in Waiting), `rounds` and `run` when it has them (0.20.0), and `not_run` ({ label, at, type or run }) after `not-run`, `answered` ({ via: press or chat, label, at, to, ask, options }) after a press or `answered` (0.19.0), and `result` (a string) and `result_at` (when it was written) while it has a result (0.19.0). |
| `job-start <slug> [--id N] [--title T] [--desc D] [--report path] [--worktree W \| --project P] [--parent ID]` | A job started: its card moves to Doing (`--id`, refused when the card is another job's: `edit N --job <slug>` first if that is meant; else that job's To do or Doing card, else its Waiting card when it asks nothing and `--title` names no other task, else a new one, in W's repo). A Waiting card with a question or buttons stays the user's: the round gets a new card, and job-start says how to put it on that card (`--id`). A card leaving Waiting loses its ask and buttons. `--parent` as for `add`. A new card needs `--title`: the slug alone is refused (0.14.0); `--id` without `--title` keeps the card's title. `--round check\|fix` (with `--id`, 0.20.0): a check or a fix as a round on the change's own card, any job's (see Rounds); no `--parent`. |
| `job-report <slug> [report.json] [--if-final]` | A job's report landed (default: the `--report` given at `job-start`). See below. With `--if-final`, a missing, unreadable or non-final report is a quiet no-op (exit 0). It never makes a card (0.15.0): with no card for the job, the coordinator gets a `[job note]` (from the job's own pane, its `[job finished]` says so instead, 0.20.0). |
| `now <ref> "<where it stands>" [--only] [--event KIND]` / `now <ref> --clear [--only]` | The card's status line (0.13.0), shown at the top of the card, its details and `ls`: `Now: merged, waiting for your deploy OK`. Written on the card's lineage too (the cards above it and every open card under it, not its siblings) unless `--only`. `--event merge\|deploy\|…` notes that event on the lineage first. Words checked as for a card. See Status lines below. |
| `running <ref> "<label>"` / `running <ref> --clear` | Marks the card as running a stage from a pane that is not its job (0.19.0): a merge, a release, a deploy. Its row shows `deploying the GUI · 4 min` where a job's state goes, in the working colour with the working bar, and its details say `running: …`; a job agent that is working or blocked wins. While it holds, the card is busy: not "job finished — not reviewed yet", not "in Doing, nothing running", and not in the turn reminder. The same label again keeps its time, another starts it over. After 2 h it reads `deploying the GUI · stuck? 2 h` in amber (the stage probably died without clearing it) and no longer counts as busy. `--clear` and `done` remove it; an unknown card exits 1. |
| `result <ref> "<text>"` / `result <ref> --file <path>` / `result <ref> -` / `result <ref> --clear` | The card's result (0.19.0): an answer, a draft or figures the user asked for, kept with the card, so it is still on the board after the chat compacts or restarts. Shown under the description: its first 6 lines on the card (`+8 more lines: Enter shows all · c copies it`), whole in the details (a **Result** section after What it is), on every card `ls` draws open (a Done card, or a closed row in its narrower layouts, stays one line, as without a result), in `get` and while selecting text (`m`); `c` in the pane copies it first. Kept as written, up to 8000 characters (what `c` copies whole): indentation and the spaces between figures stay, a tab becomes spaces, control characters go. `-` reads it from stdin and `--file` from a file, both as they are; in `"<text>"` a literal `\n` is a line break, as in `--desc`. Numbers and code are fine (it is the answer itself); text that looks like a secret is refused, from a file or stdin too (exit 2). `lint` warns on a line of prose over about three lines and on a file in a temporary folder, never on numbers or code lines. Set again, the new text replaces it; `--clear` removes it (the card then has no `result` field). |
| `get <ref> [--json]` | One card, whole (0.19.0): `card 12 · waiting on you · project sfc`, then `Title:`, `Job:`, `For:` (its parent), `Now:`, `Question:`, `Buttons:` (the suggested one marked), `Description:` and `Result (written 14:02):`, each left out when the card has none. An archived Done card by its number too. `--json`: the card as stored, as `json`'s `items` show it (with `waiting_on`). Read-only; an unknown card exits 1. |
| `import [--dry-run] [--keep-stale] [--retag ID=PROJECT,…] [<file>…]` | Bring 0.4 boards in (see Upgrading from 0.4). |
| `export --legacy [--project P\|all]` | A project's cards as a 0.4 board file, on stdout. |
| `restore [<backup>]` | List the board's backups, or put one back. |
| `open [--share 0.3]` | Open the board pane right of this pane (or restart it there with this version). |
| `restart` | Restart every board pane that runs an older version of this board, or a copy whose files are gone, in every workspace. |
| `setup [--dry-run] [--key K] [--no-key] [--no-sidebar] [--no-reload]` | The key binding and the sidebar count in Herdr's `config.toml` (see above). |
| `doctor` | Check the install and print the one fix for each thing missing; exit 1 when something required is. |
| `hooks` | Print the Claude Code hooks to merge into `.claude/settings.json` (not SessionStart). `--coordinator` prints the coordinator's own `--settings` instead: `crossSessionInbound` accept and the SessionStart hook (the inbox socket). |
| `contract` | What this copy offers, as JSON: version, contract 2, commands and their flags, hooks, store. |
| `guide` | The instructions for agents (below). |
| `version` | Print the board's version. |
| `token` | Print this workspace's sidebar text, and report every workspace's to Herdr. |
| `path` | Print the board file's path. |

Exit codes: 0 ok, 1 error (unknown card, unreadable board, Herdr failed), 2 bad usage (and a
change to another project's card without `--project`).

### Status lines (0.13.0)

A card's description says what the thing is; its **status line** says where the work stands
now, and changes many times a day. `now <ref> "<text>"` writes it; the card shows it on top:

```
DOING (1)
 1   Login fix: build                                          just now
     Now: merged, waiting for your deploy OK
     Fix the sign-in error on the login page.
```

- **A lineage moves together.** A card's lineage is the card, the cards above it and every
  card under it, but not its siblings. `now` writes the line on each open card of the lineage,
  unless `--only`; from the top card that is the whole family.
- **Events put older lines out of date**: on a card, a job's report (`job-report`, which also
  writes the job's own card's line), the card done (a top card too), the card moved back out of
  Done, and a `now --event merge|deploy|…` (the lines written with it are current) reach the
  lines above it, under it and its own; a sub-card added or removed (`add --parent`, `edit
  --parent` / `--no-parent`, `rm` of an open card) reaches the lines above it. A sibling's
  news never does: two jobs side by side under one card keep their own true lines. A line
  written before its card's last event shows `Now (out of date: card done on #3 since): …` in
  amber, and the card's row says `status out of date`.
- **Done first, then the line**: a script that finishes a sub-card moves it to Done and then
  writes the line (`now --event …`), so the line above it is current, not flagged at once.
- `inbox get <id>` prints one inbox message as JSON (acked or not): what `ship.mjs` reads to
  check that a board press it is given is a real answer on the card it ships.
- **The coordinator hears of it**: its turn reminder lists its cards with a line out of date.
  Cards with no line, and Done cards, are never out of date. (0.13.0 to 0.19.0 also blocked the
  coordinator's Stop once per card and event; since 0.20.0 the column a card shows in is worked
  out from its parts, and the Stop hook no longer blocks for a status line.)
- **A parent's line is its own** (0.20.0): a parent shows the line written on it, as any card
  does (0.16.0 to 0.19.0 built one from the cards under it, `Now: #437 working · #438 waiting on
  you`); its parts show their own state where they are drawn.
- **One Now per card** (0.17.0): a line that starts `Now:` in `--desc` (`add`, `edit`,
  `move`, `job-start`) is the card's status line: it is stored as its `now` (this card only,
  not its lineage), taken out of the description, and the latest one replaces the line before.
  Its words are checked as the description's were. Where it stands is never lost, cut or
  hidden: a line from `--desc` that anything else writes over (job-open, `job-report`,
  `not-run`, `now`) stays at the end of the description as `Earlier: …`; a later `--desc`
  that gives no status line ends a line the earlier `--desc` gave (when it has no `Now:` line
  at all, the old one stays at the end of the description as `Earlier: …`; a line that `now`
  or a script wrote stays, as it isn't the description's); a `Now:` line over
  200 characters, a second one, or one ending in `:` stays in the description, whole, with a
  warning; a Done card keeps its `Now:` line in its description (where it shows). `now` cuts a line over 200
  characters with a warning, never silently. A card from before 0.17.0 with its `Now:` line still in its description and no
  status line shows that line as its status line, and keeps it stored in its description
  until a `--desc` rewrites the card; a card with both keeps both until a `--desc` settles it,
  and `lint` points it out. The Queue's check reads the status line too.
- `json` shows `now` ({ text, at, by }; `from: "desc"` on a line given in `--desc`, 0.17.0) and `event` ({ kind, at, card }) on a card.

## For agents: running jobs with the board

**`board.mjs guide` (`node "$BOARD" guide`) prints the instructions for agents**: finding the CLI, which cards are
yours, writing cards, buttons, `answer` and Telegram, `job-start --worktree` and `job-report`.
It is the one text to give an agent (the job skill does); this section explains the same for
people. Any coordinator can use the board; it only needs a shell inside Herdr.

1. **Find the CLI**: `herdr plugin list --json` gives the plugin's `plugin_root`, and the CLI
   is `board.mjs` in it. If the plugin is not installed, skip the board and carry on.
2. **Work for later**: `add todo "<title>" --desc "<what and why>"`.
   Work found while doing another card (you need B before A can go on): add B with
   `--parent <A's id>` (`job-start` takes it too). B is a part of A, and A shows where its most
   urgent open part is (see Came from).
3. **You need the user** (a question, an approval, a merge):
   `add waiting "<title>: <action>" --desc "<what and why>" --ask "<one plain question>"` with
   2 to 4 buttons, the suggested one first:
   `--option "Merge the login fix" --option "Wait for the review" --suggest "Merge the login fix"`. A pressed button arrives in your chat as
   `Board card <id> (<tag> · <title>): <label>`, typed into your pane by Herdr; "Other…" means the
   user types the answer. When they have answered: `done <id>`, or `move`
   the card.
4. **A job starts**: a job is an agent you started in another pane under a Herdr agent name
   (`herdr agent start <slug> …`) that ends by writing a JSON report.
   `job-start <slug> --worktree <its worktree> --title "…" --desc "…" --report <report path>`
   (the card goes to the worktree's project). A further round of the same job (a new prompt to
   the same agent) is `job-start <slug> --id <its card> --report <the new report path>` again:
   the card goes back to Doing and points at the new report. The pane then shows that
   agent's live state, and moves the card under Waiting while the agent is blocked.
5. **Its report lands**: `job-report <slug>`. The report is JSON like:

   ```json
   { "status": "done", "summary": "one or two sentences", "needs_user": ["Merge the search filters fix?"], "notes": ["The old export still runs nightly."] }
   ```

   - `done` with no `needs_user` → Done. `notes` (things the user should know, no decision)
     never become the card's question; the details show them under "For your information".
   - `done` with `needs_user` → Waiting, asking what `needs_user` says (one `Needs you:` line each). An
     entry may be text or an object such as `{ "question": "…", "suggested_answer": "…" }`.
   - **The job's own question with buttons** (0.14.0): a `needs_user` of one entry
     `{ "ask": "Merge the login fix now, or wait for the review?", "options": ["Merge the login
     fix", "Wait for the review"], "suggest": "Merge the login fix" }` goes on the card as its
     question and buttons when the report is `done` and they pass the wording check (2 to 4
     labels, all text, each a verb plus the thing in 24 characters at most, one suggested, no
     numbers, no `[board …]` or `[job …]` markers). When it fails, the card gets its words
     without buttons, and job-report's output says why. A `blocked` or `failed` report never puts
     its own buttons on the card: its reason stays first, so one press can't approve a failed
     job's work.
   - **Numbers taken out** (0.20.0): PR, build and commit numbers in the report's words are taken
     out when they go on the card, silently (`Merge PR #83?` → `Merge the PR?`); nobody is asked
     to rewrite the card.
   - `blocked` or `failed` → Waiting, with `<status>: <summary>` as the reason.
   - `running` is a progress note; the board is left alone (exit 1).
   - **Test proof** (0.18.0): a job that changed files says which test or build it ran after its
     last edit, and how it ended: `"tested": { "command": "npm test", "exit": 0,
     "after_last_edit": true }`; a job that changed nothing says `"tested": "read-only"`. A
     `done` report with a commit or PR in `ids` (`commit`, `commits`, `pr` or `prs`) and no
     `tested`, a non-zero `exit`, or `after_last_edit` not `true` is **unverified**. That is
     shown, never blocking: the card moves as before, and its status line says "the job
     finished, unverified: no test run after the last edit" (or the failed run, or the run
     before the last edit); a tested one says "the job finished, tested (npm test, exit 0)". The
     card's row says `unverified` (a Done or Waiting card; a Doing card whose report isn't applied
     yet reads `report done, unverified`), and its details say why. A report with no commit or
     PR and no test run in `tested` (none, `"n/a"`, `"none"`: an older report, a research job)
     shows nothing; `"read only"` and `"readonly"` count as `"read-only"`. `tested` may list
     several runs, verified when all passed; a `command` may be a list of words. A card applied
     before 0.18.0 shows nothing either, on its row and in its details, and its report doesn't
     apply again. A new round (`job-start`) clears it until its report.
   - A card with open cards under it is no different (0.20.0; 0.12.0 to 0.19.0 held the report
     in Doing): the report applies, and the card shows where its most urgent open part is.
   - **A round's report** (0.20.0, `job-start --round`): the verdict of that check or fix round on
     the change's card (its `verdict`, its `findings` counted). A `done` one leaves the card in
     Doing, `check 1 finished: 2 problems` (the next step, a fix or the merge question, is the
     coordinator's); one that needs you, or is `blocked` or `failed`, goes to Waiting as any
     report does. A late report of an earlier round only records its verdict.

   The job's own Stop hook does this for you (the job skill's `job-board.mjs hook --jobs`): it
   calls `job-report <slug> <report> --if-final` from the job's pane, which sends no note of its
   own then: the job's `[job finished]` line is the one message for that stop. It does nothing
   until the report is final. Calling it again with the same report changes nothing: no second
   card, no new `updated` time, and edits you made to the card since stay (also for a report
   held before 0.20.0). A report rewritten with a different
   outcome or summary moves the same card again (a partial `done` the job later finishes is not
   lost), and you get a `[job note]` with its new summary, even when the card stays Done. A follow-up report (the job briefed again
   without `job-start`, after its card was done, or read by a restarted coordinator) uses the
   job's most recent card: one your pane owns or in your workspace, else a Done one. A report
   that needs nothing from you leaves a Done card as it is (`<id> stays done`); one that does
   (`needs_user`, `blocked`, `failed`) reopens it. **A report never makes a card** (0.15.0):
   after `job-close` unlinked the card (`edit <id> --job ""`; the card keeps the old slug in
   `former_jobs`), a late report goes on the card that carried the job (that link, the card with
   the same report file, or the card in the job skill's record of the job,
   `~/.local/state/job-skill/jobs/<slug>.json` or its newest `<slug>.closed-*.json`), never on a
   card linked to another job since. A `failed` or `blocked` report reopens that card in Waiting
   with the reason; any other report leaves it where it is, with the report and the status line
   `the job reported after it was closed: read its report`. Either way you get a `[job note]`. With
   no such card on the board (a job opened by hand, an archived card) no card gets the report:
   you get a `[job note]` with its status, summary and path, and add a card yourself if it needs
   one.
6. **It stops**: you hear at once (see Job messages below). A job's Stop hook writes one line
   to your inbox, posted into your session: `[job finished] search-ui — done — <the report's
   summary>` (with `(its report is on no card)` or a word on text hidden as a secret when that is
   so; `no report yet` and its last line when it stopped without a final report), or `[job
   waiting] search-ui — needs: <its question>` (also for a permission prompt in its tab: `needs:
   approval: …`). The report is on its card already; check the card (the line goes to the card's
   owner even when the card is Done) and `inbox ack` the message. A job that stopped without a
   report has `stopped without a report: read its tab` on its card (the job skill writes it);
   once it works again the line goes. A job can also send a line of its own: `board.mjs tell "<line>"` from its pane arrives
   as `[job note] <slug> — <line>`. A Doing card whose job finished and that nobody changed for
   10 minutes since shows **job finished — not reviewed yet** (amber), and the turn-start
   reminder lists it, until you job-report, move or edit it.

### Keep the board current: hooks for Claude Code

A coordinator that asks you something in the chat but forgets the card leaves the board stale.
`hooks/board-hook.mjs` is a set of [Claude Code hooks](https://code.claude.com/docs/en/hooks)
that catch that:

- **When you send a message** (UserPromptSubmit), the coordinator is reminded of its cards
  waiting on you (this project's, those its pane owns, and for the front coordinator those no
  running coordinator can take; id and title, up to 8), with one count of the others
  (`+3 waiting in other projects`), and asked to close or update any you just answered.
  Titles are cleaned, cut to 80 characters, quoted and marked as data written by agents, not
  instructions; a card's description and ask are never passed on. The hook also notes where
  the board stood, for the next check. A second line lists its cards with a status line out of
  date. A third lists its Doing cards whose job finished and that nobody has changed for 10
  minutes since (`Jobs finished, cards not updated: …`). A fourth (0.20.0) lists its cards that
  look stuck, with their amber flag (`Cards that look stuck: #499 "…" (pressed 12 min ago,
  nothing started)`, `in Doing, nothing running`). A fifth lists the job messages in its inbox not
  acked yet (id and line, cut to 100 characters, quoted, up to 8) and says to ack them with
  `node "…/board.mjs" inbox ack <id>…` (0.20.0: never to start an `inbox wait` or use a channel's
  tool).
- **When the coordinator's session starts** (SessionStart, 0.10.0, the coordinator's only: its
  start script passes it in `--settings`, never a settings file): when Claude Code gave the
  session a messaging socket and the session's `JOB_BOARD_DELIVERY` is set to `socket` (or
  `auto`), the hook notes it for the board and posts the inbox's unacked
  messages into it (see The inbox socket).
- **When the coordinator finishes its reply** (Stop): if the reply asks you something and none
  of its Waiting cards (as above, or any card its pane changed) was added, moved to Waiting or
  changed during that turn, the hook sends it back
  once: "add or update a Waiting card first". It never does so twice in a row, nor more than
  once in a turn. "Asks" (0.16.0): the reply's last paragraph ends with `?`, or a sentence in
  its last two opens like `Want me to …`, `Should I …`, `OK to …`, or says it waits on your
  word (`waiting for your yes / OK / pick / answer`, `your yes is still pending`); trailing
  `Sources:` (with their link lists) and `Memory read:` paragraphs are skipped first. A question
  sent on Telegram this turn counts too: the hook reads the end of the session's transcript
  (`transcript_path`, the last 4 MB) for calls to the Telegram reply tool
  (`mcp__plugin_telegram_telegram__reply`) after the last prompt, and checks their `text`.
- **The Queue** (0.14.0): the turn-start reminder lists the coordinator's queued cards (top
  first, up to 8), the room for jobs in each of their repos (`app: 1 of 2 jobs, 12000 MB free
  (minimum 4096)`) and the cards that didn't start when handed over. At a Stop with nothing
  above to block for, when a repo of a queued card has room, the hook sends the coordinator
  back with the top such card: start its job on that card, or move it to Waiting with one
  question. A card is handed over once as it is; after such a block the next stop may hand over
  the next card, and the run ends when no card is left to hand over. The room follows the job
  skill's rules: the repo's `max_active_jobs` (default 2) against the named Herdr agents working
  in its checkouts (this pane's own never), and the host's available memory against the repo's
  `min_free_mb` (default 4096), both from the repo's `.claude/job.json`, for every project with
  queued cards, and the reminder says why each card waits (`waits: app is at its limit of 2
  jobs`). A project outside git (a folder, a home coordinator's) has no checkouts to count: its
  room is unknown and its cards wait until they are retagged to the repo they are for. When the
  memory or Herdr's agent list can't be read, the room is unknown and nothing is handed over.
  Card titles and descriptions are marked as data, not instructions.

A reply "asks something" when its last paragraph ends with `?`, or a sentence near the end
starts like a request for a decision: "Want me to …", "Should I …", "Shall I …", "OK to …",
"Go?". Code blocks, inline code, quotes, block quotes and links don't count. It is a heuristic:
a question it misses goes unchecked, and when it fires without need, the coordinator says so
in one line and stops.

The hooks only act inside Herdr, for the coordinator (no role variable set to anything but
`coordinator`: `JOB_AGENT_ROLE`, any `*_AGENT_ROLE`, the repo's `.claude/job.json` `role_env`,
or `--role-env NAME`), never for subagents, and only once there is a board. While the repo's
0.4 board isn't brought in, the reminder says so. Anywhere else they print nothing. To install them, print the
settings and merge them into `.claude/settings.json` (this project) or
`~/.claude/settings.json` (everywhere):

```sh
node "$BOARD" hooks
```

(`$BOARD` as under Install; `hooks/board-hook.mjs --print-settings` prints the same.) They don't
include SessionStart: that one goes in the coordinator's start script's `--settings` only
(`node "$BOARD" hooks --coordinator` prints it; see The inbox socket). The path
in them is the plugin's folder. Herdr 0.9.3 keeps it across updates; 0.9.5 installs each update
to a new folder and removes the old one once nothing uses it, so after an update print them again
(`doctor` says when they run an older install folder), or point them at the job skill's
`job-board.mjs`, which finds the installed copy itself.

Each session's turn record is kept in the store's `turns/` folder and removed after 7 days.

**In a job's pane** (a worker: a role variable set to anything but `coordinator`, with a Herdr
agent name, the job's slug), the same hooks tell its coordinator when it stops:

- **Stop**: one line, `[job finished] <slug> — <report status, or no report yet> — <the report's
  summary, else the last line it wrote>` (0.20.0: `(its report is on no card)` when no card
  carries the job, its report read from the job skill's record; a word when text in the report
  looked like a secret); or, when it has no final report and its reply asks something, `[job
  waiting] <slug> — needs: <the question>`. One message per stop: `job-report`, run from the
  job's pane before it, sends no note of its own.
- **Notification** (`permission_prompt`): `[job waiting] <slug> — needs: approval: <what it asks>`.
- **UserPromptSubmit** (0.20.0): the job works again, so the `stopped without a report: read its
  tab` (or `stopped on an error`) line its last stop left on its card is cleared; while its
  agent works, the board doesn't show that line anyway.

The line goes to the coordinator's inbox (see Job messages), written by a background process so
the hook returns at once. It waits a moment (`JOB_BOARD_NOTIFY_DELAY_MS`, 3 s) and writes nothing
when the job is working again by then (Herdr's status, looked at for a few seconds). The same
line is never written twice in a row, and two copies of the hook (a repo's settings and your
global ones) write it once. Jobs run in any repo, so put the hooks in `~/.claude/settings.json`
too, or the job skill's equivalent (`job-board.mjs hook --jobs`, which does nothing outside a
job's pane).

### Job messages: the inbox

Since 0.8.0 a job never types into its coordinator's pane. (0.7.2 to 0.7.5 did, with
`herdr agent prompt`: the line broke into whatever you were typing there, and was cut at 300
characters.) Its hooks and `tell` append one JSON line per message to `inbox.jsonl` in the
board's folder. They are posted into the coordinator's session (see The inbox socket), and the
job's own stop has put its report on its card already:

```sh
node "$BOARD" inbox ls            # the messages not acked yet
node "$BOARD" inbox ack <id>…     # after checking the cards
```

- **A message**: `{ id, at, slug, kind, card, project, workspace, owner, pane, key, text }`.
  `kind` is `finished`, `waiting` or `note`; `text` is the whole line (up to 4000 characters, one
  line, cleaned); `owner` the card's owner pane when it was written, `pane` the job's.
- **Whose it is**: a coordinator's messages are its Herdr workspace's. The message's `workspace`
  is where the card's owner pane wrote from (the board notes each coordinator's workspace), else
  the card's, else the project's, else the job's own. Not the pane id: a coordinator restarted in
  another pane (a new pane id) is in the same workspace, so everything written while it was down
  is waiting for it. Every coordinator in that workspace sees it; outside Herdr, `inbox ls` shows
  every message.
- **Nothing is lost**: a message stays until acked (at least once: a coordinator that restarts
  before acking sees it again), and the acks are lines in the same file, so they survive
  restarts.
- **The write**: under the inbox's own lock (`inbox.jsonl.lock`, as the board's; never the
  board's lock, so a busy board doesn't hold a job up), once per message id. A write that fails
  (the lock busy, an I/O error) is tried again with a growing pause for up to 60 s
  (`JOB_BOARD_INBOX_RETRY_MS`). If it still fails, the message is kept in the job's
  `jobs/<slug>.json` as `pending`, and the job's next hook run (any Stop or Notification, or its
  next `tell`) writes it first. A hook never blocks the job: the writing is in the background,
  and the hook always exits 0.
- **The reminder**: the coordinator's turn-start reminder lists the messages not acked yet. (`inbox
  wait` still returns with them for a script that wants it; the reminder no longer asks for one,
  0.20.0.)
- **The file**: acked messages older than 7 days are dropped once it grows past 256 KB.

Without the inbox socket, button presses are not job messages: a press reaches the coordinator
with `herdr agent prompt` (you pressed it on purpose).

### The channel (0.9.0)

`channel/` is a Claude Code channel plugin (a research preview) that pushed inbox messages and
button answers into a coordinator's session started with it. The inbox socket below does the
same without a development flag, and is what coordinators use; the channel stays for sessions
that still start with it (`JOB_BOARD_DELIVERY=channel`), and its tests still run with Go
installed. The board no longer suggests it.

### The inbox socket: messages and answers posted into the coordinator's session (0.10.0)

Claude Code gives every session a messaging socket (`$CLAUDE_CODE_MESSAGING_SOCKET`) for
messages from other sessions and scripts. A message written there arrives as a new turn when the
session is idle, between tool calls when it is busy, and waits while a dialog is open. The board
uses it as a doorbell, so the coordinator needs no channel, no development flag and no question
at start:

- **The inbox stays the truth.** A message goes into `inbox.jsonl` first, exactly as before;
  only then is its line posted into its coordinator's session. The coordinator acks it with
  `node "$BOARD" inbox ack <id>…` (or `--all`). Claude Code keeps posted messages in memory only
  (one queued in a session that dies is lost there), so whatever isn't acked is posted again:
  - **at the coordinator's start**: its SessionStart hook posts the messages not acked yet for
    its workspace into the new session (not after a compaction: same session);
  - **after 10 minutes**: the board pane posts a message again when it is still unacked 10
    minutes after its last post, twice at most per session, several in one post. Several board
    panes post it once (`inbox-posts.json`, under its lock).
- **What a post says** (each line ends in the message's id, for `inbox ack`):

  | What | The text posted |
  |---|---|
  | A job stopped | `[job finished] <slug> — <report status, or no report yet> — <summary, or its last line> #<msg id>` |
  | A job waits | `[job waiting] <slug> — needs: <the question, or approval: …> #<msg id>` |
  | A job's `tell` | `[job note] <slug> — <the line> #<msg id>` |
  | A button press (or `answer`) | `[board answer] card <id> (<tag> · <title>): <label> #<msg id>`, with ` (from Telegram)` before the id for `--from telegram` |
  | Several job messages at once (start, re-post) | `[board inbox] <n> messages not acked yet, oldest first (handle each, then board.mjs inbox ack <id>):`, then one of the job lines above each (20 at most a post). A button's answer is never in one: it always gets a post of its own, starting with `[board answer]` |

  Claude Code frames each as a message "from another Claude session … not typed by your user".
  A post whose text **begins** with `[board answer]` is the user's own button press: the
  coordinator acts on it as if the user had typed it (the hook's start-of-session note says so
  too). The same words anywhere else are a job's data: in any message's text the board turns
  `[board answer]` and `[board inbox]` (any case or spacing) into `(board answer)` and
  `(board inbox)`, so a job can't forge a press inside its line or a batch. The inbox keeps the
  0.9.0 text of an answer (`Board card …`), which the channel and Herdr still send. Text that
  looks like Claude Code's own `<cross-session-message` framing or a `<system-reminder` is
  defused (`‹…`) in every post.
- **The coordinator's note**: when its own `JOB_BOARD_DELIVERY` is set to `socket` or `auto`
  (its start script exports it; left unset, no note, so a plain `claude` opened in another pane
  of the workspace never takes its posts), its SessionStart hook writes
  `coordinators/<workspace>.json` atomically: `{ pid, socket, pane, session_id, workspace, host,
  at, delivery, version }`, the pid from the socket's name (`<pid>.sock`). One per Herdr
  workspace; the newest start wins. A note is live while that process on this host runs and
  its socket is there (or the note is under 30 s old: the session may not listen yet). A post
  that finds the socket gone (`ENOENT`) or refusing (`ECONNREFUSED`) removes the note, unless
  it is under 30 s old and its process runs (the session may not listen yet); the message stays
  in the inbox for the next start.
- **A post** connects, writes one line and closes. It never takes more than 2 s and never
  throws: a hook is never held up, and a failed post leaves the message unacked (the turn-start
  reminder lists it). A button press whose post fails acks its own inbox message and goes on to
  the channel, then to `herdr agent prompt`, so the answer isn't delivered twice. One that timed
  out after connecting may have been written: it counts as posted, stays unacked (posted again
  after 10 minutes) and isn't also typed or sent by the channel.
- **Which way, `JOB_BOARD_DELIVERY`**: read by the process that sends (a job's hook, `tell`,
  the board pane, `answer`), and by the coordinator's SessionStart hook (whether to keep a
  note at all: only when set). The turn-start reminder counts only its own pane's note.

  | `JOB_BOARD_DELIVERY` | Job messages | Button answers | The coordinator's note |
  |---|---|---|---|
  | unset (`auto` for senders) | inbox, posted when a note is live | socket, else channel, else typed | none |
  | `auto` | inbox, posted when a note is live | socket, else channel, else typed | kept |
  | `socket` | inbox, posted when a note is live | socket, else typed | kept |
  | `channel` | inbox only (the channel pushes them) | channel, else typed (0.9.0) | none |
  | `prompt` | inbox only (`inbox wait`) | typed with `herdr agent prompt` (0.8.0) | none |

  Start a coordinator with one of the socket and the channel, not both: with both, every message
  arrives twice (harmless: the id is in each, and an ack is idempotent).
- **The wire format is Claude Code's own** and not documented (only the socket, its variables
  and an auth line are). It lives in one function, `wireLines` in `board.mjs`: one JSON line,
  `{"type":"user","message":{"role":"user","content":"<text>"},"from":"job-board","msg_id":"<id>"}`.
  Tested with Claude Code 2.1.312 (`SOCKET_TESTED_WITH`). After `claude update`, run the smoke
  test, which starts one throw-away `claude -p` (Haiku) with the board's SessionStart hook on a
  scratch board, and checks that both the start's replay and a posted `[board answer]` reach it:

  ```sh
  S=$(mktemp -d /tmp/jb.XXXX); HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp \
    JOB_BOARD_SMOKE=1 node --test tests/socket-smoke.test.mjs
  ```

  If an update breaks the format, posts fail or go unseen; the messages stay unacked, the
  reminder lists them, and `JOB_BOARD_DELIVERY=channel` (or `prompt`) goes back to the old way.

#### What a coordinator's start script must do (the coordinator side)

- **Register**: run the board's SessionStart hook in the coordinator's session, from its start
  script's `--settings` only (`hooks --coordinator` prints it; the same command,
  `node "<board>/hooks/board-hook.mjs"`, as the other events). Never put it in a settings file:
  a `claude` started from the coordinator's shell (a `claude -p` it runs) inherits its
  `JOB_BOARD_DELIVERY` and would take its note and its posts; `doctor` says so.
  It needs `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID` and Claude Code's
  `CLAUDE_CODE_MESSAGING_SOCKET`, all set for it already inside Herdr.
- **Ack**: `node "$BOARD" inbox ack <id>… | --all` (the channel's `ack` tool goes with the
  channel). `inbox ls` lists what isn't acked.
- **Choose the way**: export `JOB_BOARD_DELIVERY=socket` for a coordinator started without the
  channel: without it the hook keeps no note and nothing is posted into the session. Export
  `channel` (or leave it unset) for one started with the channel: 0.9.0 exactly.
- **One `--settings`**: Claude Code applies only the last `--settings` flag, so merge
  everything into one, with `"crossSessionInbound": "accept"` for the coordinator only (so a
  board post is never held behind an approval dialog that expires), and the SessionStart hook
  (`node "$BOARD" hooks --coordinator` prints both):

  ```sh
  claude --settings '{"crossSessionInbound":"accept","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \"<board>/hooks/board-hook.mjs\""}]}]}}'
  ```
- **Trust**: with `accept`, any process running as you can start a coordinator turn through
  its socket (0600, in a 0700 folder of yours), no more than `herdr agent prompt` can today.

### Writing cards

The user reads a card with no other context: not the chat, not the job's instructions.

- **title**: the thing in plain words, then the kind of action: `…: approve`, `…: merge`,
  `…: review`, `…: pick one`; for jobs `…: build`, `…: fix`. No internal slugs or shorthand.
- **desc**: what it is and why it matters, first, in one or two plain sentences: that
  paragraph is what a card shows. More can follow (0.9.0): paragraphs (a blank line), `- ` or
  `• ` items, and lines that start with a label (`Why:`, `What changes:`, `Risk:`, `Your
  answers:`; up to four words, then a colon) are kept and shown so in the card details and in
  `ls`. Pass real newlines in `--desc`, or `\n`. When a line wraps (0.17.0), its next lines
  hang under its text: a `- ` item's, a numbered step's (`1. `, `1) `), a `-> ` line's, and
  the text after a leading label (by two cells when the label is wider than a third of the
  line); the status line hangs under the text after its `Now:` too. Write sections as `Label:` lines with `- ` items under them, no headings of your own
  inside a section, and each button's meaning in an `Each answer:` list; where things stand
  goes in the status line, not the description. `lint` warns on a plain line over about three
  lines.

  ```
  What: a second provider as an active node; no automatic top-up.
  Flow:
  - Before go-live: credit and the traffic pool are bought; live only after both are confirmed.
  - Warn (credit or pool low): ask for a top-up within five working days.
  Each answer:
  - Flow is right: I write it up as the runbook.
  - Change the flow: tell me what to change.
  ```
- **ask** (Waiting): exactly what the user should do.
- **result** (0.19.0): the answer, the draft or the figures the user asked for, on the card
  with `board.mjs result <ref> --file <path>` (or `-` for stdin), never only in the chat: a
  chat that compacts or restarts loses it from the user's screen, and the card keeps it. It is
  the text itself, kept as written; the description still says what it is and why.
- **A new question brings its explanation** (0.16.0): `edit` or `move` that changes `--ask`
  also sets `--desc` in the same call, with a line that starts `Now:` (where things stand and
  what the answer decides), e.g. `--desc "The fix is merged.\nNow: the deploy waits for your
  word."`, or (0.17.0) the card already has a current status line (`now <id> "…"`, with no
  event since); otherwise exit 2 and nothing is written (`--allow-wording` doesn't skip it).
  The `Now:` line becomes the card's status line, shown once at the top of the card (see
  Status lines). The same question again, or clearing it, needs nothing. A command the user must run (a line
  starting `! `, or a code line) goes on the card in that same edit, in `--desc` or `--ask`,
  never only in the chat: the board can't see the chat, so that part is a rule, not a check.

| | Bad | Good |
|---|---|---|
| title | `Login mockup: 3 picks` | `Login page redesign: approve` |
| desc | – | `New sign-in screen with SSO buttons and a clearer error message. 3 small choices to confirm.` |
| ask | `Pick the 3 choices` | `Open the mockup, reply ok or change` |

When `job-report` moves a job to Waiting with the job's own words and no buttons (the job didn't
send its question with buttons, or they failed the check), rewrite its title and ask for the
user, with its buttons, in one edit: `edit <id> --title "…: approve" --ask "…" --option "…" --option "…"
--suggest "…"`. The CLI prints a tip when a card has no `--desc`, or a Waiting card no `--ask`.

#### The wording check (0.11.0; the answer list 0.13.1; short-name titles 0.14.0)

The rules above are checked, so a card that breaks them never reaches the board. `add`,
`edit`, `move … waiting` and `job-start` check the whole card they leave (an edit of one field
still has to leave the card right) and, when it fails, write nothing and print each problem
with its fix (exit 2):

```
board: card 12 is not in plain words yet, so nothing was written:
  - the ask says "PR #83", a PR number: name the thing instead ("the login page fix", "the new Cost page")
  - its buttons: no answer buttons: a Waiting card with a question needs 2 to 4, one suggested: --option "<verb + thing>" …
```

| What | Where | Refused or warned |
|---|---|---|
| PR numbers (`PR #83`, `pull request 12`), `#161`, `build 674`, commit hashes (`7f96574`), an approval keyed by a number (`58, merge it`) | title, description, ask, button labels | refused |
| version strings (`0.7.0`, `v8.5.1`) | title, ask, button labels | refused |
| version strings | description | warned: there it is often the thing itself (the firmware a customer runs) |
| a question (`--ask`) on a Waiting card without 2 to 4 buttons, or none suggested | Waiting cards | refused |
| a label of one word (`Go`, `Hold`), with `+`, `/` or `&`, `next` / `then` / `continue`, a step number (`steps 3–5`), an option letter (`Only A and C`) or a code (`1P`, `M3`) | button labels | refused |
| `[board …]` or `[job …]`, the board's own markers | button labels (and a job's own question) | refused |
| a title that is only a job's short name (`daily-review-1030`: one lower-case word with dashes, or the card's job) | title | refused by the command that sets it (`add`, `edit --title`, a new card from `job-start`); on an old card a warning, so `job-start --id` still starts its job's next round (0.14.0) |
| an `Each answer:` list (one `- <label>: …` line per button; `=`, `→` or a spaced dash work too, and quotes or bold around the label; a `- Either way: …` line is skipped) that names a button the card doesn't have, or misses one it has (the buttons changed, the list didn't) | description of a card with buttons | refused; `lint` warns. Change the buttons and the list in one edit |

Links (`https://…/pull/83`) and card numbers (`card 373`) are fine. When the exact text is
what the user needs, `--allow-wording` writes it; the card remembers what was allowed
(`wording_ok`), so a later edit of something else and `lint` leave it alone while it is
there.

`job-report` never refuses (a job's Stop hook runs it, and nobody sees its output). Since
0.20.0 it takes the numbers out of the report's words when they go on the card (`Review and
merge PR #83` → `Review and merge the PR`), silently: no note asks the coordinator to rewrite
the card. The details panel shows a summary or need with numbers only under More…. A job's own
question with buttons (`needs_user: [{ "ask", "options", "suggest" }]`) that passes the check
goes on the card as it is (0.14.0).

`lint` lists the open cards that fail, for cards written before the check.

**No secrets on a card** (0.18.0). A card reaches the pane, the coordinator's session and
Telegram, so `add`, `edit`, `move`, `now`, `result`, `job-start`, `not-run`, `answered` and `tell` refuse text that
looks like a secret, in any text they are given (title, description, question, button labels,
status line, the note, a result: from a file or stdin too): a private key, an AWS access key, a GitHub, Anthropic, Slack or
Telegram-bot token, a Slack webhook, a bearer token, or a `password=`, `secret=`, `token=` or
`api_key=` (or `:`) with a real value, markdown around it or not (`` password: `…` ``,
`**password**: …`, `**DB password:** …`). The refusal exits 2 and names the field and the kind, never the text;
`--allow-wording` doesn't change it. It reads the text as the card would store it, without
format characters (a soft hyphen or zero-width space can't split a token). Not a secret: a git
hash (7 or 40 hex; 8 to 12 hex after a secret's key is read as its value), a UUID, a date, a
version (dotted numbers after `v` or a short lower-case name, with a mark such as `-rc.1` at
most: `fw8.5.1s024`, not `Hunt3.14-love`), `${VAR}`, `$VAR`, `<placeholder>`,
`****`, an `op://` reference, `os.environ/…`, `secrets.…`, an AWS ARN, a variable's name
(`ANTHROPIC_API_KEY`; one word in capitals only when it ends like one, `DEPLOYTOKEN`, not a
passphrase in capitals), a property (`config.db_password`), a function call, a secret's name
after `secret:` (`secret: prod/db-credentials`; after `passphrase:` the same shape is the
passphrase), a file path, AWS's documented example key, or a word ("token: expired"). Say where the secret is kept instead ("the deploy token is in
1Password: Service-Accounts-Vault", "Deploy token: 1Password (Dev vault)").
`job-report` never refuses: a `summary`, `needs_user` entry or note that holds one is shown as
"(hidden: looked like a secret)" on the card, in its details and in the notes (the report file
is left as it is), and the coordinator gets a `[job note]` naming the fields (from the job's own
pane, its `[job finished]` line says so instead, 0.20.0). The Stop hook's `[job finished]` /
`[job waiting]` line hides one the same way, also after it tidies the markdown away.

## The store

One board for every project on the machine, at
`${XDG_STATE_HOME:-~/.local/state}/herdr-job-board/board.json` (`board.mjs path`).
`JOB_BOARD_HOME=<folder>` puts a board of its own there, `JOB_BOARD_FILE=<path>` another file
(a 0.4 board file given there is read as it is and written back in the new shape); neither ever
brings the repos' 0.4 boards in. Beside it:

```
board.json            the board (readable by you only)
board.json.lock/      the write lock
archive/2026-10.jsonl Done cards older than 7 days, one JSON line each (json --archive, ls --done)
backups/              board-<date>.json (the first write of each day, 7 kept; restore puts one back),
                      import-<time>/<repo>.json (each 0.4 board an import brought in)
turns/                the Stop hook's turn records, and the kind of its last block per session
queue.json            the Queue's cards handed over, as they were (0.14.0)
jobs/<slug>.json      each job's last stop (finished or waiting, when, whether it was sent) and
                      its messages pending while the inbox couldn't take them
inbox.jsonl           job messages and their acks (see Job messages); inbox.jsonl.lock/ its lock
inbox-watch/<pid>.json  each running `inbox wait`
channels/<pid>.json   each running job-board channel (0.9.0)
runs/<card>-<id>.log  each press run's output (0.20.0): the merge script's run stage, started by a press
coordinators/<workspace>.json  each workspace's coordinator session and its socket (0.10.0)
inbox-posts.json      when each message was last posted into a session, and how often again
tokens.json           the sidebar text last reported for each workspace
```

```json
{
  "version": 2,
  "next_id": 212,
  "front": "w4:p6",
  "projects": {
    "sfc-integration": { "tag": "sfc", "color": "magenta", "root": "/home/me/sfc-integration", "git": "/home/me/sfc-integration/.git", "workspace": "w4" }
  },
  "coordinators": { "w4:p6": { "workspace": "w4", "project": "sfc-integration", "seen": "2026-10-19T11:56:00.000Z" } },
  "items": [
    {
      "id": 170,
      "project": "sfc-integration",
      "origin": "w4:p6",
      "workspace": "w4",
      "title": "magicwan v343 fleet rollout: approve the waves",
      "desc": "Pilot healthy since 16 Oct; 181 nodes in 40 cities.",
      "column": "waiting",
      "job": "",
      "ask": "Approve: wave 1 LON (5), then by region",
      "since": "2026-10-19T09:05:00.000Z",
      "updated": "2026-10-19T09:05:00.000Z",
      "options": [{ "label": "Go", "suggested": true }, { "label": "LON only first" }],
      "sent": { "label": "Go", "at": "2026-10-19T12:03:00.000Z", "pane": "w4:p6", "to": "sfc coordinator (w4:p6)" }
    }
  ],
  "panes": { "w4:t1": { "pane": "w4:p14", "origin": "w4:p6", "at": "2026-10-19T10:00:00.000Z" } },
  "reports": { "6b722c47701fe0ea": { "id": 1, "at": "2026-10-19T08:00:00.000Z" } },
  "imports": [{ "from": "/home/me/sfc-integration/.git/job-board.json", "project": "sfc-integration", "cards": 196 }]
}
```

- Every card has a `project` (its repo, by git's common dir, so worktrees count as their repo),
  an `origin` (the coordinator pane that owns it: where its answers go) and a `workspace` (where
  it was written, for the sidebar count; its job's agent is looked for there first, then in any
  workspace, since a job may run in its project's). Ids are global and never
  reused.
- A project's `tag` is its name's first part (`sfc` for sfc-integration), at most 7 characters,
  made unique when two would clash; `project set` changes it and the colour.
- `column` is `todo`, `doing`, `waiting` or `done`; `since` is when the card entered it. `ask`
  holds one line per thing to do. `options` are the answer buttons; `sent` the last answer sent
  (and to whom). `reported` and `reports` mark which job report already moved a card, so a repeat
  changes nothing, even after the card is archived.
- `result` (0.19.0) is the card's result, a string with its lines as written, and `result_at`
  when it was written; a card without one has neither field (`result --clear` removes both).
  Archived Done cards keep them.
- Done cards stay 7 days (the Done section shows today's), then move to `archive/`.
- Only `board.mjs` writes the file (the pane, through it, writes `sent`). It takes a lock
  (`mkdir <file>.lock`, with the owner's process id in it), writes a temp file and renames it
  over the board, so readers never see half a file and writers at once don't lose each other's
  cards (tested with 4 writers × 200 cards). A lock is taken back only from a process that is
  gone, never from a slow one.

## Safety

- It runs only `git rev-parse` and the `herdr` CLI, with argument lists and no shell, except
  `herdr pane run` to start the board in its pane (paths are single-quoted). No network, no
  dependencies.
- Only the installed plugin, at 0.5.0 or later, writes a board (or Herdr's `config.toml`) under
  your home: a git checkout of it, or an older copy, refuses with one line, so trying a
  development copy can't migrate or change your real boards.
- Text is stored without control characters, escape sequences, bidirectional controls or other
  invisible format characters (zero-width spaces and joiners, word joiner, BOM, soft hyphen), and
  everything the board or the CLI prints is cleaned again (`json` writes such characters as
  `\u` escapes), so text an agent writes can't change your terminal.
- It types into its own pane: `open` runs the board there only while the pane is at a shell
  prompt, and sends `q` only to a board it finds running there.
- Answer buttons send exactly `Board card <id> (<tag> · <title>): <label>` (the id a whole
  number, tag, title and label cleaned), only through `herdr agent prompt`, as one argument, to
  the card's coordinator (see Answer buttons); or, to a coordinator with a live inbox-socket
  note, the same with `[board answer]` in front and its message id after, through its
  session's socket (0600, in a 0700 folder of your own); only such a post begins with
  `[board answer]`, and the words inside a job's message are defused to `(board answer)`, so a
  job can't pose as a press. Herdr checks the agent's state itself and refuses one that is waiting
  on a question, so a button never presses Enter on someone else's prompt. The board never
  types into another pane: Other… only switches to it.

## Limits and threat model

- **Who can add buttons.** A button puts text into the coordinator's chat, so only the
  coordinator should add them. Cards that come from a job (`job-start`, `job-report`) never get
  buttons, whatever the job's report says. Anything that can write the board file can add
  buttons, though. The file is in your home's state folder and readable only by
  you, so that means programs running as you. If you run other agents as workers, a pre-tool hook that blocks
  `--option` and `--suggest` helps, but it matches command text, so it is best-effort: a worker
  that can run commands as you can also write the file directly, or type into any pane with
  `herdr pane send-text`. Even then, a button only sends its own label, with the card's id and
  title, to the coordinator, and only when you press it.
- **No answer without choosing.** Enter on a card opens its details; it presses a button only
  after you chose one with ← → or a click on the question (either picks the suggested one, or
  the first button when the card has no `--suggest`). A click on a button presses it at once; a
  click on the question only chooses, and the question is never drawn as a button. Only a
  button on the screen you see can be chosen or pressed: on a card cut short by a small pane,
  nothing off screen is chosen, Enter opens the details instead, and "Enter to send" shows
  only while the chosen button is on screen.
- **Links and the clipboard.** A hyperlink's target is exactly the URL shown, checked against a
  strict pattern; nothing else from a card becomes a link. The board writes the clipboard only
  when you press `c`, with only the selected card's link or text; it never reads the clipboard.
  A card's text can still be anything an agent wrote: look at a link before you open it.
- **Locks.** A lock left by a process that is gone is taken back at once, but if the system has
  already given that process id to a new process, the lock waits until that one ends too (the
  writer gives up after 10 s with "the board is locked by process N"; remove the `.lock`
  folder if nothing is writing). Taking back a stale lock checks it is the same one, but two
  writers racing for it within the same instant could still overlap; it needs a crashed writer
  plus two writers within microseconds.
- **Restoring the terminal.** The board switches mouse reporting off and leaves its screen when
  you quit with `q` or Ctrl-C, when it gets SIGINT, SIGTERM or SIGHUP (closing the pane sends
  SIGHUP), and when it crashes. A kill it can't catch (`kill -9`) leaves that pane printing
  mouse codes: run `reset`, or `printf '\e[?1000l\e[?1006l'` to switch only mouse reporting
  off.

## Tests

Run them with a scratch home, which they insist on (`tests/guard.mjs` refuses your real HOME,
and the board refuses to touch anything outside the scratch folders while they run):

```sh
S=$(mktemp -d); HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp node --test
```

Herdr is faked (`tests/fixtures/fake-herdr.mjs`); nothing touches your real Herdr session.
`UPDATE_SNAPSHOTS=1 node --test` rewrites the render snapshots. With Go installed, the channel's
tests run too (its `go test`, and the binary against the board's inbox); `cd channel && go test
./...` runs its own. The inbox socket's smoke test (`tests/socket-smoke.test.mjs`) talks to a
real Claude Code session, so it is skipped unless you ask for it; run it after `claude update`
(see The inbox socket). `board-pane.mjs --once --width N
--height N [--layout wide|inbox|compact] [--color] [--emoji] [--keys …]` prints one frame.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

MIT, see [LICENSE](LICENSE).
