#!/bin/sh
# The job board's channel (a Claude Code channel plugin's MCP server): build the Go binary when it
# is missing or older than its sources, then run it in place of this shell.
#
#   sh channel/run.sh            start it (what Claude Code runs, over stdio)
#   sh channel/run.sh --build    only build it (bin/job-board-channel); exit 0 once it is there
#
# Needs Go 1.22 or later to build (/usr/local/go/bin and Homebrew's are looked in too); the
# binary has no other dependency. Build output goes to stderr, never stdout (the MCP stream).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/bin/job-board-channel"
stale=0
if [ ! -x "$bin" ]; then
  stale=1
else
  for f in "$here"/*.go "$here/go.mod"; do
    if [ "$f" -nt "$bin" ]; then stale=1; fi
  done
fi
if [ "$stale" = 1 ]; then
  PATH="$PATH:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin"
  if ! command -v go >/dev/null 2>&1; then
    echo "job-board channel: Go isn't installed, so the channel can't be built (https://go.dev/dl/)" >&2
    exit 1
  fi
  mkdir -p "$here/bin"
  tmp="$bin.$$.tmp"
  # A static binary, built in the plugin's folder; the new one replaces the old in one rename.
  if ! (cd "$here" && CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -ldflags "-s -w" -o "$tmp" .) >&2; then
    rm -f "$tmp"
    echo "job-board channel: the build failed" >&2
    exit 1
  fi
  mv -f "$tmp" "$bin"
fi
if [ "${1:-}" = "--build" ]; then exit 0; fi
exec "$bin" "$@"
