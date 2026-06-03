import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { execFileSync } from "node:child_process"

import { __testExports } from "../git.mjs"

const {
  execGitStatus,
  execGitDiff,
  execGitLog,
  execGitBranch,
  execGitRemote,
  execGitTag,
  execGitRepoInspect,
  execGitChanges,
  execGitHistory,
  execGitStage,
  execGitCommit,
  trimTail,
  assertRepo,
} = __testExports

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-git-w-"))
  git(["init", "-q", "-b", "main"], dir)
  git(["config", "user.email", "test@example.com"], dir)
  git(["config", "user.name", "Cognia Test"], dir)
  return dir
}

let REPO

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  })
}

before(() => {
  // Build a tiny throwaway repo so tests don't depend on the host repo state.
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-git-"))
  git(["init", "-q", "-b", "main"], REPO)
  git(["config", "user.email", "test@example.com"], REPO)
  git(["config", "user.name", "Cognia Test"], REPO)
  fs.writeFileSync(path.join(REPO, "a.txt"), "alpha\nbeta\n")
  git(["add", "a.txt"], REPO)
  git(["commit", "-q", "-m", "first"], REPO)
  fs.writeFileSync(path.join(REPO, "a.txt"), "alpha\nBETA\n")
  fs.writeFileSync(path.join(REPO, "b.txt"), "untracked\n")
  git(["tag", "v0.1.0"], REPO)
})

after(() => {
  fs.rmSync(REPO, { recursive: true, force: true })
})

function decodeJSON(result) {
  return JSON.parse(result.content[0].text)
}

test("git_status reports unstaged + untracked work", async () => {
  const r = await execGitStatus({ cwd: REPO })
  assert.equal(r.isError, undefined)
  const text = r.content[0].text
  assert.match(text, /a\.txt/)
  assert.match(text, /b\.txt/)
})

test("git_diff (working tree) shows BETA replacement", async () => {
  const r = await execGitDiff({ cwd: REPO, staged: false, context: 3 })
  assert.equal(r.isError, undefined)
  const text = r.content[0].text
  assert.match(text, /-beta/)
  assert.match(text, /\+BETA/)
})

test("git_diff returns '(no changes)' when staged area is clean", async () => {
  const r = await execGitDiff({ cwd: REPO, staged: true, context: 3 })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /\(no changes\)/)
})

test("git_log returns structured commits", async () => {
  const r = await execGitLog({ cwd: REPO, limit: 5 })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.equal(data.commits.length, 1)
  assert.equal(data.commits[0].subject, "first")
  assert.match(data.commits[0].hash, /^[a-f0-9]{40}$/)
})

test("git_log honours limit", async () => {
  const r = await execGitLog({ cwd: REPO, limit: 1 })
  assert.equal(r.isError, undefined)
  assert.equal(decodeJSON(r).commits.length, 1)
})

test("git_branch lists current branch", async () => {
  const r = await execGitBranch({ cwd: REPO, remote: false })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /main/)
})

test("git_remote returns '(no remotes)' for a fresh init", async () => {
  const r = await execGitRemote({ cwd: REPO })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /no remotes/)
})

test("git_tag lists v0.1.0", async () => {
  const r = await execGitTag({ cwd: REPO })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /v0\.1\.0/)
})

test("git_tag with pattern filters", async () => {
  const r = await execGitTag({ cwd: REPO, pattern: "v*" })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /v0\.1\.0/)
})

test("git_repo_inspect returns top-level + HEAD info", async () => {
  const r = await execGitRepoInspect({ cwd: REPO })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.match(data.headHash, /^[a-f0-9]{40}$/)
  assert.equal(data.headRef, "main")
  assert.equal(data.upstream, null)
})

test("git_changes lists modified + untracked", async () => {
  const r = await execGitChanges({ cwd: REPO })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  const files = new Set(data.entries.map((e) => e.file))
  assert.ok(files.has("a.txt"), "expected a.txt as changed")
  assert.ok(files.has("b.txt"), "expected b.txt as untracked")
})

test("git_history limits to a pathspec", async () => {
  const r = await execGitHistory({ cwd: REPO, pathspec: ["a.txt"], limit: 5 })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.equal(data.commits.length, 1)
})

test("any tool errors when cwd isn't a repo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-not-repo-"))
  for (const fn of [
    () => execGitStatus({ cwd: tmp }),
    () => execGitDiff({ cwd: tmp, staged: false, context: 3 }),
    () => execGitLog({ cwd: tmp, limit: 5 }),
    () => execGitBranch({ cwd: tmp, remote: false }),
    () => execGitRemote({ cwd: tmp }),
    () => execGitTag({ cwd: tmp }),
    () => execGitRepoInspect({ cwd: tmp }),
    () => execGitChanges({ cwd: tmp }),
    () => execGitHistory({ cwd: tmp, pathspec: ["a.txt"], limit: 5 }),
  ]) {
    const r = await fn()
    assert.equal(r.isError, true)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("git_stage stages a path (WRITE)", async () => {
  const dir = freshRepo()
  fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n")
  const r = await execGitStage({ cwd: dir, paths: ["new.txt"] })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.deepEqual(data.staged, ["new.txt"])
  // Porcelain shows it added to the index ("A").
  assert.match(git(["status", "--porcelain"], dir), /A\s+new\.txt/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("git_commit commits staged changes and returns the hash (WRITE)", async () => {
  const dir = freshRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n")
  await execGitStage({ cwd: dir, paths: ["a.txt"] })
  const r = await execGitCommit({ cwd: dir, message: "feat: add a", signoff: false })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.equal(data.committed, true)
  assert.match(data.hash, /^[a-f0-9]{40}$/)
  assert.match(git(["log", "--oneline"], dir), /feat: add a/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("git_commit errors with nothing staged", async () => {
  const dir = freshRepo()
  const r = await execGitCommit({ cwd: dir, message: "empty", signoff: false })
  assert.equal(r.isError, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("assertRepo rejects empty cwd", async () => {
  await assert.rejects(() => assertRepo(""), /cwd/)
})

test("trimTail leaves short strings alone and truncates long ones", () => {
  const short = "x".repeat(10)
  assert.deepEqual(trimTail(short, 100), { text: short, truncated: false })
  const long = "y".repeat(500)
  const t = trimTail(long, 50)
  assert.equal(t.truncated, true)
  assert.match(t.text, /truncated/)
})
