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



Tab section · ↑↓ scroll · q quit
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

### Keys and mouse

| | |
|---|---|
| `Tab` / `Shift-Tab`, `←` `→` | select a section (its header is marked ▸) |
| `↑` `↓`, `j` `k` | scroll one card; in Waiting, select a card |
| `←` `→` in Waiting | select one of the card's buttons |
| `Enter`, `o` | press the selected button; `o` is Other… |
| `PgUp` `PgDn`, `g` `G` | scroll a page; go to the top / bottom |
| mouse wheel, click | scroll the section under the pointer; click a button to press it, elsewhere to select a section |
| `q`, `r` | quit; redraw |

Mouse reporting (SGR 1006) is switched on while the board runs and off again when it quits,
gets a signal or crashes. Hold Shift to select text with the mouse, as in other terminal apps.

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
  < Approve ✓ >  [ Needs changes ]  [ Other… ]
```

- Click a button, or select it and press Enter: the board sends
  `Board card <id> (<title>): <label>` to the pane that opened the board, as if you had typed
  it there (`herdr agent prompt`). Nothing else from the card is sent.
- **Other…** (`o`) switches to that pane and types `Board card <id>: ` for you to finish;
  nothing is sent until you press Enter there.
- The card then shows `sent: Approve · 10:42`. Pressing a button again asks "send again?" first.
  The coordinator moves or closes the card when it acts on your answer.
- If the coordinator's pane is gone, or busy with a question of its own, the card says
  `couldn't send: …` in red.
- Up to 4 buttons of up to 24 characters; `--clear-options` removes them. They are for Waiting
  cards only and go away when the card leaves Waiting.

**Who can add buttons.** A button sends text into the coordinator's chat, so only the
coordinator should add them. Cards that come from a job (`job-start`, `job-report`) never get
buttons, whatever the job's report says. Anything that can write the board file could add
buttons, though: the file is in `.git/` (readable only by you), so that means programs running
as you in that repo. If you run other agents as workers, stop them from using `--option` and
`--suggest` (a pre-tool hook can block that command). Even then, a button only sends its own
label, with the card's id and title, to the coordinator; it never runs anything.

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
| `job-report <slug> [report.json]` | A job's report landed (default: the `--report` given at `job-start`). See below. |
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
   `Board card <id> (<title>): <label>`; "Other…" means the user types the answer. When they
   have answered: `done <id>`, or `move` the card.
4. **A job starts**: a job is an agent you started in another pane under a Herdr agent name
   (`herdr agent start <slug> …`) that ends by writing a JSON report.
   `job-start <slug> --title "…" --desc "…" --report <report path>`. The pane then shows that
   agent's live state, and moves the card under Waiting while the agent is blocked.
5. **Its report lands**: `job-report <slug>`. The report is JSON like:

   ```json
   { "status": "done", "summary": "one or two sentences", "needs_user": ["Review and merge PR #21"] }
   ```

   - `done` with no `needs_user` → Done.
   - `done` with `needs_user` → Waiting, asking what `needs_user` says (one `→` line each).
   - `blocked` or `failed` → Waiting, with `<status>: <summary>` as the reason.
   - `running` is a progress note; the board is left alone (exit 1).

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
- Text is stored without control characters, escape sequences or bidirectional controls, and
  everything the board or the CLI prints is cleaned again (`json` writes such characters as
  `\u` escapes), so text an agent writes can't change your terminal.
- It types into its own pane: `open` runs the board there only while the pane is at a shell
  prompt, and sends `q` only to a board it finds running there.
- Answer buttons send exactly `Board card <id> (<title>): <label>`, through
  `herdr agent prompt` as one argument, to the pane that opened the board; Other… types
  `Board card <id>: ` there without pressing Enter. See "Who can add buttons" above.

## Tests

```sh
node --test
```

Herdr is faked (`tests/fixtures/fake-herdr.mjs`); nothing touches your real Herdr session.
`UPDATE_SNAPSHOTS=1 node --test` rewrites the render snapshots.

## License

MIT, see [LICENSE](LICENSE).
