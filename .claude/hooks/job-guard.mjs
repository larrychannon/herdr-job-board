#!/usr/bin/env node
// job-guard v13
// Vendored into a repo's .claude/hooks/ by the `job` skill (`/job init`). Do not edit the copy in
// a repo: change ~/.claude/skills/job/hooks/job-guard.mjs and re-run `/job init`, which replaces
// it (`/job init --check` reports an old or edited copy).
//
// Guard for parallel agents (the "Jobs" block in the repo's AGENTS.md / CLAUDE.md). Runs as a
// PreToolUse hook (Bash, Edit/Write/MultiEdit/NotebookEdit, Skill) and as a UserPromptSubmit hook.
// Claude runs it from .claude/settings.json; Codex from .codex/hooks.json with `--codex` (Codex
// tools: Bash, and apply_patch, whose files are checked like Edit/Write). The rules are the same.
// Project settings come from .claude/job.json, read on every call (see the skill's
// templates/job.json). A missing or broken job.json keeps the built-in rules below.
//
// Roles come from the env var named by job.json `role_env` (default JOB_AGENT_ROLE):
//   - deployer: not restricted by anything here.
//   - coordinator (unset or "coordinator"): the session the user talks to. Inside Herdr
//     (HERDR_ENV=1) it does not change a job repo: this repo, and any repo set up for jobs
//     (one whose checkout, or main checkout, has .claude/job.json), with all their git
//     worktrees. In them: no Edit/Write, and no git commit / rebase / cherry-pick / revert /
//     am / apply, or merge / pull without --ff-only. The repo a git command acts on comes from
//     the hook input's cwd, any `cd <dir>` before it and `git -C <dir>`; an edit's repo from
//     its file path. When that can't be told (`cd "$X"`, a subshell), the command is blocked.
//     A submodule of a job repo counts as that repo. When git can't answer for a path inside a
//     checkout (`safe.directory`, its timeout), the job.json files beside its `.git` decide:
//     fail closed. A repo without job.json is not guarded (no jobs run there; `/job init` it to
//     guard it), and neither are files outside git (scratchpad, memory, notes). So a home coordinator
//     (one in ~/work that runs jobs in every repo) is held to the same rules in each job repo
//     as that repo's own coordinator. Repo work goes to a job (`/job <task>`). Outside Herdr
//     jobs can't run, so none of this applies there. Its subagents count as the coordinator.
//     Opt-in (v6): a repo whose job.json says `"coordinator_commits": true` lets the coordinator
//     itself (not its subagents, not workers) edit and run those git commands in that repo and
//     its worktrees. It is read from the repo's main checkout (this hook's own job.json for its
//     own repo), so a branch can't turn it on, and only the repo a command or edit reaches
//     counts: a command that also reaches another job repo is judged there by that repo's own
//     job.json. A submodule is not covered. Pushing is not a coordinator rule, so it needs no opt-in.
//   - worker (any other value), and every subagent: may not run the reserved commands
//     (job.json `reserved_commands`, plus the built-in ones: pushing to the default branch and
//     merging PRs, including the skill's scripts/bb-merge.mjs, which also writes a stamp commit
//     on the default branch; v8: its --dry-run stays open; v11: read from the shell words, so only
//     a real run counts, and only `--dry-run` as its own argument; v13: a push to a scratch repo
//     in a temp dir is not a push to the default branch). They come from this repo's
//     job.json, from the job.json of every repo the
//     command reaches (its cwd, `cd` / `pushd <dir>`, `git -C <dir>`, a script run by a path such
//     as `/root/app/ship.sh` or `../app/ship.sh`), and from every repo in the machine's job-repo
//     registry (${XDG_STATE_HOME:-~/.local/state}/job-skill/repos.json, which `/job init` fills),
//     wherever the command runs: `aws ecs update-service` names no repo. So a home coordinator's
//     subagent can't run any job repo's deploy commands either. Nor may they start jobs, tabs or agents (`herdr agent start`,
//     `herdr tab create`, `claude` via `herdr pane run`, the skill's `job-round.mjs`, v9:
//     `job-open.mjs`, `job-close.mjs` and `ship.mjs` (but `ship.mjs <repo> <card> plan`; v13: only
//     as the program or node's script, read from the shell words), …, or the `job` skill). Each
//     job has its
//     own tab; a worker may split its own pane there (`herdr pane split --current`), not
//     another one. Nor may it put answer buttons on a job-board card (`board.mjs` or
//     `job-board.mjs` with --option / --suggest): a button sends text into the coordinator's
//     chat, so only the coordinator adds them; nor pass --allow-wording, which writes a card
//     the board's wording check refused; nor, v10, run the board's `not-run`, which marks a
//     press on a card as not carried out (the coordinator's own call); nor, v12, put a card in
//     the board's Queue (`add queue …`, `move <ref> queue`): it says what the coordinator starts
//     by itself, so only the user (and the coordinator) queues. In Codex, a worker's prompt that names the
//     skill (`$job`, `/job`) is blocked.
//
// Closing (`herdr tab close`, `workspace close`, `pane close`):
//   - workers and subagents never close a tab or a workspace. A worker closes only its own
//     pane, or a pane in its own job tab (one it split: Herdr's `pane get` says which tab);
//     a coordinator's subagent only its own pane. An id the hook can't read is blocked.
//   - the coordinator, inside Herdr, closes only the job tabs recorded in this repo's
//     registry, <git common dir>/job-tabs.json (the skill's scripts/job-tabs.mjs writes it when
//     it opens a job's tab), never its own tab ($HERDR_TAB_ID) and never a workspace. The id
//     has to be written literally. The `here:` override doesn't lift this.
//
// Accounts (v7): the coordinator, inside Herdr, starts jobs only on its own Claude account, the
// CLAUDE_CONFIG_DIR it runs with (unset: ~/.claude). A coordinator folder's ./start sets that
// from its coordinator.conf `profile=`, so the folder's profile is the jobs' default. Every
// `herdr tab create` must pass `--env CLAUDE_CONFIG_DIR=<that dir>` (written literally; $HOME and
// $CLAUDE_CONFIG_DIR are read from the env), or leave it out when the dir is ~/.claude. Every
// `herdr agent start --kind claude` must name its pane literally, and that pane's processes must
// not run on another account (read from their environment: /proc on Linux, `ps -E` on macOS,
// which hides a system binary's such as /bin/zsh, so a fresh pane there can't be read and
// passes; the skill's scripts/job-account.mjs check reads the started agent's own process).
// Neither `here:` nor coordinator_commits lifts this. Another account only through the user's
// override below.
//
// The user's one-turn overrides: a prompt that starts with `here:` writes the flag
// ${TMPDIR:-/tmp}/job-inline-<session_id>, one that starts with `account: <profile>` writes
// job-inline-account-<session_id> (holding the profile); any other prompt removes both. While
// `here:` is set the coordinator rules are off; while `account:` is set, jobs start on that
// profile's account instead of the default. The agent may not create either flag itself.
//
// Paths on a network mount (sshfs, nfs, cifs, … in /proc/self/mounts; the user's Obsidian vault
// on the LXC) are judged by name only, never stat'ed: a stat there hangs while the other end is
// away. So a job repo on a network mount is guarded only as the coordinator's own repo.
//
// This reads command text, so it is a guardrail against mistakes, not a security boundary:
// `eval`, aliases, `sed -i`, a renamed copy of a script or a variable it can't follow get around
// it. Two kinds of rule:
//   - Read from the shell words (v11 bb-merge.mjs; v13 job-round / job-open / job-close /
//     ship.mjs and pushing to the default branch): only the program a simple command runs
//     counts, past env assignments, shell keywords (`if`, `then`, `do`, `{`, `!`) and runners
//     (`timeout`, `sudo`, `xargs`, `with-agent`, `with-heavy-lock.sh`, `flock <file>`, `bash -c
//     '…'`, `su -c '…'`, `ssh host '…'`), in $( ), backticks or a subshell. Stdin defaults to
//     being run: a heredoc, a here-string or a pipe (from a heredoc, `echo` or `printf`, through
//     any pipe) is read as commands when it feeds a shell with any options (`bash -euo pipefail
//     <<EOF`, `cat <<EOF | bash -s -- arg`, `bash /dev/stdin`, `. /dev/stdin`), `sudo -s`, `su`,
//     `ssh host`, or any program the guard doesn't know (`docker exec -i c bash`). xargs adds
//     its stdin to the command's arguments (`echo x.mjs | xargs wc -l` is `wc -l x.mjs`). Node
//     with no script (`node - <<EOF`, `echo … | node`) is judged like `-e` code; python, perl or
//     ruby code (stdin or `-c` / `-e`) that starts a process outside its strings (`os.system(`,
//     `execSync(`, not RegExp `.exec(` or `platform.system()`) has its string literals read as
//     shell lines (`subprocess.run(["git", "push", "origin", "main"])`). Only a
//     program that reads data (cat, tee, grep, jq, sed, git, gh, `while read`, …: NON_RUNNERS),
//     a script file (`bash ./check.sh <<EOF`, `node x.mjs <<EOF`: it reads the text as data) or
//     an output redirect (`tool > out <<EOF`) skips the body. Node's options before the script are
//     skipped, with their separate values (`node --unhandled-rejections strict job-close.mjs`);
//     node code that names a job script and calls its main, closeJob or sweep outside its strings
//     (`m.main(…)`, `m["main"](…)`, `m.main.call(…)`, `({ main: go }) => go(…)`) is a run of it.
//     A push counts by the remote named on the line (git ignores --repo then), also `git subtree
//     push`; a temp-dir remote is
//     trusted only when the repo git opens there (a gitfile, `.git` symlink or `<path>.git` too)
//     is in a temp dir, the line doesn't write there (`printf 'gitdir: …' > /tmp/x.git`, tee, cp,
//     mv, ln) and doesn't send the push elsewhere (`insteadOf` through `-c` or GIT_CONFIG_*,
//     `--receive-pack`, `--exec`). An assignment that may not run (after && or ||,
//     or anywhere in an if's branch or a loop's body) is followed both ways: in the other world
//     the variable keeps its old value or, with none, is unset as in bash (`$R` drops out,
//     `${R:-origin}` is origin). A branch sees its own assignments; `else` starts from before
//     the `if`. At most 8 worlds, which still hold every value seen. `R+=x` appends. A $( ) value it can't read counts
//     when its text names the script or the branch (`node "$(ls …/job-close.mjs)"`, `git push
//     origin $(echo main)`), not otherwise (`node "$(pick)"`, `git push origin "$(git branch
//     --show-current)"`). An assignment's value, a quoted argument, a comment, a heredoc body
//     read by a data program, a `[ … ]` test or another command's argument never counts. A line
//     it can't read (an unterminated quote, a quote inside ${…}) falls back to the old pattern.
//     `git push --repo=<any> main` stays reserved: git reads `main` as the remote there, but the
//     line meant the branch. Not followed, by choice (each needs what a hook can't know or would
//     block plain text again): `sh -c "$(cat <<EOF …)"` and `eval` (the script is only known when
//     the shell runs it), `bash <(cat <<EOF …)` (a process substitution has no word to read, and
//     adding one shifts every command's words), a git alias or an insteadOf in a repo's config
//     (`git -c alias.p=push p origin main`, or set by an earlier `git config`: the guard would
//     have to evaluate git's config), a script written by one command and run by the next (`cat >
//     s.sh <<EOF … EOF` then `bash s.sh`: reading every heredoc as a script would block reports
//     again), a command run inside a container without stdin (`docker exec c git push …`), python
//     code that passes a command in a variable (`subprocess.run(cmd)`), a symlink in a temp dir
//     made earlier by `cp -s` or another tool than `ln` (made after the hook ran or by a tool it
//     doesn't read), and a bare `git push` while on the default branch (the branch is git's
//     state, not the line's).
//   - The rest (gh / glab / API merges, herdr, the board CLI, the coordinator's git commands and
//     job.json `reserved_commands`) match a pattern anchored to a command position: the start
//     of the line or of any line, or after ; & | (, so a grep, a commit message or an echo that
//     mentions a command is not blocked, but a heredoc line that starts with one is. Write such
//     text with the Write tool instead of `cat <<EOF`.
//
// Codex hands the hook the session's cwd, not the shell tool's `workdir`, so a Codex git command
// that only sets `workdir` is judged by the session's cwd. Start a Codex coordinator in the repo.
//
// Hook contract: JSON on stdin; exit 2 with a message on stderr blocks the tool call (with
// `--codex`: Codex's deny JSON on stdout). Anything unexpected (bad JSON, other tools) lets the
// call through. UserPromptSubmit prints nothing, because its stdout would be added to the
// conversation; it blocks only a Codex worker's `$job` prompt.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const VERSION = 13
export const DEFAULT_ROLE_ENV = "JOB_AGENT_ROLE"
export const JOB_TABS_FILE = "job-tabs.json"
const HOOK = ".claude/hooks/job-guard.mjs"

// A command position: the start of the command or of any line, or after ; & | ( . It may be
// preceded by runners (`bash`, `sh`, `nohup`, `sudo`, `env`, `nice -n 10`, `timeout -k 5 1800`,
// `. ` / `source`, `uv run`, …) and env assignments (`AWS_PROFILE=x`, `FOO="a b"`), in any
// order. A runner only counts at a command position, so `shellcheck x.sh ship.sh` is not
// read as `sh ship.sh`.
const SEP = String.raw`(?:^|[;&|(\n])\s*`
// A shell's `-n` only checks syntax, so `bash -n ship.sh` is not treated as running it.
const RUNNER = String.raw`(?:(?:bash|sh|zsh)(?:\s+-(?![a-z]*n)[a-z]+|\s+--[\w-]+)*|(?:exec|nohup|time|setsid|sudo|env|caffeinate|source|\.)(?:\s+-[\w-]+)*|uv\s+run|nice(?:\s+-n)?\s+-?\d+|timeout(?:\s+-[\w-]+(?:\s+\d+\w*)?)*\s+\d+\w*)\s+`
const ENV = String.raw`\w+=(?:"[^"]*"|'[^']*'|[^\s;&|]*)\s+`
const CMD = String.raw`${SEP}(?:${RUNNER}|${ENV})*`
// The rest of the same command (stops at ; & | or a newline). `{REST}` in a job.json pattern.
const REST = String.raw`[^;&|\n]*?`
// One shell word, quotes included (`user.name="A B"`).
const WORD = String.raw`(?:[^\s"'\`;&|]|"[^"]*"|'[^']*')+`
// `git` plus its global options, up to the subcommand: `git -C ../x -c a=b --no-pager commit`.
// The subcommand has to come next, so `git log --grep commit` is a `log`, not a `commit`.
const GIT = String.raw`(?:\S*/)?git(?<opts>(?:\s+(?:-[Cc]\s+${WORD}|--(?:git-dir|work-tree|namespace)(?:=|\s+)${WORD}|--?[\w-]+(?:=${WORD})?))*)\s+`
// A subcommand ends at a non-word character, so `commit` does not match `commit-graph`.
const END = String.raw`(?![\w-])`
const HERDR = String.raw`(?:(?:\S*/)?herdr|"?\$\{?HERDR_BIN_PATH\}?"?)(?:\s+--?[\w-]+(?:=${WORD})?)*\s+`

const rule = (body, what) => ({ re: new RegExp(CMD + body), what })
// `all` finds every match, so `git -C ~/other commit && git commit` checks both commits.
const gitRule = (body, what) => ({ all: new RegExp(CMD + body, "g"), what })
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The reserved commands that are always on, whatever job.json says. */
function builtinReserved(defaultBranch, env = process.env) {
  const branches = [...new Set(["main", "master", defaultBranch].filter(Boolean))]
  const label = defaultBranch || "main"
  return [
    // v13: read from the programs the line runs, so a heredoc body, a commit message or a grep
    // that mentions a push isn't one, and neither is a push to a scratch repo in a temp dir.
    programRule(
      (run, runs) => pushesTo(run, branches, env, runs),
      new RegExp(
        CMD +
          String.raw`git\b${REST}\bpush\b${REST}(?:[\s:+'"](?:refs/heads/)?(?:${branches.map(escapeRe).join("|")})(?![\w/.-])|\s--(?:all|mirror)\b)`,
      ),
      `pushing to ${label}`,
      env,
    ),
    rule(String.raw`gh\s+pr\s+merge\b`, "merging a PR (gh pr merge)"),
    rule(String.raw`glab\s+mr\s+merge\b`, "merging a merge request (glab mr merge)"),
    rule(
      String.raw`(?:curl|wget|https?|xh|gh\s+api)\b${REST}\b(?:pulls|pullrequests|merge_requests)/\d+/merge\b`,
      "merging a PR through the API",
    ),
    // The skill's Bitbucket merge (it also commits the build stamp on the default branch). v11:
    // read from the shell words, so only a real run counts (see bbMergeRun).
    { re: { test: (command) => bbMergeRun(command, env) }, what: "merging a Bitbucket PR (bb-merge.mjs; its --dry-run is fine)" },
  ]
}

// ---- bb-merge.mjs: real runs only (v11) --------------------------------------------------------

/**
 * The simple commands of a shell command line, each as its words after quote removal
 * ({ text, glob }), as the shell would run them: comments, redirect targets and heredoc bodies
 * left out (a command's heredoc text is its `heredoc`); the commands inside $( ), backticks, <( )
 * and an unquoted heredoc's $( ) included.
 * Throws on an unterminated quote or $( (the shell would refuse the line).
 */
export function shellCommands(src, heredocBody = false) {
  const commands = []
  const pending = [] // heredocs that start after the next newline: { delim, strip, quoted, owner }
  let i = 0
  const OPS = " \t\n;&|()<>"
  // An and-or list (`a && b || c`, with its pipes) is one `chain`: a command after && or || is
  // `conditional`, and an assignment there may not have run once the chain ends.
  let chains = 0
  let chain = 0

  // Commands until `end` (")" or "`"), or to the end of the text.
  function list(end) {
    const outer = chain
    chain = ++chains
    let words = []
    let target = false // the next word is a redirect target
    let herestring = false // the next word is a here-string (`<<< text`): the command's stdin
    const finish = () => {
      if (words.length) {
        words.chain = chain
        commands.push(words)
      }
      words = []
    }
    while (i < src.length) {
      const c = src[i]
      if (end && c === end) {
        i++
        finish()
        chain = outer
        return
      }
      if (c === "\n") {
        i++
        finish()
        chain = ++chains
        heredocs()
      } else if (c === " " || c === "\t") i++
      else if (c === "\\" && src[i + 1] === "\n") i += 2
      else if (c === "#") while (i < src.length && src[i] !== "\n") i++
      else if (c === "&" && src[i + 1] === ">") {
        i += src[i + 2] === ">" ? 3 : 2
        target = "write"
        words.redirectOut = true
      } else if (";&|".includes(c)) {
        const start = i
        while (i < src.length && ";&|".includes(src[i])) i++
        const op = src.slice(start, i)
        const before = words
        finish()
        // `cat <<EOF | bash`: the command after a pipe keeps the one before it (`stdinFrom`).
        if (op === "|" || op === "|&") words.stdinFrom = before
        else if (op === "&&" || op === "||") words.conditional = true
        else chain = ++chains
      } else if (c === "(") {
        i++
        finish()
        list(")")
      } else if (c === ")") {
        i++
        finish()
      } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
        i += 2
        list(")")
      } else if (c === "<" || c === ">") {
        const op = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(src.slice(i))[0]
        i += op.length
        // `2>&1`: the digits before it name a file descriptor, not a word.
        let fd = null
        if (words.length && words.at(-1).end === i - op.length && /^\d+$/.test(words.at(-1).text)) fd = words.pop().text
        if (op === "<<" || op === "<<-") {
          while (src[i] === " " || src[i] === "\t") i++
          const delim = word()
          pending.push({ delim: delim.text, strip: op === "<<-", quoted: delim.quoted, owner: words })
        } else if (op === "<<<") herestring = true
        else {
          target = /^(?:>|<>)/.test(op) ? "write" : "read"
          // Its output goes to a file (`> out`, `>> log`), not to the next command.
          if (/^>(?:>|\|)?$/.test(op) && (fd === null || fd === "1")) words.redirectOut = true
        }
      } else {
        const w = word()
        if (herestring) {
          herestring = false
          words.heredoc = (words.heredoc ?? "") + w.text + "\n"
        } else if (target) {
          // The files a command writes (`> /tmp/x.git`), so a push to one on the same line is seen.
          if (target === "write") (words.writes ??= []).push(w.text)
          target = false
        } else words.push(w)
      }
    }
    if (end) throw new Error(`unterminated ${end === ")" ? "$( or (" : "`"}`)
    finish()
    chain = outer
  }

  // One word: { text, glob, quoted, end }.
  function word() {
    let text = ""
    let glob = false
    let quoted = false
    while (i < src.length && !OPS.includes(src[i])) {
      const c = src[i]
      if (c === "\\") {
        text += src[i + 1] ?? ""
        quoted = true
        i += 2
      } else if (c === "'") {
        const close = src.indexOf("'", i + 1)
        if (close < 0) throw new Error("unterminated '")
        text += src.slice(i + 1, close)
        quoted = true
        i = close + 1
      } else if (c === '"') {
        i++
        text += dquoted('"')
        quoted = true
      } else if (c === "$" && src[i + 1] === "'") {
        // $'…' (ANSI-C quoting): a backslash escapes the next character, \' included.
        let j = i + 2
        while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1
        if (j >= src.length) throw new Error("unterminated $'")
        text += src.slice(i + 2, j).replace(/\\(.)/gs, "$1")
        quoted = true
        i = j + 1
      } else if (c === "$" || c === "`") text += substitution()
      else {
        if ("*?[".includes(c)) glob = true
        text += c
        i++
      }
    }
    return { text, glob, quoted, end: i }
  }

  // The inside of "…" (or, with close null, an unquoted heredoc body), its substitutions read.
  function dquoted(close) {
    let text = ""
    while (i < src.length && src[i] !== close) {
      const c = src[i]
      if (c === "\\" && i + 1 < src.length) {
        text += '$`"\\\n'.includes(src[i + 1]) ? src[i + 1] : c + src[i + 1]
        i += 2
      } else if (c === "$" || c === "`") text += substitution()
      else {
        text += c
        i++
      }
    }
    if (close) {
      if (i >= src.length) throw new Error(`unterminated ${close}`)
      i++
    }
    return text
  }

  // At a `$` or a backtick: $( ) and `…` add their commands; ${…} and $x stay as text.
  function substitution() {
    const start = i
    if (src[i] === "`") {
      i++
      list("`")
    } else if (src[i + 1] === "(") {
      i += 2
      list(")")
    } else if (src[i + 1] === "{") {
      const close = src.indexOf("}", i)
      // A quote inside ${…} (`${X:-'}'}`) may hide the } that ends it: the line isn't read
      // (the rules fall back to their pattern).
      if (/['"`\\]/.test(src.slice(i + 2, close < 0 ? src.length : close))) throw new Error("a quote inside ${…}")
      i = close < 0 ? src.length : close + 1
    } else i++
    return src.slice(start, i)
  }

  // The heredoc bodies that start here, up to each delimiter line (or the end of the text).
  function heredocs() {
    for (const { delim, strip, quoted, owner } of pending.splice(0)) {
      let body = ""
      while (i < src.length) {
        const nl = src.indexOf("\n", i)
        const line = src.slice(i, nl < 0 ? src.length : nl)
        i = nl < 0 ? src.length : nl + 1
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break
        body += line + "\n"
      }
      // The command it is fed to keeps it (as `heredoc`), so a shell that reads it can be judged.
      owner.heredoc = (owner.heredoc ?? "") + body
      if (!quoted) commands.push(...shellCommands(body, true))
    }
  }

  if (heredocBody) dquoted(null)
  else list(null)
  return commands
}

// Runners that come before the real command, and their options that take a value.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const PREFIXES = new Set([
  "exec", "nohup", "time", "setsid", "caffeinate", "source", ".", "command", "builtin", "nice", "env", "sudo", "doas",
  "timeout", "xargs", "stdbuf", "ionice", "with-agent", "with-agent.sh", "with-heavy-lock.sh",
])
const VALUE_OPTIONS = {
  sudo: /^-[ugCDhprtUT]$/,
  doas: /^-[uC]$/,
  env: /^-[uCS]$/,
  nice: /^-n$/,
  timeout: /^(?:-[ks]|--(?:kill-after|signal))$/,
  xargs: /^-[adEILnPs]$/,
  stdbuf: /^-[ioe]$/,
  ionice: /^-[cnp]$/,
  flock: /^(?:-[wE]|--(?:wait|timeout|conflict-exit-code))$/,
  ssh: /^-[bcDEeFIiJLlmOopQRSWwB]$/,
  su: /^(?:-[sgGw]|--(?:shell|group|supp-group|whitelist-environment))$/,
}
// Shell keywords before a command (`if git push …`, `then …`, `{ …; }`); after the middle four,
// an assignment may not run.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"])
const CONDITIONAL_KEYWORDS = new Set(["then", "else", "elif", "do"])
// Programs that read stdin only as data, never as commands: a heredoc, here-string or pipe into
// one of them isn't run. Any other program that gets stdin (one the guard doesn't know, `ssh
// host`, `docker exec -i c bash`) is taken to run it, unless its output goes to a file.
const NON_RUNNERS = new Set([
  "cat", "tee", "grep", "egrep", "fgrep", "rg", "jq", "yq", "sed", "awk", "gawk", "head", "tail", "wc", "sort", "uniq",
  "tr", "cut", "diff", "cmp", "less", "more", "base64", "xxd", "od", "hexdump", "column", "fold", "fmt", "nl", "paste",
  "comm", "rev", "tac", "true", "false", ":", "read", "mapfile", "readarray", "echo", "printf", "git", "gh", "glab",
  "curl", "patch", "sponge", "pbcopy", "xclip", "wl-copy", "md5sum", "sha1sum", "sha256sum", "shasum", "gzip",
  "gunzip", "zcat", "iconv", "envsubst", "done", "fi", "esac", "}", "test", "[", "[[", "sleep", "wait",
])
const PYTHON = /^python[\d.]*$/
const NODE_EVAL = /^(?:-e|-p|-pe|--eval|--print)$/
// node's own options that take the next word as their value (Node 22 accepts `--opt value` for
// these; V8's options don't). An unknown long option is handled in nodeScriptAt().
const NODE_VALUE = new RegExp(
  "^(?:-r|-C|--(?:" +
    [
      "require", "import", "loader", "experimental-loader", "env-file", "env-file-if-exists", "conditions", "input-type",
      "title", "redirect-warnings", "diagnostic-dir", "unhandled-rejections", "disable-warning", "dns-result-order",
      "inspect-port", "debug-port", "watch-path", "watch-kill-signal", "report-dir", "report-directory",
      "report-filename", "report-signal", "heapsnapshot-signal", "icu-data-dir", "openssl-config", "tls-cipher-list",
      "tls-keylog", "trace-event-categories", "trace-event-file-pattern", "cpu-prof-dir", "cpu-prof-name",
      "cpu-prof-interval", "heap-prof-dir", "heap-prof-name", "heap-prof-interval", "localstorage-file",
      "max-http-header-size", "secure-heap", "secure-heap-min", "snapshot-blob", "experimental-config-file",
      "experimental-sea-config", "use-largepages", "disable-proto", "experimental-default-type",
      "heapsnapshot-near-heap-limit", "max-old-space-size-percentage", "network-family-autoselection-attempt-timeout",
      "trace-require-module", "v8-pool-size", "inspect-publish-uid", "test-name-pattern", "test-skip-pattern",
      "test-reporter", "test-reporter-destination", "test-concurrency", "test-timeout", "test-shard",
      "test-coverage-include", "test-coverage-exclude", "test-coverage-branches", "test-coverage-functions",
      "test-coverage-lines", "test-isolation", "test-global-setup",
    ].join("|") +
    "))$",
)
// Node code that calls a job script's entry point (`m.main([…])`, `closeJob(…)`, `sweep(…)`, also
// `m.main.call(…)`, `m["main"](…)`, `({ main: go }) => go(…)` and `Reflect.apply(m.main, …)`):
// the four job scripts run only when called, so importing one isn't a run but calling it is.
const ENTRY = String.raw`(?:main|closeJob|sweep)`
const CALLS_MAIN = new RegExp(
  String.raw`\b${ENTRY}\s*(?:\(|\.\s*(?:call|apply|bind)\b)|\[\s*["'\x60]${ENTRY}["'\x60]\s*\]\s*(?:\(|\.\s*(?:call|apply|bind)\b)|\b${ENTRY}\s*:\s*[A-Za-z_$]|\bReflect\.apply\s*\(\s*[\w$.]*\b${ENTRY}\b`,
)
const ENTRY_LITERAL = new RegExp(String.raw`^["'\x60]${ENTRY}["'\x60]$`)
/**
 * Node code with its string literals blanked, so a `main(` inside one (an edit's search text)
 * isn't a call: `m["main"]` and a template with `${…}` stay, and code that runs a string (eval,
 * Function) is kept whole.
 */
const CALLS_MAIN_CODE = {
  test: (text) =>
    CALLS_MAIN.test(
      /\beval\s*\(|\bFunction\s*\(/.test(text)
        ? text
        : text.replace(new RegExp(LITERAL, "g"), (lit) => (ENTRY_LITERAL.test(lit) || (lit[0] === "\x60" && lit.includes("${")) ? lit : "''")),
    ),
}
const NODE_NO_RUN = /^(?:-c|--check|--test|-v|--version|-h|--help)$/
// Code that starts a process (node, python, perl, ruby), outside its strings: its string literals
// are read as shell lines (`os.system("git push origin main")`, `execSync("node …/job-close.mjs
// x")`). A python script that edits a file and only holds such words in its strings isn't one.
// A method call such as RegExp's `.exec(` or `platform.system()` isn't one; `os.system(`,
// `os.execvp(` and `Kernel.system` are, and so is loading a process module by a string
// (`require("child_process")`, `from "execa"`; LOADS_MODULE), but not a string that only holds one.
const SPAWNS = new RegExp(
  String.raw`\b(?:child_process|execSync|execFile\w*|exec[lv]p?e?|execa\w*|spawn\w*|fork|popen|Popen|subprocess|qx|Open3|pty|Command)\b` +
    String.raw`|(?<![\w.])(?:exec|system)\b|\b(?:os|posix|Kernel|Process)\.(?:exec\w*|system)\b|%x[({[]`,
)
const MODULES = String.raw`(?:node:)?(?:child_process|subprocess|execa|shelljs)`
const MODULE_LITERAL = new RegExp(String.raw`^(["'\x60])${MODULES}\1$`)
const LOADS_MODULE = new RegExp(String.raw`(?:\b(?:require|import|__import__|import_module)\s*\(\s*|\bfrom\s+)(["'\x60])${MODULES}\1`)
const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`
// Python's triple-quoted strings, which may span lines; matched before LITERAL.
const TRIPLE = String.raw`'''[\s\S]*?'''|"""[\s\S]*?"""`

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/
const lastPart = (text) => String(text ?? "").split("/").pop()

/**
 * A shell glob (`*`, `?`, `[…]`, `[!…]`) as an anchored regex. As in the shell, a `[` with no
 * closing `]` is a plain character, so `[` (the test command) and `[[` match only themselves.
 */
export function globRegex(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      let j = i + 1
      if (glob[j] === "!" || glob[j] === "^") j++
      if (glob[j] === "]") j++
      const close = glob.indexOf("]", j)
      if (close < 0) {
        re += "\\["
        continue
      }
      let body = glob.slice(i + 1, close)
      const negated = body[0] === "!" || body[0] === "^"
      if (negated) body = body.slice(1)
      re += `[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`
      i = close
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

// `$X`, `${X}`, `${X:?}`, `${X:-default}`.
const VAR_REF = /\$(?:\{(\w+)(?:(:?[-=?+])([^}]*))?\}|(\w+))/g
// A variable's value in a world where its assignment didn't run and it had no value before (bash:
// unset). Not null (unknown): `$R` is then empty and `${R:-origin}` is origin.
const UNSET = "\0unset"

/**
 * `text` with its variables filled in from `vars` (the line's own assignments; null = assigned
 * something unreadable), TMPDIR and HOME from env, or a `${X:-default}`. null when one is unknown.
 */
function expand(text, vars, env) {
  let unknown = false
  const out = text.replace(VAR_REF, (_, braced, op, alt, bare) => {
    const name = braced ?? bare
    let value = vars.has(name) ? vars.get(name) : name === "TMPDIR" ? env.TMPDIR || tmpdir() : name === "HOME" ? env.HOME : undefined
    if (value === UNSET) value = !op ? "" : /^:?[-=]$/.test(op) ? alt : /^:?\+$/.test(op) ? "" : null
    else if (value === "" && op && /^:[-=]$/.test(op)) value = alt
    else if (value == null && op && /^:?[-=]$/.test(op)) value = alt
    if (value == null) unknown = true
    return value ?? ""
  })
  return unknown ? null : out
}

/** The directory a `mktemp …` command line makes (its template, X's left in), or null. */
function mktempDir(inner, vars, env) {
  let commands
  try {
    commands = shellCommands(inner)
  } catch {
    return null
  }
  if (commands.length !== 1 || lastPart(commands[0][0]?.text) !== "mktemp") return null
  let dir = null
  let template = null
  let inTemp = false
  const args = commands[0].slice(1)
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text
    if (t === "-p") {
      dir = args[++j]?.text ?? ""
      inTemp = true
    } else if (t.startsWith("--tmpdir=")) {
      dir = t.slice("--tmpdir=".length)
      inTemp = true
    } else if (t === "--tmpdir" || /^-[A-Za-z]*t[A-Za-z]*$/.test(t)) inTemp = true
    else if (!t.startsWith("-")) template = t
  }
  const base = dir === null || dir === "" ? env.TMPDIR || tmpdir() : expand(dir, vars, env)
  if (base === null) return null
  if (template === null) return join(base, "tmp.XXXXXXXXXX")
  const name = expand(template, vars, env)
  if (name === null) return null
  // A relative template without -t / -p is made in the current directory.
  return name.startsWith("/") ? name : inTemp ? join(base, name) : null
}

const DECLARE = new Set(["export", "readonly", "local", "declare", "typeset"])

/** The assignments of an assignment-only command (`T=$(mktemp -d)`, `export F=x`, `then R=y`). */
function assignments(words) {
  let k = 0
  while (KEYWORDS.has(words[k]?.text)) k++
  const declared = DECLARE.has(words[k]?.text)
  if (declared) k++
  const rest = words.slice(k)
  if (!rest.length || !rest.every((w) => ASSIGNMENT.test(w.text) || (declared && w.text.startsWith("-")))) return []
  return rest.filter((w) => ASSIGNMENT.test(w.text)).map((w) => w.text)
}

/** An assignment-only command: its values go into `vars` (`R+=x` appends). */
function remember(words, vars, env) {
  for (const text of assignments(words)) {
    const [whole, name, append] = /^([A-Za-z_]\w*)(\+?)=/.exec(text)
    const value = text.slice(whole.length)
    const sub = /^(?:\$\(([\s\S]*)\)|`([\s\S]*)`)$/.exec(value)
    // A substitution other than mktemp keeps its raw text (`$(ls …/job-close.mjs)`), so a rule
    // can still see a script or branch it names (see unreadable()).
    let next = sub ? (mktempDir(sub[1] ?? sub[2], vars, env) ?? value) : expand(value, vars, env)
    if (append) {
      const before = expand(`\${${name}}`, vars, env)
      next = before === null || next === null ? null : before + next
    }
    vars.set(name, next)
  }
}

/** The names an assignment-only command assigns. */
const assignedNames = (words) => assignments(words).map((text) => /^[A-Za-z_]\w*/.exec(text)[0])

/** A copy of `vars` for the world where an assignment to `names` didn't run. */
function notRunWorld(vars, names, env) {
  const copy = new Map(vars)
  // A name with no value before is unset there; one set in the env keeps its unknown value.
  for (const name of names) if (!copy.has(name) && name !== "TMPDIR" && name !== "HOME" && env[name] == null) copy.set(name, UNSET)
  return copy
}

/**
 * Two lists of worlds joined, without copies, at most 8. Over 8, the kept ones still hold every
 * value each variable has in any world (picked greedily); when 8 can't, the line isn't read
 * (throws: the rules fall back to their pattern).
 */
function joinWorlds(a, b) {
  const seen = new Set()
  const unique = [...a, ...b].filter((w) => {
    const key = JSON.stringify([...w])
    return !seen.has(key) && seen.add(key)
  })
  if (unique.length <= 8) return unique
  const names = [...new Set(unique.flatMap((w) => [...w.keys()]))]
  const pairs = (w) => names.map((name) => JSON.stringify([name, w.has(name) ? w.get(name) : UNSET + "?"]))
  const left = new Set(unique.flatMap(pairs))
  const kept = []
  while (left.size && kept.length < 8) {
    let best = null
    let gain = 0
    for (const w of unique) {
      if (kept.includes(w)) continue
      const n = pairs(w).filter((pair) => left.has(pair)).length
      if (n > gain) [best, gain] = [w, n]
    }
    kept.push(best)
    for (const pair of pairs(best)) left.delete(pair)
  }
  if (left.size) throw new Error("too many variable worlds")
  for (const w of unique) if (kept.length < 8 && !kept.includes(w)) kept.push(w)
  return kept
}

// Blocks whose branch may not run: an assignment anywhere in a `then` / `else` / `do` branch (or
// an `elif` condition) holds until the block's `fi` / `done` (or the next `else` / `elif`).
const BLOCK_START = new Set(["if", "while", "until", "for", "select"])
const BLOCK_END = new Set(["fi", "done"])

/** Words expanded to nothing in `vars` and not quoted are dropped, as bash does (`git push $R main`, R unset). */
const dropEmpty = (words, vars, env) => words.filter((w) => w.quoted || expand(w.text, vars, env) !== "")

const STDIN = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/

/**
 * The text a command reads on stdin, or null: its own heredoc or here-string, or what the pipe
 * into it carries, from the nearest link that has text (a heredoc or here-string, or the words of
 * `echo` / `printf`): `cat <<EOF | tee x | bash`, `echo '…' | node`.
 */
function stdinText(words) {
  for (let w = words, n = 0; w && n < 32; w = w.stdinFrom, n++) {
    if (w.heredoc != null) return w.heredoc
    if (w === words) continue
    let k = 0
    while (k < w.length && ASSIGNMENT.test(w[k].text)) k++
    const name = lastPart(w[k]?.text)
    if (name === "echo") {
      while (/^-[neE]+$/.test(w[k + 1]?.text ?? "")) k++
      return w.slice(k + 1).map((x) => x.text).join(" ") + "\n"
    }
    if (name === "printf") return w.slice(k + 1).map((x) => x.text.replace(/\\n/g, "\n")).join(" ") + "\n"
  }
  return null
}

const stdinRun = (words) => {
  const text = stdinText(words)
  return text === null ? null : { script: text, fromStdin: true }
}

/**
 * What one simple command runs: { words } from its program on (env assignments, shell keywords
 * and runners such as `timeout`, `sudo -u x`, `xargs`, `nice -n 5`, `with-agent`, `flock <file>`
 * skipped), { script } for shell text it runs (a shell's `-c` text, `su -c`, `ssh host <cmd>`, or
 * the stdin that a shell, `sudo -s`, `su` or `ssh host` reads), or null (`bash -n`, nothing run).
 * { xargs: { words, replace } } for xargs, whose stdin becomes the command's arguments. Also
 * `assigns` (the env assignments before the program) and `scriptFile` (a shell was given a script
 * file, which reads stdin as data).
 */
function runOf(words) {
  let k = 0
  let prefixed = null // the last runner skipped
  let scriptFile = false
  const assigns = []
  const done = (run) => (run ? { ...run, assigns } : null)
  for (;;) {
    while (k < words.length && (ASSIGNMENT.test(words[k].text) || KEYWORDS.has(words[k].text))) {
      if (ASSIGNMENT.test(words[k].text)) assigns.push(words[k].text)
      k++
    }
    // sudo or doas with nothing after it (`sudo -s`, `sudo -i`) reads its commands on stdin.
    if (k >= words.length) return done(prefixed === "sudo" || prefixed === "doas" ? stdinRun(words) : null)
    const name = lastPart(words[k].text)
    if (name === "uv" && words[k + 1]?.text === "run") k++
    else if (SHELLS.has(name)) {
      k++
      let readsStdin = false
      let command = false
      while (/^[-+]./.test(words[k]?.text ?? "")) {
        const opt = words[k++].text
        if (opt === "--") break
        if (opt.startsWith("--")) {
          if (/^--(?:rcfile|init-file)$/.test(opt)) k++
          continue
        }
        if (/^-[a-zA-Z]*c/.test(opt)) command = true
        if (/^-[a-zA-Z]*n/.test(opt)) return null
        if (/^-[a-zA-Z]*s/.test(opt)) readsStdin = true
        // `-o pipefail`, and an option group that ends in o: `-euo pipefail`.
        if (/^[-+][a-zA-Z]*[oO]$/.test(opt)) k++
      }
      // `bash -c -x 'cmd'`, `bash -c -- 'cmd'`: the script is the first word after the options.
      if (command) return done({ script: words[k]?.text ?? "" })
      // A shell with no script, `-s` or the script `-` / /dev/stdin reads its own heredoc or
      // the one piped into it (`cat <<EOF | bash -s -- arg`).
      if (readsStdin || k >= words.length || STDIN.test(words[k].text)) return done(stdinRun(words))
      scriptFile = true
      continue
    } else if ((name === "." || name === "source") && STDIN.test(words[k + 1]?.text ?? "")) return done(stdinRun(words))
    else if (name === "su") {
      for (let j = k + 1; j < words.length; j++) {
        const t = words[j].text
        if (/^-[a-zA-Z]*c$|^--command$/.test(t)) return done({ script: words[j + 1]?.text ?? "" })
        if (t.startsWith("--command=")) return done({ script: t.slice("--command=".length) })
        if (VALUE_OPTIONS.su.test(t)) j++
      }
      return done(stdinRun(words))
    } else if (name === "ssh") {
      let j = k + 1
      while (words[j]?.text.startsWith("-")) j += VALUE_OPTIONS.ssh.test(words[j].text) ? 2 : 1
      if (j >= words.length) return null
      // ssh joins the words after the host into one line for the remote shell.
      const rest = words.slice(j + 1)
      return done(rest.length ? { script: rest.map((w) => w.text).join(" ") } : stdinRun(words))
    } else if (name === "flock") {
      k++
      while (words[k]?.text.startsWith("-") && !/^(?:-c|--command)$/.test(words[k].text)) k += VALUE_OPTIONS.flock.test(words[k].text) ? 2 : 1
      if (/^(?:-c|--command)$/.test(words[k]?.text ?? "")) return done({ script: words[k + 1]?.text ?? "" })
      k++ // the lock file
      if (/^(?:-c|--command)$/.test(words[k]?.text ?? "")) return done({ script: words[k + 1]?.text ?? "" })
      prefixed = name
      continue
    } else if (name === "xargs") {
      // xargs adds its stdin to the command's arguments (or puts each line in place of -I's text).
      k++
      let replace = null
      while (words[k]?.text.startsWith("-")) {
        const opt = words[k++].text
        if (opt === "--") break
        if (opt === "-I") replace = words[k++]?.text ?? "{}"
        else if (opt === "-i" || opt === "--replace") replace = "{}"
        else if (/^-[Ii]./.test(opt)) replace = opt.slice(2)
        else if (opt.startsWith("--replace=")) replace = opt.slice("--replace=".length)
        else if (VALUE_OPTIONS.xargs.test(opt)) k++
      }
      return done({ xargs: { words: words.slice(k), replace } })
    } else if (!PREFIXES.has(name)) break
    prefixed = name
    k++
    // The runner's options (and a value after one that takes it), then timeout's duration.
    while (words[k]?.text.startsWith("-") || (name === "nice" && /^-?\d+$/.test(words[k]?.text))) {
      const opt = words[k++].text
      if (opt === "--") break
      if (VALUE_OPTIONS[name]?.test(opt)) k++
    }
    if (name === "timeout" && /^\d/.test(words[k]?.text ?? "")) k++
  }
  return done({ words: words.slice(k), scriptFile })
}

/**
 * Where node's script word is (past its options and their values), as { k } (k = words.length
 * when there is none), or { eval } for `-e` / `-p` code, or null when node only checks or tests.
 * `isScript(word)` tells an unknown option's value from the script (see scriptArgs).
 */
function nodeScriptAt(words, isScript = () => false, named = () => false) {
  let k = 1
  while (words[k]?.text.startsWith("-") && !STDIN.test(words[k].text)) {
    const opt = words[k++].text
    if (NODE_NO_RUN.test(opt)) return null
    if (NODE_EVAL.test(opt)) return { eval: words[k]?.text ?? "" }
    if (NODE_VALUE.test(opt)) {
      if (named(words[k++]?.text)) return { named: true }
    } else if (/^--[\w-]+=/.test(opt)) {
      if (named(opt)) return { named: true }
    } else if (/^--[\w-]+$/.test(opt)) {
      // An option it doesn't know may take the next word: `node --new-option value script.mjs`,
      // `node --new-option value --no-warnings script.mjs`.
      const value = words[k]
      const after = words[k + 1]
      if (value && !value.text.startsWith("-") && !isScript(value) && after && (after.text.startsWith("-") || isScript(after))) k++
    }
  }
  return { k }
}

/**
 * The code an interpreter (node, python, perl, ruby) runs, as { code: [texts], stdin } (stdin:
 * true when it reads its code on stdin: no script, or the script `-` / /dev/stdin), or null when
 * the program isn't one. A script file reads stdin as data.
 */
function interpreterCode(words) {
  const name = lastPart(words[0].text)
  if (name === "node" || name === "nodejs") {
    const at = nodeScriptAt(words)
    if (!at) return { code: [], stdin: false }
    if (at.eval !== undefined) return { code: [at.eval], stdin: false }
    return { code: [], stdin: !words[at.k] || STDIN.test(words[at.k].text), node: true }
  }
  const python = PYTHON.test(name)
  if (!python && name !== "perl" && name !== "ruby") return null
  const code = []
  let k = 1
  while (words[k]?.text.startsWith("-") && words[k].text !== "-") {
    const opt = words[k++].text
    if (opt === "--") break
    if (python ? opt === "-c" : /^-[a-zA-Z]*[eE]$/.test(opt)) {
      code.push(words[k++]?.text ?? "")
      if (python) return { code, stdin: false }
    } else if (python && opt === "-m") return { code, stdin: false }
    else if (python ? /^-[WX]$/.test(opt) : /^-[IrC]$/.test(opt)) k++
  }
  return { code, stdin: !code.length && (!words[k] || STDIN.test(words[k].text)) }
}

/**
 * The shell lines in code that starts a process (outside its strings; in perl or ruby a backtick
 * string is one): its string literals, and each list of them joined.
 */
function spawnedLines(code, lang) {
  const outside = code.replace(new RegExp(`${TRIPLE}|${LITERAL}`, "g"), "''")
  const backticks = (lang === "perl" || lang === "ruby") && code.includes("\x60")
  const loads = LOADS_MODULE.test(code.replace(new RegExp(`${TRIPLE}|${LITERAL}`, "g"), (lit) => (MODULE_LITERAL.test(lit) ? lit : "''")))
  if (!SPAWNS.test(outside) && !loads && !backticks) return []
  const unquote = (lit) => lit.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(.)/g, "$1")
  // A literal with no space (a path, an option) is a list item, not a command line.
  const lines = [...code.matchAll(new RegExp(LITERAL, "g"))].map((m) => unquote(m[0])).filter((line) => /\s/.test(line.trim()))
  for (const m of code.matchAll(new RegExp(String.raw`(?:${LITERAL})(?:\s*,\s*(?:${LITERAL}))+`, "g")))
    lines.push([...m[0].matchAll(new RegExp(LITERAL, "g"))].map((x) => unquote(x[0])).join(" "))
  return lines
}

/**
 * The programs a command line runs (v13), each as { words, vars, assigns }: words[0] is the
 * program, and vars the line's assignments made before it. The commands of $( ), backticks, a
 * subshell, a `bash -c` script count, and so does the stdin (a heredoc, a here-string, or a pipe
 * from a heredoc or `echo`) of any program that may run it: a shell, `sudo -s`, `su`, `ssh
 * host`, a program the guard doesn't know, xargs, and node / python / perl / ruby with no script
 * (node's code is judged as `-e` code; code that starts a process has its string literals read as
 * shell lines). It doesn't for a program that only reads data (cat, tee, grep, jq, sed, git, gh,
 * …; see NON_RUNNERS), a script file, or a program whose output goes to a file. A quoted
 * argument, a comment and an assignment's value never count. An assignment that may not run
 * (after && or ||, or in a branch) is followed both ways: in the other world the variable keeps
 * its old value, or is unset. Throws when the line can't be read (an unterminated
 * quote): the rules then fall back to a pattern.
 */
export function programs(command, env = process.env, vars = new Map(), depth = 0, stdin = null) {
  const runs = []
  let worlds = [vars]
  let notRun = []
  // Per open if / while / until / for: { loop, pre: the worlds when its first branch (or a loop's
  // body) began, null in its condition; ends: each finished branch's worlds; names: what its
  // branches (and the blocks inside them) assign; done: an `else` was seen }. An `elif` / `else`
  // branch starts from pre, with what the earlier branches assign unset when it had no value
  // before. At `fi` the branches' worlds join, and pre (so unset) too when there's no else; at
  // `done` the loop's pre joins, for a body that never ran.
  const blocks = []
  const copies = (list) => list.map((w) => new Map(w))
  const skipped = (block) => block.pre.map((w) => notRunWorld(w, [...block.names], env))
  const endBlock = (block) => {
    if (!block?.pre) return
    worlds = block.loop ? joinWorlds(worlds, skipped(block)) : joinWorlds([...block.ends, ...worlds], block.done ? [] : skipped(block))
  }
  let chain
  for (const words of shellCommands(String(command))) {
    // `bash -c '…' <<EOF`, `ssh host bash -s <<EOF`: the script's commands get the stdin of the
    // command that runs it.
    if (stdin !== null && words.heredoc == null && !words.stdinFrom) words.heredoc = stdin
    // Once an and-or list ends, an assignment made after its && or || may not have run.
    if (words.chain !== chain) {
      worlds = joinWorlds(worlds, notRun)
      notRun = []
      chain = words.chain
    }
    // A block's end (and an `else` / `elif`) brings back the worlds where its branch didn't run.
    if (BLOCK_END.has(words[0]?.text)) endBlock(blocks.pop())
    for (let k = 0; k < words.length && (KEYWORDS.has(words[k].text) || BLOCK_START.has(words[k].text)); k++) {
      const t = words[k].text
      const top = blocks.at(-1)
      if (top && !top.pre && (t === "then" || t === "do")) top.pre = copies(worlds)
      else if (top?.pre && !top.loop && (t === "elif" || t === "else")) {
        top.ends.push(...worlds)
        worlds = skipped(top)
        if (t === "else") top.done = true
      }
      if (BLOCK_START.has(t)) blocks.push({ loop: t !== "if", pre: null, ends: [], names: new Set(), done: false })
      if (t === "for" || t === "select") break
    }
    const names = assignedNames(words)
    if (names.length) {
      for (const block of blocks) if (block.pre) for (const name of names) block.names.add(name)
      // No block seen (a `then` the reader didn't pair): followed to the end of the and-or list.
      if (words.conditional || (!blocks.length && CONDITIONAL_KEYWORDS.has(words[0]?.text))) notRun.push(...worlds.map((w) => notRunWorld(w, names, env)))
    }
    for (const w of worlds) remember(words, w, env)
    visit(words)
  }
  return runs

  function visit(words, built = 0) {
    const run = runOf(words)
    if (!run) return
    if (run.xargs) {
      // `echo x.mjs | xargs wc -l` runs `wc -l x.mjs`; xargs alone runs echo.
      const rest = run.xargs.words.length ? run.xargs.words : [{ text: "echo" }]
      const input = stdinText(words)
      if (input === null) return visit(rest, built + 1)
      const { replace } = run.xargs
      const items = replace === null ? [input] : input.split("\n").filter((line) => line.trim()).slice(0, 32)
      for (const item of items) {
        const args = replace === null
          ? [...rest, ...item.split(/\s+/).filter(Boolean).map((text) => ({ text }))]
          : rest.map((w) => ({ ...w, text: w.text.split(replace).join(item) }))
        if (built < 4) visit(args, built + 1)
      }
      return
    }
    const shell = [] // shell text this command runs
    const code = [] // interpreter code it runs
    let nodeStdin = null
    let lang = null
    if (run.script !== undefined) shell.push(run.script)
    if (run.words) {
      const stdin = run.scriptFile ? null : stdinText(words)
      const it = interpreterCode(run.words)
      if (it) {
        lang = lastPart(run.words[0].text)
        code.push(...it.code)
        if (it.stdin && stdin !== null) {
          code.push(stdin)
          if (it.node) nodeStdin = stdin
        }
      } else if (stdin !== null && !run.scriptFile && !words.redirectOut && !NON_RUNNERS.has(lastPart(run.words[0].text))) shell.push(stdin)
    }
    for (const w of worlds) {
      if (run.words) runs.push({ words: dropEmpty(run.words, w, env), vars: new Map(w), assigns: run.assigns, writes: words.writes ?? [] })
      // `node - <<EOF`, `echo '…' | node`: judged as `node -e <code>`.
      if (nodeStdin !== null) runs.push({ words: [run.words[0], { text: "-e" }, { text: nodeStdin }], vars: new Map(w), assigns: run.assigns })
      if (depth >= 8) continue
      for (const text of shell) runs.push(...programs(text, env, w, depth + 1, run.fromStdin || text !== run.script ? null : stdinText(words)))
      for (const text of code)
        for (const line of spawnedLines(text, lang)) {
          try {
            runs.push(...programs(line, env, w, depth + 1))
          } catch {
            // A literal that isn't a shell line.
          }
        }
    }
  }
}

/**
 * True when `text` (after the line's variables) holds a $( ) or backtick whose value the guard
 * can't read and whose raw text names `name` as a whole word: `node "$(ls …/job-close.mjs)"`,
 * `git push origin $(echo main)`. A substitution that names nothing (`"$(pick)"`) isn't one.
 */
function unreadable(text, name, vars, env) {
  const raw = expand(text, vars, env) ?? text.replace(VAR_REF, (whole, braced, _op, _alt, bare) => {
    const value = vars.get(braced ?? bare)
    return value === UNSET ? "" : (value ?? whole)
  })
  return /\$\(|`/.test(raw) && new RegExp(String.raw`(?:^|[^\w.-])${escapeRe(name)}(?![\w.-])`).test(raw)
}

/** True when `word` (its last path part, after the line's variables; a glob allowed) names `name`. */
function namesScript(word, name, vars, env) {
  const base = lastPart(expand(word.text, vars, env) ?? word.text)
  if (base === name || unreadable(word.text, name, vars, env)) return true
  if (!word.glob) return false
  try {
    return globRegex(base).test(name)
  } catch {
    return false // A range such as [z-a] matches nothing.
  }
}

/**
 * The arguments after the script `name` when this program runs it (as the program, by any path,
 * or as node's script), or null. With `code`, node code that names it (`-e`, `--import`, …) is a
 * run too (with no arguments): any such code for bb-merge.mjs (`code` true: it merges when
 * imported), code that also matches `code` (a RegExp: a call of the script's main) otherwise.
 */
function scriptArgs({ words, vars }, name, env, code = false) {
  const named = (text) =>
    Boolean(code) && String(text ?? "").includes(name.replace(/js$/, "")) && (code === true || code.test(String(text)))
  const isScript = (word) => namesScript(word, name, vars, env)
  let k = 0
  if (["node", "nodejs"].includes(lastPart(words[0].text))) {
    const at = nodeScriptAt(words, isScript, named)
    if (!at) return null
    if (at.named) return []
    if (at.eval !== undefined) return named(at.eval) ? [] : null
    k = at.k
  }
  if (!words[k] || !isScript(words[k])) return null
  return words.slice(k + 1)
}

/** A rule judged from the programs a line runs; `fallback` (a pattern) when it can't be read. */
function programRule(check, fallback, what, env = process.env) {
  // `callEnv`: the env decide() was given (a test's TMPDIR / HOME), else the one it was made with.
  const test = (command, callEnv = env) => {
    let runs
    try {
      runs = programs(command, callEnv)
    } catch {
      return fallback.test(String(command))
    }
    return runs.some((run) => check(run, runs, callEnv))
  }
  return { re: { test }, what }
}

const NODE_SCRIPT = String.raw`(?:(?:\S*/)?node(?:\s+-(?!c\b|-check\b)[\w-]+(?:[=\s][^\s;&|]+)?)*\s+)?`
const BB_MERGE_PATTERN = new RegExp(
  CMD + NODE_SCRIPT + String.raw`(?:[^\s;&|]*/)?bb-merge\.m[\w*?]*(?![\w.-])(?![^;&|\n#<>]*?\s--dry-run(?![\w-]))`,
)

/**
 * True when a command line runs the skill's bb-merge.mjs for real: with or without `node`, by
 * any path, through runners (`timeout`, `env`, `sudo`, `xargs`, `bash -c`, …), in $( ) or a
 * subshell, but not with `--dry-run` among its own arguments (`--dry-run` in a comment, a
 * redirect, another argument's quotes or another command doesn't count). Text that only
 * mentions it (a quoted commit message, a heredoc body, a grep, a `[ -f … ]` test) isn't a run.
 * A line the reader can't follow (an unterminated quote) is judged by a plain pattern instead.
 */
export function bbMergeRun(command, env = process.env) {
  return programRule((run) => {
    const args = scriptArgs(run, "bb-merge.mjs", env, true)
    return args !== null && !args.some((w) => w.text === "--dry-run")
  }, BB_MERGE_PATTERN, "").re.test(command)
}

/**
 * A rule for the skill's own procedures (v13: read from the programs a line runs): running one
 * of `names` counts, unless `open(args)` says that run only reads. `tail` ends the fallback
 * pattern (the same exception, for a line that can't be read).
 */
function scriptRule(names, what, open = () => false, tail = "") {
  const files = names.map((n) => escapeRe(n)).join("|")
  const fallback = new RegExp(CMD + NODE_SCRIPT + String.raw`(?:[^\s;&|]*/)?(?:${files})(?![\w.-])` + tail)
  const runs = (run, _runs, env) =>
    names.some((name) => {
      const args = scriptArgs(run, name, env, CALLS_MAIN_CODE)
      return args !== null && !open(args)
    })
  return programRule(runs, fallback, what)
}

// git's global options that take the next word as their value, push's, and git subtree push's.
const GIT_VALUE_OPTIONS = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source)$/
const PUSH_VALUE_OPTIONS = /^(?:-o|--push-option|--receive-pack|--exec)$/
const SUBTREE_VALUE_OPTIONS = /^(?:-P|--prefix|-m|--message)$/

/** The branch a push refspec writes: `+HEAD:refs/heads/main` → main. */
const pushTarget = (spec) => spec.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "")

/** The temp dirs a scratch repo lives in, by name. */
const tempRoots = (env) => [...new Set([env.TMPDIR, tmpdir(), "/tmp", "/private/tmp"].filter(Boolean).map((dir) => resolve(dir)))]

/**
 * `path` with its symlinks resolved, through its deepest folder that exists: { path, exists }.
 * A path on a network mount is never stat'ed (a stat there hangs while the other end is away).
 */
function realPath(path, env) {
  if (onNetworkMount(path, env)) return { path, exists: true }
  let rest = ""
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return { path: rest ? join(realpathSync(dir), rest) : realpathSync(dir), exists: !rest }
    } catch {
      // Not there (yet): try the folder above.
    }
    if (dirname(dir) === dir) return { path, exists: false }
    rest = rest ? join(basename(dir), rest) : basename(dir)
  }
}

/**
 * True when a push's remote is a local path inside a temp dir (a scratch bare repo), judged by
 * where it really points: a symlink in /tmp to a real repo isn't one. A path that doesn't exist
 * yet is judged by name, unless the line also runs `ln` (`linked`): the link it makes can't be
 * seen. A `${R:-/tmp/x}` default doesn't count when R is set in the env (its value is unknown).
 */
/**
 * The absolute paths a line writes: its redirect targets (`> /tmp/x.git`), tee's files, and the
 * last argument of cp, mv and ln. A path it can't expand is left out.
 */
function lineWrites(runs, env) {
  const paths = []
  for (const run of runs) {
    const name = lastPart(run.words[0]?.text)
    const args = run.words.slice(1).map((w) => w.text).filter((t) => !t.startsWith("-"))
    const texts = [...(run.writes ?? []), ...(name === "tee" ? args : ["cp", "mv", "ln"].includes(name) ? args.slice(-1) : [])]
    for (const text of texts) {
      const path = expand(text, run.vars, env)
      if (path?.startsWith("/")) paths.push(resolve(path))
    }
  }
  return paths
}

function scratchRemote(remote, vars, env, linked = false, written = []) {
  const inTemp = (path) => {
    const real = realPath(path, env)
    return roots.some((root) => {
      const realRoot = realPath(root, env).path
      return real.path !== realRoot && isInside(real.path, realRoot)
    })
  }
  const roots = tempRoots(env)
  for (const [, braced, op, , bare] of remote.matchAll(VAR_REF)) {
    const name = braced ?? bare
    if (op && !vars.has(name) && name !== "TMPDIR" && name !== "HOME" && env[name] != null) return false
  }
  const text = expand(remote, vars, env)
  if (text === null || /[$`]/.test(text)) return false
  const path = text.replace(/^file:\/\//, "")
  if (!path.startsWith("/")) return false
  const target = resolve(path)
  if (!roots.some((root) => target !== root && isInside(target, root))) return false
  // The line writes there (`printf 'gitdir: …' > /tmp/x.git`): what git opens can't be seen yet.
  if (written.some((p) => isInside(p, target) || isInside(p, `${target}.git`))) return false
  const repo = pushedRepo(target, env)
  // Nothing there yet: judged by name, unless the line also makes a link there.
  if (repo === undefined) return !linked && inTemp(target)
  return repo !== null && inTemp(repo)
}

/**
 * The repo `git push <path>` writes, as git finds it (`<path>/.git`, `<path>`, `<path>.git/.git`,
 * `<path>.git`; a gitfile `gitdir: …` or a linked worktree's commondir followed): its common git
 * dir; undefined when none of them exists (the push fails, or makes nothing outside the temp
 * dir); null when git can't say (it failed to start or timed out).
 */
function pushedRepo(path, env) {
  if (onNetworkMount(path, env)) return null
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
  for (const candidate of [`${path}/.git`, path, `${path}.git/.git`, `${path}.git`]) {
    if (!existsSync(candidate)) continue
    const out = spawnSync("git", ["--git-dir", candidate, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      env: gitEnv,
      timeout: 3000,
    })
    if (out.error || out.signal) return null
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim()
  }
  return undefined
}

/**
 * True when the line may send a push somewhere other than the path it names: `-c
 * url.<x>.insteadOf=…` (or pushInsteadOf), `--config-env`, GIT_CONFIG_* set on the line or in the
 * env with an insteadOf, or a GIT_CONFIG / GIT_CONFIG_GLOBAL file set on the line.
 */
function redirectsPush(globals, assigns, vars, env) {
  if (globals.some((opt) => /insteadof/i.test(opt) || opt.startsWith("--config-env"))) return true
  const line = [...assigns.map((text) => [text.slice(0, text.indexOf("=")).replace(/\+$/, ""), text.slice(text.indexOf("=") + 1)]), ...vars]
  if (line.some(([name]) => /^GIT_CONFIG(?:_GLOBAL|_SYSTEM)?$/.test(name))) return true
  return [...line, ...Object.entries(env)].some(([name, value]) => /^GIT_CONFIG_(?:KEY_\d+|PARAMETERS)$/.test(name) && /insteadof/i.test(String(value ?? "")))
}

/**
 * True when a refspec (after the line's variables) writes one of `branches`, or a $( ) whose
 * value can't be read names one (`git push origin $(echo main)`).
 */
function writesBranch(spec, branches, vars, env) {
  const target = pushTarget(expand(spec, vars, env) ?? spec)
  return branches.includes(target) || branches.some((branch) => unreadable(target, branch, vars, env))
}

/**
 * True when this program is a `git push` or `git subtree push` that writes one of `branches`
 * (`main`, `HEAD:main`, `+main`, `:main`, `refs/heads/main`) or pushes --all / --mirror, unless
 * its remote is a scratch repo in a temp dir (`git push "$T/r.git" main` after `T=$(mktemp -d)`).
 * As in git, a remote named on the line wins over --repo. `runs`: every program on the line.
 */
function pushesTo({ words, vars, assigns = [] }, branches, env, runs = []) {
  if (lastPart(words[0].text) !== "git") return false
  let k = 1
  const globals = [] // git's global options and their values
  while (words[k]?.text.startsWith("-")) {
    const step = GIT_VALUE_OPTIONS.test(words[k].text) ? 2 : 1
    globals.push(...words.slice(k, k + step).map((w) => w.text))
    k += step
  }
  const subtree = words[k]?.text === "subtree" && words[k + 1]?.text === "push"
  if (subtree) k++
  else if (words[k]?.text !== "push") return false
  let repo = null
  let every = false
  let elsewhere = redirectsPush(globals, assigns, vars, env)
  const specs = []
  for (let j = k + 1; j < words.length; j++) {
    const t = words[j].text
    if (t === "--") {
      specs.push(...words.slice(j + 1).map((w) => w.text))
      break
    }
    if (/^--(?:all|mirror|branches)$/.test(t)) every = true
    // `--receive-pack='git-receive-pack /root/repo #'`: the remote side is a command, not the path.
    else if (/^--(?:receive-pack|exec)(?:=|$)/.test(t)) {
      elsewhere = true
      if (!t.includes("=")) j++
    }
    else if (t.startsWith("--repo=")) repo = t.slice("--repo=".length)
    else if (t === "--repo") repo = words[++j]?.text ?? ""
    else if (PUSH_VALUE_OPTIONS.test(t) || (subtree && SUBTREE_VALUE_OPTIONS.test(t))) j++
    else if (!t.startsWith("-")) specs.push(t)
  }
  const named = specs.length > 0
  const remote = named ? specs.shift() : repo
  const linked = runs.some((run) => lastPart(run.words[0]?.text) === "ln")
  if (remote !== null && !elsewhere && scratchRemote(remote, vars, env, linked, lineWrites(runs, env))) return false
  // `git push --repo=origin main`: git reads main as the remote, but the line meant the branch.
  const targets = named && repo !== null ? [remote, ...specs] : specs
  return every || targets.some((spec) => writesBranch(spec, branches, vars, env))
}

/**
 * The project's reserved commands from job.json: { rules, errors }. Each entry is
 * { pattern, what } (or a bare pattern string). A pattern is a JS regex anchored at a command
 * position; `{REST}` stands for the rest of the same command. A pattern that doesn't compile
 * is skipped and listed in `errors` (`/job init --check` reports it).
 */
export function projectReserved(config) {
  const rules = []
  const errors = []
  const list = Array.isArray(config?.reserved_commands) ? config.reserved_commands : []
  for (const [i, entry] of list.entries()) {
    const pattern = typeof entry === "string" ? entry : entry?.pattern
    const what = (typeof entry === "object" && entry?.what) || pattern
    if (typeof pattern !== "string" || !pattern.trim()) {
      errors.push(`reserved_commands[${i}]: no pattern`)
      continue
    }
    try {
      rules.push(rule(pattern.replaceAll("{REST}", REST), String(what)))
    } catch (error) {
      errors.push(`reserved_commands[${i}] (${what}): ${error.message}`)
    }
  }
  return { rules, errors }
}

/** job.json for this hook: next to the hook (<repo>/.claude/job.json), else in CLAUDE_PROJECT_DIR. {} if missing or bad. */
export function loadConfig(env) {
  const candidates = []
  try {
    candidates.push(join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "job.json"))
  } catch {
    // Not run from a file; fall back to the project dir.
  }
  if (env.CLAUDE_PROJECT_DIR) candidates.push(join(env.CLAUDE_PROJECT_DIR, ".claude", "job.json"))
  const path = candidates.find((candidate) => existsSync(candidate))
  return path ? readConfig(path) : {}
}

/** A job.json file as an object; {} if it is broken. */
function readConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"))
    return config && typeof config === "object" && !Array.isArray(config) ? config : {}
  } catch {
    return {}
  }
}

/**
 * The git checkout holding `path` (a file or directory, which need not exist yet):
 * { top, main, superproject }, the checkout (a worktree's own root), the repo's main checkout
 * and, for a submodule, the repo it sits in; symlinks resolved; null outside git. git runs only
 * once a `.git` is found above the path, so a scratchpad or notes file costs no process. When git
 * fails there (`safe.directory`, no git, its timeout), it fails closed: the folder holding `.git`
 * is the checkout, a worktree's or submodule's `.git` file names its main repo, and every
 * further folder up that holds a `.git` counts as a superproject (`failed: true`).
 */
export function gitCheckoutOf(path) {
  let dir = null
  for (let current = resolve(String(path)); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      dir = current
      break
    }
    if (dirname(current) === current) return null
  }
  const r = spawnSync(
    "git",
    ["-C", dir, "rev-parse", "--path-format=absolute", "--show-superproject-working-tree", "--show-toplevel", "--git-common-dir"],
    { encoding: "utf8", timeout: 5000 },
  )
  const lines = r.status === 0 ? r.stdout.trim().split("\n") : []
  // The superproject line is there only for a submodule.
  const [superproject, top, common] = lines.length === 3 ? lines : [null, ...lines]
  if (top && common) {
    const main = basename(common) === ".git" ? dirname(common) : top
    return {
      top: resolveTarget(top, "/"),
      main: resolveTarget(main, "/"),
      supers: superproject ? [resolveTarget(superproject, "/")] : [],
    }
  }
  // git failed: read the layout from the files.
  let main = dir
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(dir, ".git"), "utf8"))?.[1]?.trim()
    const owner = gitdir && /^(.*?)\/\.git\/(?:worktrees|modules)\//.exec(resolve(dir, gitdir))?.[1]
    if (owner) main = owner
  } catch {
    // A .git directory: this is the main checkout.
  }
  const supers = []
  for (let up = dirname(dir); up !== dirname(up); up = dirname(up)) {
    if (existsSync(join(up, ".git"))) supers.push(up)
  }
  return { top: resolveTarget(dir, "/"), main: resolveTarget(main, "/"), supers: supers.map((up) => resolveTarget(up, "/")), failed: true }
}

/**
 * The repo set up for jobs that holds `path`: { root, config, configPath, coordinatorCommits },
 * where configPath is the .claude/job.json found in the path's checkout, else in its main
 * checkout (a worktree whose branch lacks one), else in a repo it is a submodule of; root is the
 * checkout (the superproject's, for a submodule). coordinatorCommits is the opt-in from the main
 * checkout's job.json (never from a worktree's branch, never for a submodule). Null outside git
 * or in a repo without job.json.
 */
export function jobRepoAt(path) {
  const checkout = gitCheckoutOf(path)
  if (!checkout) return null
  for (const dir of new Set([checkout.top, checkout.main, ...checkout.supers])) {
    const configPath = join(dir, ".claude", "job.json")
    if (!existsSync(configPath)) continue
    const submodule = checkout.supers.includes(dir)
    const root = submodule ? dir : checkout.top
    const mainConfig = join(checkout.main, ".claude", "job.json")
    const coordinatorCommits = !submodule && existsSync(mainConfig) && coordinatorCommitsOn(readConfig(mainConfig))
    return { root, config: readConfig(configPath), configPath, coordinatorCommits }
  }
  return null
}

// File systems whose stat can hang while the other end is away (the user's Obsidian vault is
// an SSHFS mount on the LXC): the guard never stats paths under them, it judges them by name.
const NETWORK_FS = /^(?:fuse\.sshfs|sshfs|nfs4?|cifs|smb3|smbfs|fuse\.rclone|davfs|9p|afpfs|webdav)$/
let networkMountCache = null

/** Mount points of network file systems, from /proc/self/mounts (JOB_MOUNTS: tests); [] elsewhere. */
export function networkMounts(env = process.env) {
  if (networkMountCache && networkMountCache.file === (env.JOB_MOUNTS || "")) return networkMountCache.points
  let text = ""
  try {
    text = readFileSync(env.JOB_MOUNTS || "/proc/self/mounts", "utf8")
  } catch {
    // macOS has no /proc; its vault is a local iCloud folder.
  }
  const points = []
  for (const line of text.split("\n")) {
    const [, point, type] = line.split(" ")
    if (!point || !NETWORK_FS.test(type ?? "")) continue
    const decoded = point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    if (decoded !== "/") points.push(decoded)
  }
  networkMountCache = { file: env.JOB_MOUNTS || "", points }
  return points
}

/** True for an absolute path on a network mount (judged by name, never stat'ed). */
export function onNetworkMount(path, env = process.env) {
  const absolute = resolve(String(path))
  return networkMounts(env).some((point) => isInside(absolute, point))
}

// Every repo where `/job init` ran on this machine, so a restricted role is held to every job
// repo's reserved commands, also ones that name no path (`aws ecs update-service`, `sam deploy`).
export const JOB_REPOS_FILE = join("job-skill", "repos.json")

/** The machine's job-repo registry: ${XDG_STATE_HOME:-~/.local/state}/job-skill/repos.json. */
export function jobReposPath(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), JOB_REPOS_FILE)
}

/** The registry: { repos: { "<main checkout>": { added } } }; empty when missing or unreadable. */
export function readJobRepos(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"))
    const repos = data && typeof data.repos === "object" && !Array.isArray(data.repos) ? data.repos : {}
    return { repos: { ...repos } }
  } catch {
    return { repos: {} }
  }
}

/** The registered job repos with a job.json: [{ root, config }]. Network-mounted ones are skipped. */
function registeredRepos(env) {
  const out = []
  for (const root of Object.keys(readJobRepos(jobReposPath(env)).repos)) {
    if (!root.startsWith("/") || onNetworkMount(root, env)) continue
    const configPath = join(root, ".claude", "job.json")
    if (existsSync(configPath)) out.push({ root, config: readConfig(configPath) })
  }
  return out
}

/** job.json `coordinator_commits`: the coordinator may edit and commit in this repo. Only a literal true. */
export function coordinatorCommitsOn(config) {
  return config?.coordinator_commits === true
}

/** The env var that carries a job's role, from job.json `role_env`. */
export function roleEnvName(config) {
  const name = config?.role_env
  return typeof name === "string" && /^[A-Za-z_]\w*$/.test(name) ? name : DEFAULT_ROLE_ENV
}

function compile(config, env = process.env) {
  const defaultBranch =
    typeof config?.default_branch === "string" && /^[\w./-]+$/.test(config.default_branch)
      ? config.default_branch
      : ""
  return {
    roleEnv: roleEnvName(config),
    // The project's own rules first, so a block names the project's label when both match.
    reserved: [...projectReserved(config).rules, ...builtinReserved(defaultBranch, env)],
  }
}

// What the coordinator may not run on this repo inside Herdr. Fetch, worktree add/remove,
// status, log, diff, `pull --ff-only`, `merge --ff-only`, PR API calls and deploys stay allowed.
const COORDINATOR_GIT_RULES = [
  gitRule(
    String.raw`${GIT}(?:commit|rebase|cherry-pick|revert|am|apply)${END}`,
    "git commit / rebase / cherry-pick / revert / am / apply",
  ),
  gitRule(String.raw`${GIT}(?:merge|pull)${END}(?!${REST}\s--ff-only\b)`, "git merge / pull without --ff-only"),
]
// A directory change at a command position, with everything up to the end of that command.
const CD = new RegExp(String.raw`${SEP}(?:builtin\s+)?(cd|pushd|popd)(?![\w-])([^;&|\n)]*)`, "g")
const WORDS = new RegExp(WORD, "g")

// One tab per job. A worker may split its own pane (servers, tests, logs) and use
// pane run / read / wait-output / send-keys / rename / close in its tab (see CLOSE), but never
// starts an agent (no job-in-a-job), a tab, a workspace or a worktree.
const WORKER_RULES = [
  rule(
    String.raw`${HERDR}(?:agent\s+start|tab\s+create|workspace\s+create|worktree\s+create)${END}`,
    "starting a Herdr agent, tab, workspace or worktree",
  ),
  // `pane run <pane> claude …` would start a nested agent without `agent start`.
  rule(
    String.raw`${HERDR}pane\s+run\s+${WORD}\s+["']?(?:\w+=\S*\s+)*(?:\S*/)?(?:claude|codex)(?![\w-])`,
    "starting claude or codex in a pane",
  ),
  // The skill's next round of a job (it prompts the job's agent and moves its card), run with or
  // without `node`, by any path; `node --check` only parses. v13: these three rules read the
  // programs a line runs, so an assignment (`F=…/job-close.mjs`), a quoted argument (`node -e
  // 'import("./job-close.mjs")'`: importing a script doesn't run it), a heredoc body or `wc -l $F`
  // is not a run; `node $F` after `F=…/job-close.mjs` is.
  scriptRule(["job-round.mjs"], "starting a job's next round (job-round.mjs)"),
  // v9: the skill's procedures. job-open opens a tab and starts an agent; job-close closes a tab
  // and stops processes; ship merges, deploys and installs (its `plan` only reads). They repeat
  // the coordinator check themselves; this keeps a worker's command from reaching them.
  scriptRule(["job-open.mjs", "job-close.mjs"], "opening or closing a job (job-open.mjs / job-close.mjs)"),
  scriptRule(
    ["ship.mjs"],
    "shipping: merge, release, deploy or install (ship.mjs; its plan is fine)",
    (args) => args.length >= 3 && /^\d+$/.test(args[1].text) && args[2].text === "plan",
    String.raw`(?!\s+\S+\s+\d+\s+plan(?![\w-]))`,
  ),
]
// The job board's CLI (board.mjs, the skill's job-board.mjs, or a variable such as "$BOARD")
// with --option / --suggest: answer buttons, which send text into the coordinator's chat; or
// --allow-wording, which writes a card the board's wording check refused.
const BOARD_BUTTONS = rule(
  String.raw`(?:(?:\S*/)?node\s+)?[^\s;&|]*[Bb][Oo][Aa][Rr][Dd][^\s;&|]*${REST}\s--(?:option|suggest|allow-wording)(?![\w-])`,
  "answer buttons on a board card",
)
// The job board's CLI with `not-run` (v10): it marks a press as not carried out and changes the
// card's question; only the coordinator knows which press couldn't run.
const BOARD_NOT_RUN = rule(String.raw`(?:(?:\S*/)?node\s+)?[^\s;&|]*[Bb][Oo][Aa][Rr][Dd][^\s;&|]*\s+not-run(?![\w-])`, "marking a press as not run on a board card")
// The job board's CLI putting a card in the Queue (v12): `add queue …` or `move <ref> queue`. The
// Queue is what the coordinator starts by itself; the board refuses a worker's queue writes too.
const BOARD_QUEUE = rule(
  String.raw`(?:(?:\S*/)?node\s+)?[^\s;&|]*[Bb][Oo][Aa][Rr][Dd][^\s;&|]*\s+(?:add\s+["']?queue|move\s+\S+\s+["']?queue)(?![\w-])`,
  "putting a card in the board's Queue",
)
// Every `pane split`, with the rest of its command, to check what it splits.
const PANE_SPLIT = new RegExp(String.raw`${CMD}${HERDR}pane\s+split${END}(?<args>[^;&|\n]*)`, "g")
// `pane split` options that take a value.
const SPLIT_VALUE_OPTIONS = new Set(["--pane", "--direction", "--ratio", "--cwd", "--env", "--right-click"])

/** Null when every `pane split` in the command splits the worker's own pane, else what's wrong. */
export function foreignSplit(command, env) {
  const own = (word) => {
    const id = word.replace(/["']/g, "")
    return id === "$HERDR_PANE_ID" || id === "${HERDR_PANE_ID}" || (Boolean(env.HERDR_PANE_ID) && id === env.HERDR_PANE_ID)
  }
  for (const match of command.matchAll(PANE_SPLIT)) {
    const words = match.groups.args.match(WORDS) ?? []
    const targets = []
    let current = false
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word === "--current") current = true
      else if (word.startsWith("--pane=")) targets.push(word.slice("--pane=".length))
      else if (word === "--pane") targets.push(words[++i] ?? "")
      else if (SPLIT_VALUE_OPTIONS.has(word)) i++
      else if (/^\d*(?:>>?|<)$/.test(word)) i++ // a redirect and its file: `> out.json`
      else if (/^\d*[<>]/.test(word) || word.startsWith("-")) continue
      else targets.push(word)
    }
    const other = targets.find((target) => !own(target))
    if (other !== undefined) return `\`herdr pane split\` of pane ${other || "(empty)"}`
    if (!current && targets.length === 0) return "`herdr pane split` without a pane"
  }
  return null
}

// Every `tab close` / `workspace close` / `pane close`, with the rest of its command.
const CLOSE = new RegExp(String.raw`${CMD}${HERDR}(?<kind>tab|workspace|pane)\s+close${END}(?<args>[^;&|\n]*)`, "g")
const HERDR_ID_VAR = /^\$\{?(HERDR_(?:TAB|PANE|WORKSPACE)_ID)\}?$/

/**
 * What each close in a command closes: [{ kind: "tab" | "workspace" | "pane", raw, id }]. `id`
 * is the literal id, with $HERDR_TAB_ID / $HERDR_PANE_ID / $HERDR_WORKSPACE_ID read from env;
 * null when the hook can't tell (another variable, a substitution, no id). `--current` (a pane's
 * own) gives env.HERDR_PANE_ID.
 */
export function closeTargets(command, env) {
  const closes = []
  for (const match of String(command).matchAll(CLOSE)) {
    const words = match.groups.args.match(WORDS) ?? []
    const targets = []
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word === "--current") targets.push(word)
      else if (/^\d*(?:>>?|<)$/.test(word)) i++ // a redirect and its file
      else if (/^\d*[<>]/.test(word) || word.startsWith("-")) continue // --group, 2>&1
      else targets.push(word)
    }
    if (targets.length === 0) targets.push("")
    for (const raw of targets) {
      const word = raw.replace(/^"([^"]*)"$|^'([^']*)'$/, (_, double, single) => double ?? single)
      const variable = HERDR_ID_VAR.exec(word)?.[1]
      let id = null
      if (raw === "--current") id = match.groups.kind === "pane" ? env.HERDR_PANE_ID || null : null
      else if (variable) id = env[variable] || null
      else if (word && !/[$`"'\\(){}*?[\]\s]/.test(word)) id = word
      closes.push({ kind: match.groups.kind, raw: raw || "(no id)", id })
    }
  }
  return closes
}

/** The job-tab registry of the repo at `dir`: <git common dir>/job-tabs.json, or null outside git. */
export function jobTabsPath(dir) {
  if (!dir) return null
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 5000,
  })
  return r.status === 0 && r.stdout.trim() ? join(r.stdout.trim(), JOB_TABS_FILE) : null
}

/** The registry: { tabs: { "<tab id>": { slug, added } } }; empty when missing or unreadable. */
export function readJobTabs(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"))
    const tabs = data && typeof data.tabs === "object" && !Array.isArray(data.tabs) ? data.tabs : {}
    return { tabs: { ...tabs } }
  } catch {
    return { tabs: {} }
  }
}

/** The tab a pane is in, from `herdr pane get`; null when Herdr can't say. */
function paneTabOf(id, env) {
  const r = spawnSync(env.HERDR_BIN_PATH || "herdr", ["pane", "get", id], { encoding: "utf8", env, timeout: 5000 })
  try {
    return r.status === 0 ? JSON.parse(r.stdout).result?.pane?.tab_id || null : null
  } catch {
    return null
  }
}

/** The coordinator's closes inside Herdr: recorded job tabs only. The block message, or null. */
function coordinatorCloseDecision(command, env, input, deps) {
  let recorded
  const jobTabs = () =>
    (recorded ??= new Set(
      deps.jobTabs ? deps.jobTabs() : Object.keys(readJobTabs(jobTabsPath(env.CLAUDE_PROJECT_DIR || input.cwd) ?? "").tabs),
    ))
  for (const { kind, raw, id } of closeTargets(command, env)) {
    if (kind === "pane") continue
    const why =
      kind === "workspace"
        ? "the job skill never opens workspaces, so it doesn't close one"
        : id === null
          ? `the hook can't read the tab id \`${raw}\`; write the recorded id in literally`
          : id === env.HERDR_TAB_ID
            ? `${id} is this chat's own tab`
            : !jobTabs().has(id)
              ? `${id} isn't a job tab recorded for this repo (step 4 records each with job-tabs.mjs add)`
              : null
    if (why) {
      return (
        `Blocked by ${HOOK}: \`herdr ${kind} close ${raw}\`: ${why}. Close only a finished job's tab, ` +
        "by the id `node ~/.claude/skills/job/scripts/job-tabs.mjs get <slug>` prints; the user " +
        "closes any other tab."
      )
    }
  }
  return null
}

/**
 * A Claude profile's config dir, as scripts/claude-coordinator.sh maps it: `work` is ~/.claude,
 * `personal` CLAUDE_PERSONAL_DIR or ~/.claude-personal, any other name ~/.claude-<name>.
 */
export function profileDir(profile, env = process.env) {
  const home = env.HOME || homedir()
  if (profile === "work") return join(home, ".claude")
  if (profile === "personal") return env.CLAUDE_PERSONAL_DIR || join(home, ".claude-personal")
  return join(home, `.claude-${profile}`)
}

/** The coordinator's own account: its CLAUDE_CONFIG_DIR, or ~/.claude when that is unset. */
export function defaultAccountDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude")
}

const sameDir = (a, b) => resolveTarget(a, "/") === resolveTarget(b, "/")

/** A shell word's value with quotes removed and $HOME / $CLAUDE_CONFIG_DIR expanded; null when the hook can't tell. */
function shellValue(word, env) {
  let out = ""
  for (const [, double, single, bare] of String(word).matchAll(/"([^"]*)"|'([^']*)'|([^"']+)/g)) {
    if (single !== undefined) {
      out += single
      continue
    }
    // An unset $CLAUDE_CONFIG_DIR stays as it is (the shell would pass it empty): unreadable.
    const text = (double ?? bare).replace(/\$\{?(HOME|CLAUDE_CONFIG_DIR)\}?(?!\w)/g, (whole, name) =>
      name === "HOME" ? env.HOME || homedir() : env.CLAUDE_CONFIG_DIR || whole,
    )
    if (bare !== undefined && /[~*?[{]/.test(text)) return null
    out += text
  }
  // Left over: another variable, a substitution, an escape, or a quoted `$HOME` (not expanded).
  return /[$`\\]/.test(out) ? null : out
}

// Every `tab create` / `agent start`, with the rest of its command (up to a `$(…)`'s end).
const TAB_CREATE = new RegExp(String.raw`${CMD}${HERDR}tab\s+create${END}(?<args>[^;&|\n)]*)`, "g")
const AGENT_START = new RegExp(String.raw`${CMD}${HERDR}agent\s+start${END}(?<args>[^;&|\n)]*)`, "g")

/** The value of `--name <v>` / `--name=<v>` among the words, or undefined. */
function optionValue(words, name) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--") return undefined
    if (words[i] === name) return words[i + 1] ?? ""
    if (words[i].startsWith(`${name}=`)) return words[i].slice(name.length + 1)
  }
  return undefined
}

/**
 * The processes running in a Herdr pane: [{ pid, name, dir }], `dir` being their
 * CLAUDE_CONFIG_DIR (null when unset), read from each process's environment (HERDR_PANE_ID
 * marks the pane): /proc/<pid>/environ on Linux, `ps -E` on macOS (which shows nothing for a
 * system binary such as /bin/zsh). Only processes whose environment could be read.
 */
export function paneProcesses(paneId, env = process.env) {
  const out = []
  if (existsSync("/proc/self/environ")) {
    let pids = []
    try {
      pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name))
    } catch {
      return out
    }
    for (const pid of pids) {
      try {
        const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
        if (!vars.includes(`HERDR_PANE_ID=${paneId}`)) continue
        const dir = vars.find((v) => v.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length) || null
        out.push({ pid: Number(pid), name: readFileSync(`/proc/${pid}/comm`, "utf8").trim(), dir })
      } catch {
        // Gone, or another user's.
      }
    }
    return out
  }
  const r = spawnSync("ps", ["-axE", "-ww", "-o", "pid=,comm=,command="], { encoding: "utf8", env, timeout: 5000 })
  if (r.status !== 0 || typeof r.stdout !== "string") return out
  for (const line of r.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const words = match[3].split(" ")
    if (!words.includes(`HERDR_PANE_ID=${paneId}`)) continue
    const dir = words.find((w) => w.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length) || null
    out.push({ pid: Number(match[1]), name: basename(match[2]).replace(/^-/, ""), dir })
  }
  return out
}

/** The account flag for a session: ${TMPDIR:-/tmp}/job-inline-account-<id>, or null. */
export function accountFlagPath(sessionId, env) {
  return sessionId ? inlineFlagPath(`account-${sessionId}`, env) : null
}

const PROFILE = /^[a-z0-9][a-z0-9_-]*$/

/** The profile the user's `account:` override names for this session, or null. */
function accountOverride(sessionId, env) {
  const path = accountFlagPath(sessionId, env)
  try {
    const profile = path ? readFileSync(path, "utf8").trim() : ""
    return PROFILE.test(profile) ? profile : null
  } catch {
    return null
  }
}

/** The coordinator's tab creates and Claude agent starts on another account. The block message, or null. */
function accountDecision(command, env, input, deps) {
  if (!/\b(?:tab|agent)\b/.test(command)) return null
  const override = deps.accountOverride ? deps.accountOverride(input.session_id) : accountOverride(input.session_id, env)
  const want = override ? profileDir(override, env) : defaultAccountDir(env)
  const which = override ? `the \`${override}\` account the user asked for (${want})` : `this coordinator's account (${want})`
  const lift =
    "Jobs run on the coordinator's default account. Another account only when the user asks in " +
    "their own message: they start it with `account: <profile>` (e.g. `account: work`), which lasts one " +
    "turn. Never create that override yourself."
  const block = (what, why) => `Blocked by ${HOOK}: \`herdr ${what}\`: ${why}. Jobs here start on ${which}. ${lift}`
  for (const match of command.matchAll(TAB_CREATE)) {
    const words = match.groups.args.match(WORDS) ?? []
    let raw
    for (let i = 0; i < words.length; i++) {
      const word = words[i] === "--env" ? words[++i] ?? "" : words[i].startsWith("--env=") ? words[i].slice(6) : null
      if (word !== null && /^["']?CLAUDE_CONFIG_DIR=/.test(word)) raw = word.replace(/^(["']?)CLAUDE_CONFIG_DIR=/, "$1")
    }
    const fix = `pass \`--env CLAUDE_CONFIG_DIR=${want}\``
    if (raw === undefined) {
      if (sameDir(want, join(env.HOME || homedir(), ".claude"))) continue
      return block("tab create", `it has no \`--env CLAUDE_CONFIG_DIR=…\`, so the tab would use the shell's account; ${fix}`)
    }
    const dir = shellValue(raw, env)
    if (!dir) return block("tab create", `the hook can't read \`CLAUDE_CONFIG_DIR=${raw}\`; ${fix} literally`)
    if (!sameDir(dir, want)) return block("tab create", `\`CLAUDE_CONFIG_DIR=${dir}\` is another account; ${fix}`)
  }
  for (const match of command.matchAll(AGENT_START)) {
    const words = match.groups.args.match(WORDS) ?? []
    const kind = shellValue(optionValue(words, "--kind") ?? "", env)
    if (kind !== "claude") continue
    const raw = optionValue(words, "--pane") ?? ""
    const pane = shellValue(raw, env)
    if (!pane || !/^[\w:.-]+$/.test(pane)) {
      return block("agent start", `the hook can't read the pane id \`${raw || "(none)"}\`; write the id \`tab create\` printed literally`)
    }
    const procs = deps.paneProcesses ? deps.paneProcesses(pane) : paneProcesses(pane, env)
    // None readable (macOS hides a system shell's environment): the check after the start
    // (job-account.mjs check) reads the agent's own process.
    const other = procs.find((proc) => !sameDir(proc.dir || join(env.HOME || homedir(), ".claude"), want))
    if (other) {
      return block(
        "agent start",
        `pane ${pane} runs on ${other.dir || "~/.claude"} (${other.name}, pid ${other.pid}); close that tab and open one with \`--env CLAUDE_CONFIG_DIR=${want}\``,
      )
    }
  }
  return null
}

/** A worker's or subagent's closes: its own pane, or (a worker) a pane in its own tab. */
function restrictedCloseDecision(command, env, worker, who, deps) {
  for (const { kind, raw, id } of closeTargets(command, env)) {
    if (kind !== "pane") {
      return (
        `Blocked by ${HOOK}: \`herdr ${kind} close\` is the coordinator's, and this is ${who}. ` +
        "The coordinator closes a job's tab when the job is over; say in your report if yours can go."
      )
    }
    if (id !== null && id === env.HERDR_PANE_ID) continue
    const paneTab = deps.paneTab ?? ((pane) => paneTabOf(pane, env))
    if (worker && id !== null && env.HERDR_TAB_ID && paneTab(id) === env.HERDR_TAB_ID) continue
    return (
      `Blocked by ${HOOK}: \`herdr pane close ${raw}\`, and this is ${who}. ` +
      (worker
        ? "A worker closes only its own pane or a pane it split in its own job tab, by its literal id."
        : "A subagent closes only its own pane.")
    )
  }
  return null
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const FLAG_PREFIX = "job-inline-"
// The files a Codex patch touches (its `*** Move to:` target too).
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
// apply_patch run through the shell (`apply_patch <<'EOF'`) at a command position.
const APPLY_PATCH = new RegExp(String.raw`${SEP}apply_patch(?![\w-])`)

/** Every file path in a Codex apply_patch body. */
export function patchPaths(patch) {
  return [...String(patch ?? "").matchAll(PATCH_FILE)].map((match) => match[1].trim()).filter(Boolean)
}

/** The files an edit writes: Claude's Edit / Write / MultiEdit / NotebookEdit, or a Codex apply_patch. */
export function editPaths(tool, toolInput, command = "") {
  if (EDIT_TOOLS.has(tool)) {
    const path = toolInput.file_path ?? toolInput.notebook_path
    return typeof path === "string" && path ? [path] : []
  }
  if (tool === "apply_patch") return patchPaths(toolInput.command ?? toolInput.patch ?? toolInput.input)
  if (tool === "Bash" && APPLY_PATCH.test(command)) return patchPaths(command)
  return []
}

/** The `here:` flag file for a session, or null without a usable session id. */
export function inlineFlagPath(sessionId, env) {
  const id = String(sessionId ?? "").replace(/[^\w.-]/g, "_")
  if (!id) return null
  return join(env.TMPDIR || "/tmp", FLAG_PREFIX + id)
}

/** Absolute, symlink-resolved path. A file that doesn't exist yet resolves through its nearest existing parent. */
export function resolveTarget(path, cwd) {
  const absolute = resolve(cwd || process.cwd(), String(path).replace(/^~(?=$|\/)/, homedir()))
  const tail = []
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...tail.reverse())
    } catch {
      if (dirname(current) === current) return absolute
      tail.push(basename(current))
    }
  }
}

/** The main checkout and every git worktree of the repo at `dir`, symlinks resolved; [] if git fails. */
export function gitWorktreeRoots(dir) {
  if (!dir) return []
  const r = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5000 })
  if (r.status !== 0 || typeof r.stdout !== "string") return []
  return r.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolveTarget(line.slice("worktree ".length), "/"))
}

const isInside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** A shell word as a literal path, or null when the shell would expand it (`$X`, globs, `~user`). */
function literalPath(word, env) {
  if (!word || /[$`*?[{\\]/.test(word)) return null
  const path = word.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single)
  if (path === "~" || path.startsWith("~/")) return (env.HOME || homedir()) + path.slice(1)
  return path && !path.startsWith("~") && path !== "-" ? path : null
}

/**
 * The directories one matched git command acts on, as { dirs }, or { unknown: reason }.
 * Starts at the session's cwd, follows each `cd <dir>` before it in the same command, then
 * `git -C <dir>` (cumulative); `--git-dir` / `--work-tree` count too.
 */
export function gitTargets(command, match, cwd, env) {
  if (/\bGIT_(?:DIR|WORK_TREE)\b/.test(command)) return { unknown: "GIT_DIR / GIT_WORK_TREE is set" }
  let dir = typeof cwd === "string" && cwd.startsWith("/") ? cwd : null
  const move = (word, what) => {
    const path = literalPath(word, env)
    if (path === null) return `\`${what}\` is not a plain path`
    if (!path.startsWith("/") && !dir) return "the hook input has no cwd"
    dir = resolve(dir ?? "/", path)
    return null
  }

  const before = command.slice(0, match.index)
  const cds = [...before.matchAll(CD)]
  // `(cd /other); git commit` runs the commit back in the original directory.
  if (cds.length && /[)`]/.test(before.slice(cds[0].index))) {
    return { unknown: "a `cd` inside a subshell or command substitution" }
  }
  for (const [, verb, args] of cds) {
    const words = args.trim() ? args.trim().match(WORDS) ?? [] : []
    if (verb !== "cd") return { unknown: `\`${verb}\`` }
    if (words.length === 0) dir = env.HOME || homedir()
    else if (words.length > 1) return { unknown: `\`cd ${args.trim()}\` is not a plain path` }
    else {
      const why = move(words[0], `cd ${words[0]}`)
      if (why) return { unknown: why }
    }
  }

  const options = (match.groups?.opts ?? "").match(WORDS) ?? []
  const extra = []
  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    if (option === "-C") {
      const why = move(options[++i] ?? "", `git -C ${options[i] ?? ""}`)
      if (why) return { unknown: why }
    } else if (option === "-c") i++
    else if (option === "--git-dir" || option === "--work-tree") extra.push(options[++i] ?? "")
    else if (/^--(?:git-dir|work-tree)=/.test(option)) extra.push(option.slice(option.indexOf("=") + 1))
  }
  if (!dir) return { unknown: "the hook input has no cwd" }
  const dirs = [dir]
  for (const word of extra) {
    const path = literalPath(word, env)
    if (path === null) return { unknown: `\`${word}\` is not a plain path` }
    dirs.push(resolve(dir, path))
  }
  return { dirs }
}

// A program named by its path at a command position: `/root/app/ship.sh`, `bash ~/app/x.sh`.
const PROGRAM = new RegExp(String.raw`${CMD}(?<program>${WORD})`, "g")
const GIT_AT = new RegExp(CMD + GIT, "g")

/**
 * The directories a command reaches, for the reserved commands of their repos: the session's
 * cwd, each plain `cd <dir>` / `pushd <dir>` (in order), each `git -C <dir>` and the folder of
 * each program run by a path (`/abs/x.sh`, `~/x.sh`, `../app/x.sh`; a relative one from the
 * directory it runs in). No file system access. Best effort: a word the shell would expand is
 * skipped, and so is `popd`.
 */
export function commandDirs(command, cwd, env) {
  const start = typeof cwd === "string" && cwd.startsWith("/") ? cwd : null
  const dirs = start ? [start] : []
  const at = (word, base) => {
    const path = literalPath(word, env)
    if (path === null || (!path.startsWith("/") && !base)) return null
    return resolve(base ?? "/", path)
  }
  // Where the shell is after each cd / pushd, by position in the command.
  const moves = []
  let dir = start
  for (const match of command.matchAll(CD)) {
    const [, verb, args] = match
    const words = args.trim().match(WORDS) ?? []
    const next = verb !== "popd" && words.length === 1 ? at(words[0], dir) : null
    if (next) dirs.push((dir = next))
    moves.push({ index: match.index, dir })
  }
  const dirAt = (index) => moves.filter((move) => move.index < index).at(-1)?.dir ?? start
  for (const match of command.matchAll(GIT_AT)) {
    const options = (match.groups?.opts ?? "").match(WORDS) ?? []
    let base = dirAt(match.index)
    for (let i = 0; i < options.length; i++) {
      if (options[i] !== "-C") continue
      const next = at(options[++i] ?? "", base)
      if (next) dirs.push((base = next))
    }
  }
  for (const match of command.matchAll(PROGRAM)) {
    const word = match.groups.program
    if (!word.includes("/")) continue
    const path = at(word, dirAt(match.index))
    if (path) dirs.push(dirname(path))
  }
  return [...new Set(dirs)]
}

/**
 * The reserved rules of the other job repos a command is held to, each rule's label naming its
 * repo: every job repo it reaches (see commandDirs), with its default branch, and every repo in
 * the machine's registry (job-init adds each repo it sets up), whose reserved_commands apply
 * wherever the command runs: `aws ecs update-service` names no repo. The hook's own project is
 * left out (its rules are already in force), and network mounts are never stat'ed.
 */
function otherReserved(command, cwd, env, deps) {
  const own = env.CLAUDE_PROJECT_DIR && !onNetworkMount(env.CLAUDE_PROJECT_DIR, env) ? resolveTarget(env.CLAUDE_PROJECT_DIR, "/") : null
  const seen = new Set()
  const rules = []
  const add = (repo, list) => {
    if (seen.has(repo.root)) return
    seen.add(repo.root)
    for (const { re, what } of list) rules.push({ re, what: `${what} (in ${repo.root})` })
  }
  for (const dir of commandDirs(command, cwd, env)) {
    if (onNetworkMount(dir, env)) continue
    const resolved = resolveTarget(dir, "/")
    if (own && isInside(resolved, own)) continue
    const repo = deps.jobRepoAt(resolved)
    if (repo) add(repo, compile(repo.config, env).reserved)
  }
  for (const repo of deps.jobRepos ? deps.jobRepos() : registeredRepos(env)) {
    if (own && isInside(repo.root, own)) continue
    add(repo, projectReserved(repo.config).rules)
  }
  return rules
}

/** `fn` remembered per argument, for the length of one hook call. */
function memo(fn) {
  const cache = new Map()
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key))
    return cache.get(key)
  }
}

const COORDINATOR_HINT =
  "This chat is the coordinator, so repo changes go to a job: /job <task>. If the user wants " +
  "it done in this chat, they start their message with `here:` (it lasts one turn). Never " +
  "create that override yourself."

function coordinatorDecision(input, env, deps, config) {
  const tool = input.tool_name
  const tool_input = input.tool_input ?? {}
  const command = tool === "Bash" ? String(tool_input.command ?? "") : ""
  const edits = editPaths(tool, tool_input, command)

  // Checked before the override, so the override can't be used to extend itself.
  if (command.includes(FLAG_PREFIX) || edits.some((path) => path.includes(FLAG_PREFIX))) {
    return (
      `Blocked by ${HOOK}: only the user can turn on the \`here:\` override, ` +
      `by starting their message with \`here:\`. Do not create, read or remove the ${FLAG_PREFIX}* flag.`
    )
  }
  const inlineActive = deps.inlineActive ?? ((id) => existsSync(inlineFlagPath(id, env) ?? ""))
  if (inlineActive(input.session_id)) return null

  // If git can't list the worktrees, the project dir itself is still the repo.
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd
  let roots
  const repoRoots = () =>
    (roots ??= deps.repoRoots
      ? deps.repoRoots()
      : (() => {
          const listed = gitWorktreeRoots(projectDir)
          return listed.length || !projectDir ? listed : [resolveTarget(projectDir, "/")]
        })())

  // A path is guarded inside this repo's trees, or inside any other repo set up for jobs,
  // unless that repo's job.json opts in (coordinator_commits) and this is the coordinator itself.
  const jobRepo = deps.jobRepoAt ?? jobRepoAt
  const mayOptIn = !input.agent_type
  // `path` is absolute. One on a network mount is judged by name only: a stat there can hang.
  const guardedRepo = (path) => {
    const network = onNetworkMount(path, env)
    const target = network ? resolve(path) : resolveTarget(path, "/")
    const own = repoRoots().find((r) => isInside(target, r))
    if (own) return mayOptIn && coordinatorCommitsOn(config) ? null : { target, repo: `the repo checkout ${own}` }
    const other = network ? null : jobRepo(target)
    if (!other || (mayOptIn && (other.coordinatorCommits ?? coordinatorCommitsOn(other.config)))) return null
    return { target, repo: `the repo checkout ${other.root}, a job repo (it has .claude/job.json)` }
  }

  if (tool === "Bash") {
    for (const { all, what } of COORDINATOR_GIT_RULES) {
      for (const match of command.matchAll(all)) {
        const target = gitTargets(command, match, input.cwd, env)
        if (target.unknown) {
          return (
            `Blocked by ${HOOK}: ${what}, and the hook can't tell which repo ` +
            `it acts on (${target.unknown}). ${COORDINATOR_HINT} If it is a repo without ` +
            ".claude/job.json, run it as `git -C /abs/path …` or `cd /abs/path && git …`."
          )
        }
        for (const dir of target.dirs) {
          const hit = guardedRepo(dir)
          if (hit) return `Blocked by ${HOOK}: ${what} in ${hit.target}, which is inside ${hit.repo}. ${COORDINATOR_HINT}`
        }
      }
    }
  }
  for (const path of edits) {
    const absolute = resolve(input.cwd || process.cwd(), String(path).replace(/^~(?=$|\/)/, homedir()))
    const hit = guardedRepo(absolute)
    if (hit) {
      return (
        `Blocked by ${HOOK}: ${tool === "Bash" ? "apply_patch" : tool} of ${hit.target}, which is inside ` +
        `${hit.repo}. ${COORDINATOR_HINT} Files outside job repos (scratchpad, memory, notes) are fine.`
      )
    }
  }
  return null
}

const isJobSkill = (name) => {
  const skill = String(name ?? "").trim().replace(/^\//, "").toLowerCase()
  return skill === "job" || /[:/]job$/.test(skill)
}
// A Codex prompt that invokes the skill: `$job …` anywhere, or `/job …` at the start.
const JOB_PROMPT = /(?:^|\s)\$job(?![\w-])|^\s*\/job(?![\w-])/i

const noJobsFor = (who) =>
  `and this is ${who}. Workers never start jobs, tabs or agents. Do the work yourself, or ` +
  `put what you need in your job report under needs_user. You may split your own pane for ` +
  "a server, tests or logs: `herdr pane split --current …`."

/**
 * Returns the block message for a tool call, or null to let it through.
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>, agent_type?: string, session_id?: string, cwd?: string}} input
 * @param {Record<string, string | undefined>} env
 * @param {{accountOverride?: (sessionId?: string) => string | null, paneProcesses?: (paneId: string) => {pid: number, name: string, dir: string | null}[], config?: object, repoRoots?: () => string[], jobRepoAt?: (path: string) => {root: string, config: object, coordinatorCommits?: boolean} | null, jobRepos?: () => {root: string, config: object}[], inlineActive?: (sessionId?: string) => boolean, jobTabs?: () => string[], paneTab?: (paneId: string) => string | null}} [deps]
 *   Test seams. By default the config comes from job.json, the roots from `git worktree list`,
 *   another job repo from jobRepoAt (the .claude/job.json of the checkout holding a path), the
 *   machine's job repos from the registry (jobReposPath),
 *   the override from the flag file, the recorded job tabs from <git common dir>/job-tabs.json
 *   a pane's tab from `herdr pane get`, the `account:` override from its flag file and a pane's
 *   processes (with their CLAUDE_CONFIG_DIR) from paneProcesses.
 */
export function decide(input, env, deps = {}) {
  if (!input || typeof input !== "object" || typeof input.tool_name !== "string") return null
  // One git lookup per path for the whole call.
  deps = { ...deps, jobRepoAt: memo(deps.jobRepoAt ?? jobRepoAt) }
  const config = deps.config ?? loadConfig(env)
  const { roleEnv, reserved } = compile(config, env)
  const role = String(env[roleEnv] ?? "").trim()
  if (role === "deployer") return null
  const subagent = input.agent_type ? String(input.agent_type) : ""
  const coordinator = role === "" || role === "coordinator"

  if (coordinator && env.HERDR_ENV === "1") {
    // Before the `here:` override, which is about repo changes, not tabs or accounts.
    if (!subagent && input.tool_name === "Bash") {
      const command = String(input.tool_input?.command ?? "")
      const close = coordinatorCloseDecision(command, env, input, deps) ?? accountDecision(command, env, input, deps)
      if (close) return close
    }
    const message = coordinatorDecision(input, env, deps, config)
    if (message) return message
  }

  const restricted = Boolean(subagent) || !coordinator
  if (!restricted) return null
  const who = subagent ? `subagent "${subagent}"` : `${roleEnv}=${role}`
  const noJobs = noJobsFor(who)

  if (input.tool_name === "Skill" && isJobSkill(input.tool_input?.skill)) {
    return `Blocked by ${HOOK}: the job skill is the coordinator's, ${noJobs}`
  }
  if (input.tool_name !== "Bash") return null
  const command = String(input.tool_input?.command ?? "")
  const workerHit = WORKER_RULES.find((r) => r.re.test(command, env))
  if (workerHit) {
    return `Blocked by ${HOOK}: ${workerHit.what} is the coordinator's job, ${noJobs}`
  }
  if (BOARD_BUTTONS.re.test(command)) {
    return (
      `Blocked by ${HOOK}: only the coordinator adds answer buttons to board cards ` +
      `(--option / --suggest) or writes past the wording check (--allow-wording), and this is ${who}. Put the question in your job report under ` +
      "needs_user; the coordinator turns it into a card."
    )
  }
  if (BOARD_QUEUE.re.test(command)) {
    return `Blocked by ${HOOK}: only the user queues cards (the board's Queue is what the coordinator starts by itself), and this is ${who}. Say in your job report what should be started next.`
  }
  if (BOARD_NOT_RUN.re.test(command)) {
    return `Blocked by ${HOOK}: only the coordinator marks a press it couldn't run (not-run), and this is ${who}. Say in your job report what you couldn't do.`
  }
  const close = restrictedCloseDecision(command, env, !coordinator, who, deps)
  if (close) return close
  const split = foreignSplit(command, env)
  if (split) {
    return (
      `Blocked by ${HOOK}: ${split}, and this is ${who}. A worker may ` +
      "only split its own pane, in its own job tab: use `herdr pane split --current …`."
    )
  }
  const hit = reserved.find((r) => r.re.test(command)) ?? otherReserved(command, input.cwd, env, deps).find((r) => r.re.test(command))
  if (!hit) return null
  return (
    `Blocked by ${HOOK}: ${hit.what} is reserved for the deployer, ` +
    `and this is ${who}. Do not work around it. Put it in your job report under ` +
    `needs_user, or ask the coordinator.`
  )
}

/**
 * UserPromptSubmit: `here:` sets the session's override flag, `account: <profile>` its account
 * flag (holding the profile); any other prompt clears both.
 */
export function onPrompt(input, env) {
  const path = inlineFlagPath(input?.session_id, env)
  if (!path) return
  const prompt = String(input.prompt ?? "")
  if (/^\s*here:/i.test(prompt)) writeFileSync(path, `${new Date().toISOString()}\n`)
  else rmSync(path, { force: true })
  const account = accountFlagPath(input.session_id, env)
  const profile = /^\s*account:\s*([a-z0-9][a-z0-9_-]*)(?![\w-])/i.exec(prompt)?.[1]?.toLowerCase()
  if (profile) writeFileSync(account, `${profile}\n`)
  else rmSync(account, { force: true })
}

/**
 * Codex has no Skill tool: a skill is invoked from the prompt (`$job …`). So for a Codex worker,
 * a prompt that names the job skill is blocked. Returns the block message, or null.
 * @param {{config?: object}} [deps]
 */
export function promptDecision(input, env, deps = {}) {
  if (!JOB_PROMPT.test(String(input?.prompt ?? ""))) return null
  const roleEnv = roleEnvName(deps.config ?? loadConfig(env))
  const role = String(env[roleEnv] ?? "").trim()
  if (role === "" || role === "coordinator" || role === "deployer") return null
  return `Blocked by ${HOOK}: the job skill is the coordinator's, ${noJobsFor(`${roleEnv}=${role}`)}`
}

/** What Codex reads from a hook's stdout: a PreToolUse deny, or a UserPromptSubmit block. */
export function codexOutput(event, message) {
  if (event === "UserPromptSubmit") return { decision: "block", reason: message }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } }
}

function main(argv = process.argv.slice(2)) {
  const codex = argv.includes("--codex")
  let input
  try {
    input = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    process.exit(0)
  }
  const event = input?.hook_event_name
  let message = null
  if (event === "UserPromptSubmit") {
    try {
      onPrompt(input, process.env)
      // Claude blocks the skill at its Skill tool call instead.
      if (codex) message = promptDecision(input, process.env)
    } catch {
      // Never block or comment on the user's prompt because of an error here.
    }
  } else {
    try {
      message = decide(input, process.env)
    } catch {
      // Anything unexpected lets the call through.
    }
  }
  if (!message) process.exit(0)
  if (codex) {
    process.stdout.write(`${JSON.stringify(codexOutput(event, message))}\n`)
    process.exit(0)
  }
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

// Node resolves the main module through symlinks but argv[1] keeps the path as given, so
// compare real paths: a project under a symlinked directory (macOS /tmp -> /private/tmp)
// must not silently skip the guard.
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) main()
