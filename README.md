# herdr-job-board

A board beside your chat for work you hand to coding agents: **WAITING ON YOU** on top,
**DOING**, **TO DO** and **DONE** below. It is a [Herdr](https://herdr.dev) plugin: the board
opens in a split pane next to the pane you are in and redraws itself every 3 seconds.

It is made for a *coordinator*: the agent (or person) that starts jobs in other panes and
asks you for decisions. The coordinator writes the board with a small CLI; you read it at a
glance, without scrolling the chat to find what needs you.

```
Job board · my-app                                                                 10:30

▸ WAITING ON YOU (5)
1▸Login page redesign: approve                                                2 h 20 min
  New sign-in screen with SSO buttons and a clearer error message. 3 small choices to
  confirm.
  → Open the mockup, reply ok or change

2 Search filters mockup: approve                                              1 h 30 min
  Filter panel for the search page with saved filters. 4 choices, e.g. whether saved
  filters are per user.
  → Reply ok or change

3 Billing fix (PR #12): review                                                    50 min
  Invoices now round each line, not the total. Fixes the one-cent differences customers
  reported.
  → Try the invoice page on :3000, then say merge
↓ 2 more

DOING (2)                     TO DO (4)                     DONE (1)
6 Search filters: build        8 Export to CSV      1 min   12 Nightly backup check
  working                        Let people download any       07:30
  The filter panel from the      table as CSV. Three
  approved mockup, with          customers asked for it.
  saved filters per user.
  25 min                       9 Dark mode          1 min
                                 Follow the system theme.
7 Docs site: fix broken          The colour tokens are
  links               2 min      already in place.
  working
  Check every link on the     10 Pick next: onboarding or
  new docs site and fix the      settings           1 min
  ones that 404.                 From the roadmap: an
                                 onboarding tour or a new
                                 settings page. You pick.
                              ↓ 1 more



Tab section · ↑↓ card · Enter details · c copy · m mouse: board · q quit
```

- **WAITING ON YOU** runs across the top: what needs you. Each card shows its title, a
  description of up to 3 lines and, highlighted, what you should do (`→ …`). A card can carry
  **answer buttons** (below). An agent that is **blocked** on a question or an approval shows
  here by itself, even when nobody put it on the board.
- **DOING | TO DO | DONE** share the bottom in three columns. Doing cards show the live state of
  the job's agent from `herdr agent list` (working, done, idle, no agent) and their age. Done
  lists today's finished cards, newest first, with the time they finished.
- Waiting gets about half the height. With nothing waiting it shrinks to one line ("Nothing
  needs you") and the rest goes to the bottom. Under 70 columns the four sections stack.
- **Every section scrolls on its own**, and the place you scrolled to holds while the board
  redraws and new cards arrive. "↑ 2 above" and "↓ 3 more" say what is out of view; a card is
  never hidden without saying so.
- **Colour**, from the terminal's standard 16 colours so it reads on dark and light themes:
  WAITING ON YOU amber, DOING blue, TO DO plain, DONE dim green; the agent's state green
  (working), red (blocked), cyan (idle or done) or grey (no agent); the `→` line amber, the
  suggested button highlighted, and a Waiting card's age red after a day. `NO_COLOR` turns
  colour off.

### Keys and mouse

| | |
|---|---|
| `Tab` / `Shift-Tab`, `←` `→` | select a section (its header is marked ▸) |
| `↑` `↓`, `j` `k` | select a card in the section (marked ▸); the view follows |
| `Enter` | open the selected card's details; `Esc` closes them |
| `f` in the details | show or hide More… (the rest of the job's report) |
| `←` `→` on a card with buttons | choose a button (the suggested one first); then `Enter` presses it, `Esc` un-chooses it |
| `o` | Other… on a card with buttons |
| `c` | copy the card's first link, or its text (Alt+c does nothing) |
| `t` | go to the job's tab |
| `m` | mouse capture off (select text in the terminal) and on again |
| `PgUp` `PgDn`, `g` `G` | scroll a page; first / last card |
| mouse | wheel scrolls the section under the pointer; a click selects a card, a double click opens it, a click on a button presses it |
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
  → Open the canvas, then OK all suggestions or comment
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
- **What it is**: the description. **What you need to do**: the ask and the card's buttons,
  which work here as on the card (`←` `→` choose one, `Enter` or a click presses it).
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
  pane had to cut short is plain text. Only `http` and `https` count: not `javascript:`,
  `data:` or `file:`, never a `user:password@` part, and never an invisible character.
- **Copy.** `c` puts the selected card's first link on the clipboard, or the card's text when
  it has no link (OSC 52, at most 8000 characters), and the key line says what was copied. It
  happens only when you press `c`. Herdr passes a pane's clipboard writes to your terminal;
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
  → Read the draft, then answer
  [ Approve ✓ ]  [ Needs changes ]  [ Other… ]
```

Choose a button with `←` `→` (the suggested one, ✓, comes first; the chosen one shows as
`< … >`) and press `Enter`, or click it.

- Click a button, or choose it and press Enter: the board hands
  `Board card <id> (<title>): <label>` to the agent in the pane that opened the board, with
  `herdr agent prompt`. Nothing else from the card is sent.
- **Other…** (`o`) switches to that pane so you can type your answer; nothing is typed for you.
- The card then shows `sent: Approve · 10:42`. Pressing a button again asks "send again?" first;
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

```sh
herdr plugin install larrychannon/herdr-job-board
```

Open the board with the plugin's `open` action (bind a key, see below), or from any shell or
agent inside Herdr:

```sh
BOARD="$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id == "herdr-job-board") | .plugin_root')/board.mjs"
node "$BOARD" open
```

`open` splits the calling pane to the right (30% wide), keeps your focus where it is and
remembers the pane: a second `open` in the same tab reuses it, starts the board again if it
was quit, and restarts it if an older copy of the board runs there. The pane that runs `open`
is the one answer buttons send to.

### Key binding

In Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+b"            # any free key
type = "plugin_action"
command = "herdr-job-board.open"
description = "open the job board"
```

### Sidebar summary

Every change, and the open board, report a workspace token `board` with the counts, such as
`2 doing · 3 need you · 4 to do` (cleared when nothing is open). To show it, add `"$board"`
to the Space rows in `config.toml`:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$board"],
]
```

## The CLI

`node board.mjs <command>`, run from inside the repo whose board you want.
`node board.mjs help` prints this list.

| Command | What it does |
|---|---|
| `add <column> <title> [--desc D] [--job slug] [--ask A] [--option L]… [--suggest L]` | Add a card; prints its id. Columns: `todo`, `doing`, `waiting`, `done`. `--option` (Waiting only, up to 4) adds answer buttons, `--suggest` marks one. |
| `move <ref> <column> [--ask A] [--desc D]` | Move a card. `<ref>` is its id or its job slug. |
| `edit <ref> [--title T] [--desc D] [--ask A] [--job slug] [--option L]… [--suggest L] [--clear-options]` | Change a card. New `--option`s replace the old ones. |
| `done <ref>` | Same as `move <ref> done`. |
| `rm <ref>` | Remove a card. |
| `ls [--width N]` | Print the board as the pane shows it, with live agent status. |
| `json` | Print the board file. |
| `job-start <slug> [--id N] [--title T] [--desc D] [--report path]` | A job started: its card moves to Doing (`--id`, else that job's To do or Doing card, else a new one). |
| `job-report <slug> [report.json] [--if-final]` | A job's report landed (default: the `--report` given at `job-start`). See below. With `--if-final`, a missing, unreadable or non-final report is a quiet no-op (exit 0). |
| `open [--share 0.3]` | Open the board pane right of this pane. |
| `token` | Print the sidebar text and report it to Herdr. |
| `path` | Print the board file's path. |

Exit codes: 0 ok, 1 error (unknown card, unreadable board, Herdr failed), 2 bad usage.

## For agents: running jobs with the board

Any coordinator can use the board; it only needs a shell inside Herdr.

1. **Find the CLI**: `herdr plugin list --json` gives the plugin's `plugin_root`, and the CLI
   is `board.mjs` in it. If the plugin is not installed, skip the board and carry on.
2. **Work for later**: `add todo "<title>" --desc "<what and why>"`.
3. **You need the user** (a question, an approval, a merge):
   `add waiting "<title>: <action>" --desc "<what and why>" --ask "<exactly what to do>"`, and
   when the answers are clear, buttons for them, the suggested one first:
   `--option "Go" --option "Not now" --suggest "Go"`. A pressed button arrives in your chat as
   `Board card <id> (<title>): <label>`, typed into your pane by Herdr; "Other…" means the
   user types the answer. When they have answered: `done <id>`, or `move`
   the card.
4. **A job starts**: a job is an agent you started in another pane under a Herdr agent name
   (`herdr agent start <slug> …`) that ends by writing a JSON report.
   `job-start <slug> --title "…" --desc "…" --report <report path>`. The pane then shows that
   agent's live state, and moves the card under Waiting while the agent is blocked.
5. **Its report lands**: `job-report <slug>`. The report is JSON like:

   ```json
   { "status": "done", "summary": "one or two sentences", "needs_user": ["Review and merge PR #21"] }
   ```

   - `done` with no `needs_user` → Done.
   - `done` with `needs_user` → Waiting, asking what `needs_user` says (one `→` line each). An
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

- **When you send a message** (UserPromptSubmit), the coordinator is reminded of the cards
  waiting on you (id and title, up to 8) and asked to close or update any you just answered.
  Titles are cleaned, cut to 80 characters, quoted and marked as data written by agents, not
  instructions; a card's description and ask are never passed on. The hook also notes where
  the board stood, for the next check.
- **When the coordinator finishes its reply** (Stop): if the reply asks you something and no
  Waiting card was added, moved to Waiting or changed during that turn, the hook sends it back
  once: "add or update a Waiting card first". It never does so twice in a row, nor more than
  once in a turn.

A reply "asks something" when its last paragraph ends with `?`, or a sentence near the end
starts like a request for a decision: "Want me to …", "Should I …", "Shall I …", "OK to …",
"Go?". Code blocks, inline code, quotes, block quotes and links don't count. It is a heuristic:
a question it misses goes unchecked, and when it fires without need, the coordinator says so
in one line and stops.

The hooks only act inside Herdr, for the coordinator (the role variable, `JOB_AGENT_ROLE` by
default, unset or `coordinator`; `--role-env NAME` picks another), never for subagents, and only
in a repo that has a board. Anywhere else they print nothing. To install them, print the
settings and merge them into `.claude/settings.json` (this project) or
`~/.claude/settings.json` (everywhere):

```sh
node "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id == "herdr-job-board") | .plugin_root')/hooks/board-hook.mjs" --print-settings
```

Each session's turn record is kept next to the board, in `.git/job-board.turns/`, and removed
after 7 days.

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

## The board file

One board per git repo, at `$(git rev-parse --git-common-dir)/job-board.json`: inside `.git`,
so every worktree of the repo shares it and git never sees it. `JOB_BOARD_FILE=<path>` uses
another file.

```json
{
  "version": 1,
  "next_id": 3,
  "items": [
    {
      "id": 1,
      "title": "Billing fix (PR #12): review",
      "desc": "Invoices now round each line, not the total.",
      "column": "waiting",
      "job": "",
      "ask": "Try the invoice page on :3000, then say merge",
      "since": "2026-10-13T09:40:00.000Z",
      "updated": "2026-10-13T09:40:00.000Z",
      "options": [{ "label": "Merge", "suggested": true }, { "label": "Not yet" }],
      "sent": { "label": "Merge", "at": "2026-10-13T09:52:00.000Z" }
    },
    {
      "id": 2,
      "title": "Search filters: build",
      "desc": "The filter panel from the approved mockup.",
      "column": "doing",
      "job": "search-ui",
      "ask": "",
      "since": "2026-10-13T10:05:00.000Z",
      "updated": "2026-10-13T10:05:00.000Z",
      "report": "/path/to/search-ui-report.json"
    }
  ],
  "panes": { "w1:t1": "w1:p4" }
}
```

- `column` is `todo`, `doing`, `waiting` or `done`; `since` is when the card entered it.
  `ask` holds one line per thing to do. `report` is optional (set by `job-start --report`).
- `options` (Waiting cards) are the answer buttons; `sent` is the last answer sent from the
  board. Both go away when the card leaves Waiting.
- `reported` marks which report outcome `job-report` already applied to the card, so a repeat
  call changes nothing.
- `panes` remembers the board pane of each Herdr tab.
- Done cards are kept for 14 days (the Done column shows today's), then dropped.
- Only `board.mjs` writes the file (the pane, through it, writes `sent`). It takes a lock
  (`mkdir <file>.lock`, with the owner's process id in it), writes a temp file and renames it
  over the board, so readers never see half a file and two writers at once don't lose each
  other's cards. A lock is taken back only from a process that is gone, never from a slow one.
  The file is created readable by you only.

## Safety

- It runs only `git rev-parse` and the `herdr` CLI, with argument lists and no shell, except
  `herdr pane run` to start the board in its pane (paths are single-quoted). No network, no
  dependencies.
- Text is stored without control characters, escape sequences, bidirectional controls or other
  invisible format characters (zero-width spaces and joiners, word joiner, BOM, soft hyphen), and
  everything the board or the CLI prints is cleaned again (`json` writes such characters as
  `\u` escapes), so text an agent writes can't change your terminal.
- It types into its own pane: `open` runs the board there only while the pane is at a shell
  prompt, and sends `q` only to a board it finds running there.
- Answer buttons send exactly `Board card <id> (<title>): <label>` (the id a whole number,
  title and label cleaned), only through `herdr agent prompt`, as one argument, to the pane
  that opened the board. Herdr checks the agent's state itself and refuses one that is waiting
  on a question, so a button never presses Enter on someone else's prompt. The board never
  types into another pane: Other… only switches to it.

## Limits and threat model

- **Who can add buttons.** A button puts text into the coordinator's chat, so only the
  coordinator should add them. Cards that come from a job (`job-start`, `job-report`) never get
  buttons, whatever the job's report says. Anything that can write the board file can add
  buttons, though. The file is in `.git/` and readable only by you, so that means programs
  running as you in that repo. If you run other agents as workers, a pre-tool hook that blocks
  `--option` and `--suggest` helps, but it matches command text, so it is best-effort: a worker
  that can run commands as you can also write the file directly, or type into any pane with
  `herdr pane send-text`. Even then, a button only sends its own label, with the card's id and
  title, to the coordinator, and only when you press it.
- **No answer without choosing.** Enter on a card opens its details; it presses a button only
  after you chose one with ← → (the first ← or → picks the suggested one, or the first button
  when the card has no `--suggest`). A click on a button presses it at once.
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

```sh
node --test
```

Herdr is faked (`tests/fixtures/fake-herdr.mjs`); nothing touches your real Herdr session.
`UPDATE_SNAPSHOTS=1 node --test` rewrites the render snapshots.

## License

MIT, see [LICENSE](LICENSE).
