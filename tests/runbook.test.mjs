// Run: node --test (from the repo root)
// The migration runbook (docs/qa/0.5.0-live-qa.md, part B) as written: its shell blocks are run
// here against scratch repos (every /root/ path moved under a temp folder), so the text the
// coordinator follows is the text that was tested.
import "./guard.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const DOC = readFileSync(fileURLToPath(new URL("../docs/qa/0.5.0-live-qa.md", import.meta.url)), "utf8")

/** The text of a section ("### B0. …" up to the next heading). */
const section = (title) => {
  const start = DOC.indexOf(`### ${title}`)
  assert.ok(start >= 0, title)
  const end = DOC.indexOf("\n#", start + 4)
  return DOC.slice(start, end < 0 ? undefined : end)
}
/** The ```sh blocks of a text, without their indentation. */
const blocks = (text) =>
  [...text.matchAll(/^( *)```sh\n([\s\S]*?)^ *```/gm)].map(([, indent, body]) =>
    body
      .split("\n")
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
      .join("\n"),
  )

/** A shell block with every /root/ path under `root`; none of the real ones may be left. */
function scratchRun(script, root) {
  const moved = script.replaceAll("/root/", `${root}/`)
  assert.doesNotMatch(moved, /(^|[\s'"=])\/root\//, "no real path left")
  return spawnSync("bash", ["-c", moved], { encoding: "utf8", env: { ...process.env, HOME: root } })
}

test("B0's leftover check names a leftover in either repo, and says ok only when there is none", () => {
  const check = blocks(section("B0")).find((b) => b.includes("job-board.migrated"))
  assert.ok(check, "B0 has the leftover check")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-runbook-")))
  try {
    for (const repo of ["sfc-integration", "ai-config"]) mkdirSync(join(root, repo, ".git"), { recursive: true })
    const run = () => scratchRun(check, root).stdout
    assert.equal(run().trim(), "ok: no leftovers")
    for (const leftover of ["sfc-integration/.git/job-board.migrated.json", "ai-config/.git/job-board.migrated-20261019-173700.json"]) {
      writeFileSync(join(root, leftover), "{}")
      const out = run()
      assert.match(out, new RegExp(`^STOP: ${join(root, leftover).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: move it out`, "m"))
      assert.doesNotMatch(out, /ok: no leftovers/, "never ok beside a STOP")
      rmSync(join(root, leftover))
    }
    // Both at once: both named.
    writeFileSync(join(root, "sfc-integration/.git/job-board.migrated.json"), "{}")
    writeFileSync(join(root, "ai-config/.git/job-board.migrated.json"), "{}")
    assert.equal(run().match(/^STOP:/gm).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("B3: 0.5.0 is uninstalled before any 0.4 file goes back; the restore reads the store's file, puts back the recorded files, and never overwrites a board written since", () => {
  const b3 = section("B3")
  const at = (text) => b3.indexOf(text)
  assert.ok(at("herdr plugin uninstall herdr-job-board") >= 0)
  assert.ok(at("herdr plugin uninstall herdr-job-board") < at("read -r renamed from"), "uninstall before the files come back")
  assert.ok(at("export --legacy") < at("herdr plugin uninstall"), "the export while 0.5.0 can still run it")
  assert.ok(at("ls -la /root/sfc-integration/.git/job-board.json") > at("read -r renamed from"), "the check at the end")
  const restore = blocks(b3).find((b) => b.includes("read -r renamed from"))
  assert.doesNotMatch(restore, /\$BOARD/, "no 0.5 CLI after the uninstall")

  const root = realpathSync(mkdtempSync(join(tmpdir(), "board-runbook-")))
  try {
    const store = join(root, ".local", "state", "herdr-job-board")
    mkdirSync(store, { recursive: true })
    const repos = ["sfc-integration", "ai-config"].map((name) => join(root, name, ".git"))
    for (const dir of repos) mkdirSync(dir, { recursive: true })
    // The import renamed sfc's file with a time (a leftover had the plain name) and ai-config's plainly.
    const [sfc, ai] = repos
    writeFileSync(join(sfc, "job-board.migrated.json"), "an older leftover")
    writeFileSync(join(sfc, "job-board.migrated-20261020-090000.json"), "sfc at the import")
    writeFileSync(join(ai, "job-board.migrated.json"), "ai at the import")
    writeFileSync(
      join(store, "board.json"),
      JSON.stringify({
        imports: [
          { project: "sfc-integration", from: join(sfc, "job-board.json"), renamed: join(sfc, "job-board.migrated-20261020-090000.json") },
          { project: "ai-config", from: join(ai, "job-board.json"), renamed: join(ai, "job-board.migrated.json") },
          { project: "older", from: "/nowhere" },
        ],
      }),
    )
    // A 0.4 write after the uninstall already made ai-config a new board: left alone.
    writeFileSync(join(ai, "job-board.json"), "written since")
    const r = scratchRun(restore, root)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^back: ${join(sfc, "job-board.json").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"))
    assert.match(r.stdout, /^STOP: .*ai-config\/\.git\/job-board\.json exists \(written since\?\); left as it is$/m)
    assert.equal(readFileSync(join(sfc, "job-board.json"), "utf8"), "sfc at the import")
    assert.equal(readFileSync(join(sfc, "job-board.migrated.json"), "utf8"), "an older leftover", "the leftover untouched")
    assert.equal(readFileSync(join(ai, "job-board.json"), "utf8"), "written since")
    assert.ok(existsSync(join(ai, "job-board.migrated.json")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
