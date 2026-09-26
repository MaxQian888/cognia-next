/**
 * Coverage for scripts/dev/move-to-crate.mjs.
 *
 * Run with: node --test scripts/dev/move-to-crate.test.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"

import { main, ownPaths, parseArgs, planMoves, preflight } from "./move-to-crate.mjs"

const cleanup = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const FROM = "src-tauri/src/companion_api"
const TO = "crates/cognia-companion-bus/src"

test("parseArgs collects options and files", () => {
  assert.deepEqual(
    parseArgs([
      "--from",
      FROM,
      "--to",
      TO,
      "--touch",
      "Cargo.toml",
      "push.rs",
      "--dry-run",
      "a/b.rs",
    ]),
    {
      from: FROM,
      to: TO,
      touch: ["Cargo.toml"],
      files: ["push.rs", "a/b.rs"],
      dryRun: true,
      pathsOut: null,
    }
  )
})

test("parseArgs refuses a missing value, an unknown option and an empty move", () => {
  assert.throws(() => parseArgs(["--from", "--to", TO, "x.rs"]), /--from needs a value/)
  assert.throws(() => parseArgs(["--from", FROM, "--to", TO, "--force", "x.rs"]), /unknown option/)
  assert.throws(() => parseArgs(["--from", FROM, "--to", TO]), /at least one file/)
  assert.throws(() => parseArgs(["--to", TO, "x.rs"]), /--from and --to are required/)
})

test("planMoves keeps each file's path relative to --from", () => {
  assert.deepEqual(planMoves({ from: FROM, to: TO, files: ["push.rs", "signaling/peer.rs"] }), [
    { source: `${FROM}/push.rs`, target: `${TO}/push.rs` },
    { source: `${FROM}/signaling/peer.rs`, target: `${TO}/signaling/peer.rs` },
  ])
})

test("planMoves refuses paths outside --from and duplicates", () => {
  assert.throws(() => planMoves({ from: FROM, to: TO, files: ["../lib.rs"] }), /inside --from/)
  assert.throws(() => planMoves({ from: FROM, to: TO, files: ["/etc/x.rs"] }), /inside --from/)
  assert.throws(
    () => planMoves({ from: FROM, to: TO, files: ["push.rs", "./push.rs"] }),
    /named twice/
  )
})

function fakeRepo({ untracked = [], dirty = [], existing = [], recent = [] } = {}) {
  return {
    untracked: (paths) => paths.filter((p) => untracked.includes(p)),
    dirty: (paths) => paths.filter((p) => dirty.includes(p)),
    exists: (p) => existing.includes(p),
    recentCommits: () => recent,
  }
}

test("preflight passes a clean step and reports recent commits as warnings", () => {
  const plan = planMoves({ from: FROM, to: TO, files: ["push.rs"] })
  assert.deepEqual(preflight(plan, [`${FROM}/mod.rs`], fakeRepo({ recent: ["abc123 fix: x"] })), {
    errors: [],
    warnings: ["touched in the last 6 hours: abc123 fix: x"],
  })
})

test("preflight defers on a foreign edit to a source or a touched file", () => {
  const plan = planMoves({ from: FROM, to: TO, files: ["push.rs", "store.rs"] })
  const { errors } = preflight(
    plan,
    [`${FROM}/mod.rs`],
    fakeRepo({ dirty: [`${FROM}/store.rs`, `${FROM}/mod.rs`] })
  )
  assert.deepEqual(errors, [
    `${FROM}/store.rs: has uncommitted changes — defer the step until it is clean`,
    `${FROM}/mod.rs: has uncommitted changes — defer the step until it is clean`,
  ])
})

test("preflight refuses an untracked source and an existing target", () => {
  const plan = planMoves({ from: FROM, to: TO, files: ["push.rs"] })
  const { errors } = preflight(
    plan,
    [],
    fakeRepo({ untracked: [`${FROM}/push.rs`], existing: [`${TO}/push.rs`] })
  )
  assert.deepEqual(errors, [`${FROM}/push.rs: not tracked by git`, `${TO}/push.rs: already exists`])
})

test("ownPaths lists sources, targets and touched files once, sorted", () => {
  const plan = planMoves({ from: FROM, to: TO, files: ["push.rs"] })
  assert.deepEqual(ownPaths(plan, ["Cargo.toml", "Cargo.toml"]), [
    "Cargo.toml",
    `${TO}/push.rs`,
    `${FROM}/push.rs`,
  ])
})

function gitRepoFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "move-to-crate-"))
  cleanup.push(dir)
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "test")
  git("config", "commit.gpgsign", "false")
  for (const [file, body] of [
    [`${FROM}/mod.rs`, "pub mod push;\n"],
    [`${FROM}/push.rs`, "// push\n"],
    [`${FROM}/signaling/peer.rs`, "// peer\n"],
  ]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), body)
  }
  git("add", "--", FROM)
  git("commit", "-q", "-m", "init")
  return { dir, git }
}

test("main renames the files without staging anything", () => {
  const { dir, git } = gitRepoFixture()
  const lines = []
  const code = main(
    [
      "--from",
      FROM,
      "--to",
      TO,
      "--touch",
      `${FROM}/mod.rs`,
      "--paths-out",
      "paths.txt",
      "push.rs",
      "signaling/peer.rs",
    ],
    { cwd: dir, log: (line) => lines.push(line) }
  )
  assert.equal(code, 0)
  assert.ok(!existsSync(path.join(dir, FROM, "push.rs")))
  assert.equal(readFileSync(path.join(dir, TO, "signaling/peer.rs"), "utf8"), "// peer\n")
  // Nothing reaches the shared index: another session's commit cannot take it.
  assert.equal(git("diff", "--cached", "--name-only"), "")
  assert.deepEqual(readFileSync(path.join(dir, "paths.txt"), "utf8").trim().split("\n"), [
    `${TO}/push.rs`,
    `${TO}/signaling/peer.rs`,
    `${FROM}/mod.rs`,
    `${FROM}/push.rs`,
    `${FROM}/signaling/peer.rs`,
  ])
})

test("main moves nothing when one file has a foreign edit", () => {
  const { dir } = gitRepoFixture()
  writeFileSync(path.join(dir, FROM, "signaling/peer.rs"), "// someone else's edit\n")
  const lines = []
  const code = main(["--from", FROM, "--to", TO, "push.rs", "signaling/peer.rs"], {
    cwd: dir,
    log: (line) => lines.push(line),
  })
  assert.equal(code, 1)
  assert.ok(existsSync(path.join(dir, FROM, "push.rs")), "the clean file stays put too")
  assert.ok(!existsSync(path.join(dir, TO)))
  assert.ok(lines.some((line) => line.includes("signaling/peer.rs: has uncommitted changes")))
})

test("main --dry-run reports the plan and touches nothing", () => {
  const { dir } = gitRepoFixture()
  const lines = []
  const code = main(["--from", FROM, "--to", TO, "--dry-run", "push.rs"], {
    cwd: dir,
    log: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.ok(existsSync(path.join(dir, FROM, "push.rs")))
  assert.ok(lines.includes(`would move ${FROM}/push.rs -> ${TO}/push.rs`))
})
