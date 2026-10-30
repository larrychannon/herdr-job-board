#!/usr/bin/env node
// job-guard v12
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
//     a real run counts, and only `--dry-run` as its own argument). They come from this repo's
//     job.json, from the job.json of every repo the
//     command reaches (its cwd, `cd` / `pushd <dir>`, `git -C <dir>`, a script run by a path such
//     as `/root/app/ship.sh` or `../app/ship.sh`), and from every repo in the machine's job-repo
//     registry (${XDG_STATE_HOME:-~/.local/state}/job-skill/repos.json, which `/job init` fills),
//     wherever the command runs: `aws ecs update-service` names no repo. So a home coordinator's
//     subagent can't run any job repo's deploy commands either. Nor may they start jobs, tabs or agents (`herdr agent start`,
//     `herdr tab create`, `claude` via `herdr pane run`, the skill's `job-round.mjs`, v9:
//     `job-open.mjs`, `job-close.mjs` and `ship.mjs` (but `ship.mjs <repo> <card> plan`), …, or the
//     `job` skill). Each job has its
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
// This matches command text, so it is a guardrail against mistakes, not a security
// boundary: `bash -c '…'`, `eval`, aliases, `sed -i` or a renamed copy of a script get
// around it. Every Bash rule is anchored to a command position, so text that merely
// mentions a command (a grep, a commit message, an echo) is not blocked. A heredoc line
// that starts with a blocked command is at a command position, though, so write such
// text with the Write tool instead of `cat <<EOF`. bb-merge.mjs is the exception (v11): its
// rule reads the shell words, so a heredoc body or a multi-line quoted message never counts.
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
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const VERSION = 12
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
function builtinReserved(defaultBranch) {
  const branches = [...new Set(["main", "master", defaultBranch].filter(Boolean))]
  const label = defaultBranch || "main"
  return [
    rule(
      String.raw`git\b${REST}\bpush\b${REST}(?:[\s:+'"](?:refs/heads/)?(?:${branches.map(escapeRe).join("|")})(?![\w/.-])|\s--(?:all|mirror)\b)`,
      `pushing to ${label}`,
    ),
    rule(String.raw`gh\s+pr\s+merge\b`, "merging a PR (gh pr merge)"),
    rule(String.raw`glab\s+mr\s+merge\b`, "merging a merge request (glab mr merge)"),
    rule(
      String.raw`(?:curl|wget|https?|xh|gh\s+api)\b${REST}\b(?:pulls|pullrequests|merge_requests)/\d+/merge\b`,
      "merging a PR through the API",
    ),
    // The skill's Bitbucket merge (it also commits the build stamp on the default branch). v11:
    // read from the shell words, so only a real run counts (see bbMergeRun).
    { re: { test: bbMergeRun }, what: "merging a Bitbucket PR (bb-merge.mjs; its --dry-run is fine)" },
  ]
}

// ---- bb-merge.mjs: real runs only (v11) --------------------------------------------------------

/**
 * The simple commands of a shell command line, each as its words after quote removal
 * ({ text, glob }), as the shell would run them: comments, redirect targets and heredoc bodies
 * left out; the commands inside $( ), backticks, <( ) and an unquoted heredoc's $( ) included.
 * Throws on an unterminated quote or $( (the shell would refuse the line).
 */
export function shellCommands(src, heredocBody = false) {
  const commands = []
  const pending = [] // heredocs that start after the next newline: { delim, strip, quoted }
  let i = 0
  const OPS = " \t\n;&|()<>"

  // Commands until `end` (")" or "`"), or to the end of the text.
  function list(end) {
    let words = []
    let target = false // the next word is a redirect target
    const finish = () => {
      if (words.length) commands.push(words)
      words = []
    }
    while (i < src.length) {
      const c = src[i]
      if (end && c === end) {
        i++
        return finish()
      }
      if (c === "\n") {
        i++
        finish()
        heredocs()
      } else if (c === " " || c === "\t") i++
      else if (c === "\\" && src[i + 1] === "\n") i += 2
      else if (c === "#") while (i < src.length && src[i] !== "\n") i++
      else if (c === "&" && src[i + 1] === ">") {
        i += src[i + 2] === ">" ? 3 : 2
        target = true
      } else if (";&|".includes(c)) {
        while (i < src.length && ";&|".includes(src[i])) i++
        finish()
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
        if (words.length && words.at(-1).end === i - op.length && /^\d+$/.test(words.at(-1).text)) words.pop()
        if (op === "<<" || op === "<<-") {
          while (src[i] === " " || src[i] === "\t") i++
          const delim = word()
          pending.push({ delim: delim.text, strip: op === "<<-", quoted: delim.quoted })
        } else target = true
      } else {
        const w = word()
        if (target) target = false
        else words.push(w)
      }
    }
    if (end) throw new Error(`unterminated ${end === ")" ? "$( or (" : "`"}`)
    finish()
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
      i = close < 0 ? src.length : close + 1
    } else i++
    return src.slice(start, i)
  }

  // The heredoc bodies that start here, up to each delimiter line (or the end of the text).
  function heredocs() {
    for (const { delim, strip, quoted } of pending.splice(0)) {
      let body = ""
      while (i < src.length) {
        const nl = src.indexOf("\n", i)
        const line = src.slice(i, nl < 0 ? src.length : nl)
        i = nl < 0 ? src.length : nl + 1
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break
        body += line + "\n"
      }
      if (!quoted) commands.push(...shellCommands(body, true))
    }
  }

  if (heredocBody) dquoted(null)
  else list(null)
  return commands
}

// Runners that come before the real command, and their options that take a value.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const PREFIXES = new Set(["exec", "nohup", "time", "setsid", "caffeinate", "source", ".", "command", "builtin", "nice", "env", "sudo", "timeout", "xargs", "stdbuf"])
const VALUE_OPTIONS = {
  sudo: /^-[ugCDhprtUT]$/,
  env: /^-[uCS]$/,
  nice: /^-n$/,
  timeout: /^-[ks]$/,
  xargs: /^-[adEILnPs]$/,
  stdbuf: /^-[ioe]$/,
}
const NODE_EVAL = /^(?:-e|-p|-pe|--eval|--print)$/
const NODE_VALUE = /^(?:-r|-C|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--conditions|--input-type|--title|--redirect-warnings|--diagnostic-dir)$/
const NODE_NO_RUN = /^(?:-c|--check|--test|-v|--version|-h|--help)$/

/** True when `name` (a path's last part, a glob allowed) names bb-merge.mjs. */
function namesBbMerge({ text, glob }) {
  const base = text.slice(text.lastIndexOf("/") + 1)
  if (base === "bb-merge.mjs") return true
  if (!glob) return false
  const re = base.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  try {
    return new RegExp(`^${re}$`).test("bb-merge.mjs")
  } catch {
    return true
  }
}

/** For one simple command: "run" (bb-merge.mjs without --dry-run), "dry", or null. */
function bbMergeCommand(words) {
  let k = 0
  for (;;) {
    while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k].text)) k++
    const name = words[k]?.text.split("/").pop()
    if (name === "uv" && words[k + 1]?.text === "run") k++
    else if (SHELLS.has(name)) {
      k++
      while (words[k]?.text.startsWith("-")) {
        const opt = words[k++].text
        if (/^-[a-z]*c[a-z]*$/.test(opt)) return bbMergeRun(words[k]?.text ?? "") ? "run" : null
        if (/^-[a-z]*n[a-z]*$/.test(opt)) return null
      }
      continue
    } else if (!PREFIXES.has(name)) break
    k++
    // The runner's options (and a value after one that takes it), then timeout's duration.
    while (words[k]?.text.startsWith("-") || (name === "nice" && /^-?\d+$/.test(words[k]?.text))) {
      const opt = words[k++].text
      if (opt === "--") break
      if (VALUE_OPTIONS[name]?.test(opt)) k++
    }
    if (name === "timeout" && /^\d/.test(words[k]?.text ?? "")) k++
  }
  if (["node", "nodejs"].includes(words[k]?.text.split("/").pop())) {
    k++
    while (words[k]?.text.startsWith("-")) {
      const opt = words[k++].text
      if (NODE_NO_RUN.test(opt)) return null
      if (NODE_EVAL.test(opt)) return /bb-merge\.m/.test(words[k]?.text ?? "") ? "run" : null
      if (NODE_VALUE.test(opt) && /bb-merge\.m/.test(words[k++]?.text ?? "")) return "run"
      if (/^--[\w-]+=/.test(opt) && /bb-merge\.m/.test(opt)) return "run"
    }
  }
  if (!words[k] || !namesBbMerge(words[k])) return null
  return words.slice(k + 1).some((w) => w.text === "--dry-run") ? "dry" : "run"
}

/**
 * True when a command line runs the skill's bb-merge.mjs for real: with or without `node`, by
 * any path, through runners (`timeout`, `env`, `sudo`, `xargs`, `bash -c`, …), in $( ) or a
 * subshell, but not with `--dry-run` among its own arguments (`--dry-run` in a comment, a
 * redirect, another argument's quotes or another command doesn't count). Text that only
 * mentions it (a quoted commit message, a heredoc body, a grep) isn't a run. A line the reader
 * can't follow (an unterminated quote) is judged by a plain pattern instead.
 */
export function bbMergeRun(command) {
  let commands
  try {
    commands = shellCommands(String(command))
  } catch {
    return new RegExp(
      CMD + String.raw`(?:(?:\S*/)?node(?:\s+-(?!c\b|-check\b)[\w-]+(?:[=\s][^\s;&|]+)?)*\s+)?(?:[^\s;&|]*/)?bb-merge\.m[\w*?]*(?![\w.-])(?![^;&|\n#<>]*?\s--dry-run(?![\w-]))`,
    ).test(command)
  }
  return commands.some((words) => bbMergeCommand(words) === "run")
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

function compile(config) {
  const defaultBranch =
    typeof config?.default_branch === "string" && /^[\w./-]+$/.test(config.default_branch)
      ? config.default_branch
      : ""
  return {
    roleEnv: roleEnvName(config),
    // The project's own rules first, so a block names the project's label when both match.
    reserved: [...projectReserved(config).rules, ...builtinReserved(defaultBranch)],
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
  // without `node`, by any path; `node --check` only parses.
  rule(
    String.raw`(?:(?:\S*/)?node(?:\s+-(?!c\b|-check\b)[\w-]+(?:[=\s][^\s;&|]+)?)*\s+)?(?:[^\s;&|]*/)?job-round\.mjs(?![\w.-])`,
    "starting a job's next round (job-round.mjs)",
  ),
  // v9: the skill's procedures. job-open opens a tab and starts an agent; job-close closes a tab
  // and stops processes; ship merges, deploys and installs (its `plan` only reads). They repeat
  // the coordinator check themselves; this keeps a worker's command from reaching them.
  rule(
    String.raw`(?:(?:\S*/)?node(?:\s+-(?!c\b|-check\b)[\w-]+(?:[=\s][^\s;&|]+)?)*\s+)?(?:[^\s;&|]*/)?job-(?:open|close)\.mjs(?![\w.-])`,
    "opening or closing a job (job-open.mjs / job-close.mjs)",
  ),
  rule(
    String.raw`(?:(?:\S*/)?node(?:\s+-(?!c\b|-check\b)[\w-]+(?:[=\s][^\s;&|]+)?)*\s+)?(?:[^\s;&|]*/)?ship\.mjs(?![\w.-])(?!\s+\S+\s+\d+\s+plan(?![\w-]))`,
    "shipping: merge, release, deploy or install (ship.mjs; its plan is fine)",
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
    if (repo) add(repo, compile(repo.config).reserved)
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
  const { roleEnv, reserved } = compile(config)
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
  const workerHit = WORKER_RULES.find((r) => r.re.test(command))
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
