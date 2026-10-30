# herdr-job-board

A To do / Doing / Waiting-on-you board for agent jobs, in a Herdr split pane. README.md has the
design and the CLI.

## Tests never touch the live board

The board is the user's main work view, one store per machine (`~/.local/state/herdr-job-board/`).
Tests, QA and any run of `board.mjs` use scratch folders only:

```bash
S=$(mktemp -d); HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp JOB_BOARD_HOME=$S/board node --test
```

- `tests/guard.mjs` refuses the real HOME; don't work around it.
- Work only inside scratch copies; never `herdr plugin action invoke` in the user's panes.
- Never restore, move or migrate live board files (`~/.local/state/herdr-job-board/`,
  `<repo>/.git/job-board*.json`) yourself: say what happened in your report.
- No deploy. `herdr plugin install` happens after the merge, not in a job.

<!-- job-skill:start v10 -->
## Jobs (parallel agents)

The **coordinator** (the session the user talks to) runs each task as a **job**: a Claude or Codex
agent in its own Herdr tab and git worktree, started with `/job <task>`. Set up by `/job init`.

**Workers** (`role_env` in `.claude/job.json` set to `worker`, and every subagent):
- Follow your brief; end with its JSON report. Need help? Put it under `needs_user`.
- Never start jobs, tabs or agents, or use the `job` skill. You may split your own pane
  (`herdr pane split --current`) for servers, tests or logs; never close a tab.
- No `reserved_commands`, pushes to the default branch or merges: only a `deployer` tab (one at
  a time) or the coordinator, when the user asks, runs those. `bb-merge.mjs` is a merge: for
  you, `--dry-run` only.
- Stay in your worktree; never switch the main checkout's branch. Use your `ports`; run
  `heavy_commands` through `~/.claude/skills/job/scripts/with-heavy-lock.sh`.
- Ship as the brief says (commit, push, PR, `ship_routine`). Don't write the daily note or
  project note: your report is the record.
- Run the skill's `scripts/mem-check.mjs` before a dev server; close browsers and servers after QA.

**The coordinator** follows the `job` skill and doesn't change the repo: every change goes to
a job. Exceptions: the one build-stamp commit `bb-merge.mjs` writes after a merge in a
`build_stamp` repo, and job.json's `coordinator_commits`. Only the user lifts the rule, for one
turn, by starting a message with `here:`. Outside Herdr there are no jobs and the rule is off.
`.claude/hooks/job-guard.mjs` enforces all this (a guardrail, not a security boundary).
<!-- job-skill:end -->
