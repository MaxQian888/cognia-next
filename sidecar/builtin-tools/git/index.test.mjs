import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { gitTools, GIT_TOOL_NAMES, __testExports } from "./index.mjs"

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
} = __testExports

test("gitTools registration order is byte-stable", () => {
  assert.deepEqual(
    gitTools.map((t) => t.name),
    [...GIT_TOOL_NAMES]
  )
})

test("gitTools exposes all 11 git tools", () => {
  assert.equal(gitTools.length, 11)
})

test("__testExports exposes every handler + runner helpers", () => {
  for (const key of [
    "execGitStatus",
    "execGitDiff",
    "execGitLog",
    "execGitBranch",
    "execGitRemote",
    "execGitTag",
    "execGitRepoInspect",
    "execGitChanges",
    "execGitHistory",
    "execGitStage",
    "execGitCommit",
    "runGit",
    "assertRepo",
    "trimTail",
  ]) {
    assert.equal(typeof __testExports[key], "function", `missing ${key}`)
  }
})

test("any read tool errors when cwd isn't a repo", async () => {
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
