# herdr-job-board

A board beside your chat for work you hand to coding agents: **WAITING ON YOU** first, then
**DOING**, **TO DO** and **DONE**. It is a [Herdr](https://herdr.dev) plugin: the board
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
             sfc-integration · Fable plan (docs PR #143): audit of every page with screenshots,
             one wording guide, shared components (CitySummaryRow, CountChip, DefaultVersion…)
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

📋 TO DO (4) ──────────────────────────────────────────────────────────────────────────────────
  6   Export to CSV                                                                       1 min
  7   Dark mode                                                                           1 min
  8   Pick next: onboarding or settings                                                   1 min
  9   Upgrade the test runner                                                             1 min

🏁 DONE · 1 today ▸

Tab section · ↑↓ card · Enter details · c copy · d done · m mouse: board · q quit
```

| Pane | Layout |
|---|---|
| 120 columns or wider | **wide**: WAITING ON YOU across the top (two cards a row, each with its description, question and buttons), DOING and TO DO in two columns below; an empty Doing folds to one line over To do |
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
  idle, no agent) and its age. A card whose agent is **working** shows a small ASCII bar
  bouncing beside the word (`working [=   ]`); idle, done, blocked and gone agents stand still,
  so the motion itself says what is running.
- **Order**: To do, Doing and Waiting on you are in your order, so the cards that matter most
  can sit on top. A new card goes on top of its section, and so does a card that moves into
  another section (To do → Doing, Doing → Waiting, back to To do). `Shift+↑` `Shift+↓` move the
  selected card one place up or down in the pane; `order <ref> top|up|down|bottom` does it from
  the command line (a coordinator, when you ask it to). One rule stays above your order: in
  Waiting, a **blocked** job shows first, since it is stuck until you answer it. Done is newest
  first. A board from before 0.6.0 starts newest first (the highest id on top) in each section.
- **DONE** is folded to one line, `DONE · 3 today ▸`, so it takes no room. `d` or a click on
  that line opens it (today's finished cards, newest first, with the time they finished, under
  `DONE (3) ▾`; a third column in the wide layout); `d` or a click on its header folds it
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
  WAITING ON YOU amber, DOING blue, TO DO plain, DONE dim green, each header followed by a rule
  in its colour in the inbox and compact layouts; the "need you" count amber; the selected row's
  id in reverse video; the agent's state green (working), red (blocked), cyan (idle or done) or
  grey (no agent); every button filled grey (the suggested one bold, with ✓; the chosen one
  blue), while the question stays plain text in no button's colour; and a Waiting card's age red
  after a day. Colour is never the only sign: the selection is marked `▸`, a waiting card `!`,
  the agent's state is a word, an empty section says so, and the buttons keep their `[ … ]` and
  `< … >`. `NO_COLOR` turns colour off.
- **Emoji**: each section's header starts with one (🔔 Waiting, 🔨 Doing, 📋 To do, 🏁 Done) in a
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
| `Tab` / `Shift-Tab`, `←` `→` | select a section (its header is marked ▸); Done only while it is open |
| `↑` `↓`, `j` `k` | select a card in the section (marked ▸); the view follows. In the inbox the selected card is open under its row |
| `Shift+↑` `Shift+↓` | move the selected card one place up or down in its section, and save it (To do, Doing, Waiting; not Done). In a view of one project (`p`) it steps over that project's cards; the key line says `card 3 moved up`, or that it can't go further |
| `Space` | in the inbox and compact layouts: open or close the selected card under its row (the inbox opens it by itself, compact doesn't) |
| `Enter` | open the selected card's details (with no button chosen); `Esc` closes them |
| `←` `→` on a card with buttons | choose a button (the suggested one first); the key line then says `Enter to send`, `Enter` presses it, `Esc` un-chooses it. Only buttons on screen count: a card whose job is blocked shows none, so none can be chosen; on a card cut off above its buttons none can be chosen either, and `Enter` opens its details. On a closed row (compact) `←` `→` move between sections |
| `o` | Other… on a card with buttons |
| in the details | `↑` `↓` `PgUp` `PgDn` `g` `G` scroll; `←` `→` choose one of the card's buttons and `Enter` presses it; with no button chosen, `Enter` or `f` shows or hides More… (the rest of the job's report), and `Enter` closes the details when there is no More…; `o` is Other…; `Esc` closes them |
| `c` | copy the card's first link, or its text; `c` again: its next link (Alt+c does nothing) |
| `d` | open Done (a third column) or fold it back to its one line; a click on the line, or on the open header, does the same |
| `p`, `P`, a click on the strip | with cards of several projects on the board: `p` shows the next project's cards only (in the strip's order), `P` every project again; a click on a project in the strip shows it, on `all` every one. A view of one project counts what it hides (`TO DO (6 · +4 other)`, `(+1 in other projects)` in the title); another project's blocked job still shows under Waiting. The filter is the pane's own |
| `t` | go to the job's tab |
| `m` | mouse capture off (select text in the terminal) and on again. While it is off the board draws one column (the inbox) at any width, so a drag across the pane selects one card's lines and never the column beside it, and the open card shows all of its title, description and question (nothing cut with `…`); a card taller than its section says `card cut off: Enter shows the rest in its details`; the key line starts `selecting text: m gives the mouse and the columns back` |
| `PgUp` `PgDn`, `g` `G` | scroll a page; first / last card |
| mouse | wheel scrolls the section under the pointer; a click selects a card, a double click opens it, a click on a button presses it, a click on a card's question chooses its suggested button (or the first) for `Enter`, and never sends; a click on Done's line or header opens or folds it. A click on a button presses it only once the button has been drawn where it is for a second: a button that just appeared or moved there (a click opened a card and moved the rows, the details opened, closed or scrolled, a refresh moved a section) only selects its card, wherever the click lands, on the board or in the details. The second click of a double click on a card's row opens its details. With mouse capture off (`m`), click reports are ignored |
| `q`, `r` | quit; redraw |

The key line at the bottom shows the main keys and the mouse mode (`mouse: board` or
`mouse: select`), plus a short message after `c`, `t` or `m`.

### Card details

`Enter` (or a double click) opens the selected card over the lower half of the pane. The panel
covers everything from the middle down to the key line: nothing of the board shows through it,
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
- **What it is**: the description. **What you need to do**: the ask and the card's buttons
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
- **Copy.** `c` puts the selected card's first link on the clipboard, or the card's text when
  it has no link (OSC 52, at most 8000 characters), with the buttons it shows (a blocked job's
  card shows none, so none are copied), and the key line says what was copied. On a card with
  several links, `c` again copies the next one, in the order the card and its report show them,
  then the first again; the key line says which (`copied 2/2: Artifact https://…`) and, where it
  fits, reads `c copy (again: next link)`. Another card, or opening or closing the details,
  starts at the first link again. It happens only
  when you press `c`. Herdr passes a pane's clipboard writes to your terminal;
  your terminal must allow them (most do; some ask first or need a setting such as
  "allow clipboard access").
- **Select text yourself.** `m` turns the board's mouse capture off: Herdr's own drag-select
  works again (`ui.copy_on_select` decides whether selecting copies). Scrolling and buttons then
  need the keys; `m` gives the mouse back to the board.

### Answer buttons

When the coordinator asks you something, it can put the answers it expects on the card, the
suggested one first:

```sh
node board.mjs add waiting "Release notes: approve" \
  --desc "Draft notes for v1.4, written from the merged PRs." \
  --ask "Read the draft, then answer" \
  --option "Approve" --option "Needs changes" --suggest "Approve"
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
  card's coordinator, with `herdr agent prompt`. Nothing else from the card is sent.
- **Which coordinator**: the card's owner (the coordinator pane that wrote it) while it runs;
  else the newest running coordinator of the card's project; else the pane that opened the board
  (or the front coordinator, `board.mjs front`). That last one gets a card nobody owns of its
  own project at once, but another project's card only after a second press: the card first
  says `no ai coordinator is running: press Go again to send it to the board's coordinator (sfc,
  pane w4:p6)`. With no coordinator at all: `couldn't send: no ai coordinator is running; start
  one there, or use Other…`. With several projects on the board, an open Waiting card says
  where a press goes now (`answers go to: sfc coordinator (w4:p6)`). Only a coordinator's pane
  counts: an agent Herdr names after a job on the board is a worker and never gets answers.
- **Other…** (`o`) switches to that pane so you can type your answer; nothing is typed for you.
- **From the command line, or Telegram**: `board.mjs answer <id> "<label, its number, or
  text>" [--from telegram]` does what a press does (free text up to 300 characters); another
  project's coordinator only with `--front`. Workers can't. A Telegram bot is held by one
  coordinator, the front: it turns a reply such as `170 go` into `answer 170 go --from
  telegram`, and the text then ends with `(from Telegram)`.
- The card then shows `sent: Approve · 10:42 · to sfc coordinator (w4:p6)`, under the buttons. Pressing a button again asks "send again?" first;
  presses run one at a time, so a double click sends once. The coordinator moves or closes the
  card when it acts on your answer.
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
   board pane on an older version or an older install folder); the key binding, the sidebar and
   the hooks are optional, and so is removing an old install folder (see Update).

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
this list.

| Command | What it does |
|---|---|
| `add <column> <title> [--desc D] [--job slug] [--ask A] [--option L]… [--suggest L] [--project P]` | Add a card; prints its id. Columns: `todo`, `doing`, `waiting`, `done`. `--option` (Waiting only, up to 4) adds answer buttons, `--suggest` marks one. |
| `move <ref> <column> [--ask A] [--desc D]` | Move a card. `<ref>` is its id or its job slug. |
| `edit <ref> [--title T] [--desc D] [--ask A] [--job slug] [--option L]… [--suggest L] [--clear-options]` | Change a card. New `--option`s replace the old ones. |
| `done <ref>` | Same as `move <ref> done`. |
| `rm <ref>` | Remove a card. |
| `retag <id>… <project>` | Move cards to another project. |
| `order <ref> top\|up\|down\|bottom [--project P]` | Move a card in its section (see Order above). With `--project`, `up` and `down` step over that project's cards only. Done cards keep their order (exit 2). |
| | `move`, `edit`, `done`, `rm`, `order` and `retag` change another project's card only with `--project <its project>`, unless your pane owns it (exit 2 otherwise): ids are global, and a remembered id may be another project's. |
| `answer <id> <text> [--from telegram] [--front]` | What a button press does (see Answer buttons). |
| `front [show]` | This coordinator pane gets the answers no other coordinator can take, and holds Telegram (default: the pane that last opened the board). |
| `adopt <id>…` / `adopt --project P --gone` | This coordinator pane owns these cards (`--gone`: P's open cards whose owner pane is gone). |
| `projects` | Every project: tag, colour, open cards, folder, coordinators (live or gone). |
| `project set <name> [--tag T] [--color C] [--name N]` | A project's tag (at most 7 characters), colour (magenta, cyan, blue, green, bright magenta, bright cyan) or name. |
| `ls [--width N] [--project P\|all] [--done 30d]` | Print the board as the pane shows it at that width (wide from 120, the inbox from 70, else compact), with live agent status and every Waiting card open, with Done open: today's finished cards (`--done 30d`: the last 30 days', the archive's too). By default your cards: this project's and the ones your pane owns; `--project P` draws the pane's view of P, `all` every card. Piped with no `--width` (an agent reading it), or with `--width 120`, the wide layout: every card whole. |
| `json [--project P\|all] [--archive YYYY-MM]` | `{ version, scope, hidden, items, projects }` for your cards (`--project all`: the whole file), or a month's archived Done cards. |
| `job-start <slug> [--id N] [--title T] [--desc D] [--report path] [--worktree W \| --project P]` | A job started: its card moves to Doing (`--id`, else that job's To do or Doing card, else a new one, in W's repo). |
| `job-report <slug> [report.json] [--if-final]` | A job's report landed (default: the `--report` given at `job-start`). See below. With `--if-final`, a missing, unreadable or non-final report is a quiet no-op (exit 0). |
| `import [--dry-run] [--keep-stale] [--retag ID=PROJECT,…] [<file>…]` | Bring 0.4 boards in (see Upgrading from 0.4). |
| `export --legacy [--project P\|all]` | A project's cards as a 0.4 board file, on stdout. |
| `restore [<backup>]` | List the board's backups, or put one back. |
| `open [--share 0.3]` | Open the board pane right of this pane (or restart it there with this version). |
| `restart` | Restart every board pane that runs an older version of this board, or a copy whose files are gone, in every workspace. |
| `setup [--dry-run] [--key K] [--no-key] [--no-sidebar] [--no-reload]` | The key binding and the sidebar count in Herdr's `config.toml` (see above). |
| `doctor` | Check the install and print the one fix for each thing missing; exit 1 when something required is. |
| `hooks` | Print the Claude Code hooks to merge into `.claude/settings.json`. |
| `contract` | What this copy offers, as JSON: version, contract 2, commands and their flags, hooks, store. |
| `guide` | The instructions for agents (below). |
| `version` | Print the board's version. |
| `token` | Print this workspace's sidebar text, and report every workspace's to Herdr. |
| `path` | Print the board file's path. |

Exit codes: 0 ok, 1 error (unknown card, unreadable board, Herdr failed), 2 bad usage (and a
change to another project's card without `--project`).

## For agents: running jobs with the board

**`board.mjs guide` (`node "$BOARD" guide`) prints the instructions for agents**: finding the CLI, which cards are
yours, writing cards, buttons, `answer` and Telegram, `job-start --worktree` and `job-report`.
It is the one text to give an agent (the job skill does); this section explains the same for
people. Any coordinator can use the board; it only needs a shell inside Herdr.

1. **Find the CLI**: `herdr plugin list --json` gives the plugin's `plugin_root`, and the CLI
   is `board.mjs` in it. If the plugin is not installed, skip the board and carry on.
2. **Work for later**: `add todo "<title>" --desc "<what and why>"`.
3. **You need the user** (a question, an approval, a merge):
   `add waiting "<title>: <action>" --desc "<what and why>" --ask "<exactly what to do>"`, and
   when the answers are clear, buttons for them, the suggested one first:
   `--option "Go" --option "Not now" --suggest "Go"`. A pressed button arrives in your chat as
   `Board card <id> (<tag> · <title>): <label>`, typed into your pane by Herdr; "Other…" means the
   user types the answer. When they have answered: `done <id>`, or `move`
   the card.
4. **A job starts**: a job is an agent you started in another pane under a Herdr agent name
   (`herdr agent start <slug> …`) that ends by writing a JSON report.
   `job-start <slug> --worktree <its worktree> --title "…" --desc "…" --report <report path>`
   (the card goes to the worktree's project). The pane then shows that
   agent's live state, and moves the card under Waiting while the agent is blocked.
5. **Its report lands**: `job-report <slug>`. The report is JSON like:

   ```json
   { "status": "done", "summary": "one or two sentences", "needs_user": ["Review and merge PR #21"] }
   ```

   - `done` with no `needs_user` → Done.
   - `done` with `needs_user` → Waiting, asking what `needs_user` says (one `Needs you:` line each). An
     entry may be text or an object such as `{ "question": "…", "suggested_answer": "…" }`.
   - `blocked` or `failed` → Waiting, with `<status>: <summary>` as the reason.
   - `running` is a progress note; the board is left alone (exit 1).

   A script that waits for the report can do this for you: call
   `job-report <slug> <report> --if-final` whenever the report file changes. It does nothing
   until the report is final. Calling it again with the same report changes nothing: no second
   card, no new `updated` time, and edits you made to the card since stay. A report rewritten
   with a different outcome moves the same card again.

### Keep the board current: hooks for Claude Code

A coordinator that asks you something in the chat but forgets the card leaves the board stale.
`hooks/board-hook.mjs` is a pair of [Claude Code hooks](https://code.claude.com/docs/en/hooks)
that catch that:

- **When you send a message** (UserPromptSubmit), the coordinator is reminded of its cards
  waiting on you (this project's, those its pane owns, and for the front coordinator those no
  running coordinator can take; id and title, up to 8), with one count of the others
  (`+3 waiting in other projects`), and asked to close or update any you just answered.
  Titles are cleaned, cut to 80 characters, quoted and marked as data written by agents, not
  instructions; a card's description and ask are never passed on. The hook also notes where
  the board stood, for the next check.
- **When the coordinator finishes its reply** (Stop): if the reply asks you something and none
  of its Waiting cards (as above, or any card its pane changed) was added, moved to Waiting or
  changed during that turn, the hook sends it back
  once: "add or update a Waiting card first". It never does so twice in a row, nor more than
  once in a turn.

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

(`$BOARD` as under Install; `hooks/board-hook.mjs --print-settings` prints the same.) The path
in them is the plugin's folder. Herdr 0.9.3 keeps it across updates; 0.9.5 installs each update
to a new folder and removes the old one once nothing uses it, so after an update print them again
(`doctor` says when they run an older install folder), or point them at the job skill's
`job-board.mjs`, which finds the installed copy itself.

Each session's turn record is kept in the store's `turns/` folder and removed after 7 days.

### Writing cards

The user reads a card with no other context: not the chat, not the job's instructions.

- **title**: the thing in plain words, then the kind of action: `…: approve`, `…: merge`,
  `…: review`, `…: pick one`; for jobs `…: build`, `…: fix`. No internal slugs or shorthand.
- **desc**: what it is and why it matters, in one or two plain sentences.
- **ask** (Waiting): exactly what the user should do.

| | Bad | Good |
|---|---|---|
| title | `Login mockup: 3 picks` | `Login page redesign: approve` |
| desc | – | `New sign-in screen with SSO buttons and a clearer error message. 3 small choices to confirm.` |
| ask | `Pick the 3 choices` | `Open the mockup, reply ok or change` |

When `job-report` moves a job to Waiting, rewrite its title and ask for the user:
`edit <id> --title "…: approve" --ask "…"`. The CLI prints a tip when a card has no `--desc`,
or a Waiting card no `--ask`.

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
turns/                the Stop hook's turn records
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
  its job runs, for the agent's live state and the sidebar count). Ids are global and never
  reused.
- A project's `tag` is its name's first part (`sfc` for sfc-integration), at most 7 characters,
  made unique when two would clash; `project set` changes it and the colour.
- `column` is `todo`, `doing`, `waiting` or `done`; `since` is when the card entered it. `ask`
  holds one line per thing to do. `options` are the answer buttons; `sent` the last answer sent
  (and to whom). `reported` and `reports` mark which job report already moved a card, so a repeat
  changes nothing, even after the card is archived.
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
  the card's coordinator (see Answer buttons). Herdr checks the agent's state itself and refuses one that is waiting
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
`UPDATE_SNAPSHOTS=1 node --test` rewrites the render snapshots. `board-pane.mjs --once --width N
--height N [--layout wide|inbox|compact] [--color] [--emoji] [--keys …]` prints one frame.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

MIT, see [LICENSE](LICENSE).
