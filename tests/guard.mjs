// Imported first by every test file: the tests never run against the user's own home, repos or
// boards. They refuse to start when HOME is the account's real home (or /root), or when
// XDG_STATE_HOME or TMPDIR are in the real home. Then JOB_BOARD_TEST_SANDBOX names
// the folders the board may touch: board.mjs refuses to write, move or import anything outside
// them (a 0.4 board in a real repo's .git, say), in this process and every child it starts.
//
//   HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp node --test
import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { resolve, sep } from "node:path"

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const refuse = (why) => {
  process.stderr.write(`tests: refusing to run: ${why}\n  run them with a scratch HOME, e.g.: HOME=$S/home XDG_STATE_HOME=$S/state TMPDIR=$S/tmp node --test\n`)
  process.exit(2)
}
const account = real(userInfo().homedir)
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const home = process.env.HOME ? real(process.env.HOME) : ""
if (!home) refuse("HOME is not set")
// HOME must not be the real home, inside it, or above it (/Users would hold every real repo).
for (const r of [account, "/root"]) if (inside(home, r) || inside(r, home)) refuse(`HOME ${home} is the real home or holds it`)
const temp = real(tmpdir())
if (inside(temp, account) || inside(temp, "/root") || inside(account, temp)) refuse(`TMPDIR ${temp} is in the real home or holds it`)
mkdirSync(temp, { recursive: true })
const state = process.env.XDG_STATE_HOME ? real(process.env.XDG_STATE_HOME) : ""
if (state && (inside(state, account) || inside(state, "/root"))) refuse(`XDG_STATE_HOME ${state} is in the real home`)
process.env.JOB_BOARD_TEST_SANDBOX = [...new Set([temp, home, ...(state ? [state] : [])])].join(":")
