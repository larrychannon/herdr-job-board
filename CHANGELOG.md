# Changelog

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
