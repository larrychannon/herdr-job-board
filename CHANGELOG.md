# Changelog

## 0.5.0 · unreleased

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
  automatic import, shows it and applies re-tags. `export --legacy` writes a project back as a
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
  shapes). Herdr itself binds `prefix+b` (toggle_sidebar), so `setup` names a free key
  (`--key prefix+shift+b`). `doctor` points to it.
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
