import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import fs from "node:fs"
import path from "node:path"

import { execGitDiff } from "./diff.mjs"
import { seededRepo, initRepo, git, rm } from "./_fixtures.mjs"

let REPO
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

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

test("git_diff appends actionable guidance when the diff is truncated", async () => {
  const dir = initRepo("cognia-git-bigdiff-")
  try {
    const file = path.join(dir, "big.txt")
    fs.writeFileSync(file, "seed\n")
    git(["add", "-A"], dir)
    git(["commit", "-q", "-m", "seed"], dir)
    // Rewrite the whole file with > 256 KB of new content so the diff exceeds
    // the per-command output cap and gets head-truncated.
    fs.writeFileSync(file, "x".repeat(300 * 1024) + "\n")
    const r = await execGitDiff({ cwd: dir, staged: false, context: 3 })
    assert.equal(r.isError, undefined)
    const text = r.content[0].text
    assert.match(text, /truncated/)
    assert.match(text, /pathspec/)
  } finally {
    rm(dir)
  }
})
