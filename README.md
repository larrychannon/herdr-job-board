# herdr-job-board

A board beside your chat for work you hand to coding agents: **WAITING ON YOU**, **DOING**
and **TO DO**, plus a "Done today" line. It is a [Herdr](https://herdr.dev) plugin: the board
opens in a split pane next to the pane you are in and redraws itself every 3 seconds.

It is made for a *coordinator*: the agent (or person) that starts jobs in other panes and
asks you for decisions. The coordinator writes the board with a small CLI; you read it at a
glance, without scrolling the chat to find what needs you.

```
Job board · my-app                                                                 10:30

WAITING ON YOU (5)            DOING (2)                     TO DO (4)

1 Login page redesign:        6 Search filters: build        8 Export to CSV      1 min
  approve        2 h 20 min     working                        Let people download any
  New sign-in screen with       The filter panel from the      table as CSV. Three
  SSO buttons and a cleare…     approved mockup, with          customers asked for it.
  → Open the mockup, reply      saved filters per user.
    ok or change                25 min                       9 Dark mode          1 min
                                                               Follow the system theme.
2 Search filters mockup:      7 Docs site: fix broken          The colour tokens are
  approve        1 h 30 min     links               2 min      already in place.
  Filter panel for the          working
  search page with saved f…     Check every link on the     10 Pick next: onboarding or
  → Reply ok or change          new docs site and fix the      settings           1 min
                                ones that 404.                 From the roadmap: an
3 Billing fix (PR #12):                                        onboarding tour or a new
  review             50 min                                    settings page. You pick.
  Invoices now round each
  line, not the total. Fix…                                 11 Upgrade the test runner
  → Try the invoice page on                                    The current version
    :3000, then say merge                                      reaches end of life next
                                                               month.             1 min
4 Docs move (PR #14): merge
  The docs move to the
  shared site. No content …
  → Say merge (after #12)
  45 min

5 Deploy v1.4: go    30 min
  After #12 and #14 merge:
  tag v1.4 and deploy it t…
  → Say go once merged

Done today: Nightly backup check
```

- Each card shows its id and title, the description over up to 3 lines and its age.
  Waiting cards also show what you should do (`→ …`). Doing cards show the live state of the
  job's agent from `herdr agent list` (working, done, idle, no agent).
- An agent that is **blocked** on a question or an approval shows under Waiting by itself,
  even when nobody put it on the board.
- Under 70 columns the columns stack. When the pane is too short, To do gives way first,
  then descriptions, then cards. What you have to do stays.
- `q` quits the pane, `r` redraws it.

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
was quit, and switches it over if an older copy of the board runs there.

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
| `add <column> <title> [--desc D] [--job slug] [--ask A]` | Add a card; prints its id. Columns: `todo`, `doing`, `waiting`, `done`. |
| `move <ref> <column> [--ask A] [--desc D]` | Move a card. `<ref>` is its id or its job slug. |
| `edit <ref> [--title T] [--desc D] [--ask A] [--job slug]` | Change a card. |
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
   `add waiting "<title>: <action>" --desc "<what and why>" --ask "<exactly what to do>"`.
   When they answer: `done <id>`.
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
      "updated": "2026-10-13T09:40:00.000Z"
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
- `panes` remembers the board pane of each Herdr tab.
- Done cards are kept for 14 days (for the "Done today" line), then dropped.
- Only `board.mjs` writes the file. It takes a lock (`mkdir <file>.lock`), writes a temp file
  and renames it over the board, so readers never see half a file and two writers at once
  don't lose each other's cards.

## Safety

- It runs only `git rev-parse` and the `herdr` CLI, with argument lists and no shell, except
  `herdr pane run` to start the board in its pane (paths are single-quoted). No network.
- Card text is shown with control characters, escape sequences and bidirectional controls
  removed, so text an agent writes can't change your terminal.
- It types into its own pane only: `open` runs the board there only while the pane is at a
  shell prompt, and sends `q` only to a board it finds running there.

## Tests

```sh
node --test
```

Herdr is faked (`tests/fixtures/fake-herdr.mjs`); nothing touches your real Herdr session.
`UPDATE_SNAPSHOTS=1 node --test` rewrites the render snapshots.

## License

MIT, see [LICENSE](LICENSE).
