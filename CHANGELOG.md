# Changelog

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
- `ls` uses the layout for its width, with every Waiting card open; `ls --width 120` shows every
  card whole. `board-pane.mjs --once` takes `--layout` and `--emoji`.

Earlier versions: see the git history.
