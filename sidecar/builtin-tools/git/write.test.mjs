import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"

import { execGitStage, execGitCommit } from "./write.mjs"
import { initRepo, git, rm } from "./_fixtures.mjs"

function decodeJSON(result) {
  return JSON.parse(result.content[0].text)
}

test("git_stage stages a path (WRITE)", async () => {
  const dir = initRepo()
  fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n")
  const r = await execGitStage({ cwd: dir, paths: ["new.txt"] })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.deepEqual(data.staged, ["new.txt"])
  // Porcelain shows it added to the index ("A").
  assert.match(git(["status", "--porcelain"], dir), /A\s+new\.txt/)
  rm(dir)
})

test("git_commit commits staged changes and returns the hash (WRITE)", async () => {
  const dir = initRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n")
  await execGitStage({ cwd: dir, paths: ["a.txt"] })
  const r = await execGitCommit({ cwd: dir, message: "feat: add a", signoff: false })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.equal(data.committed, true)
  assert.match(data.hash, /^[a-f0-9]{40}$/)
  assert.match(git(["log", "--oneline"], dir), /feat: add a/)
  rm(dir)
})

test("git_commit errors with nothing staged", async () => {
  const dir = initRepo()
  const r = await execGitCommit({ cwd: dir, message: "empty", signoff: false })
  assert.equal(r.isError, true)
  rm(dir)
})
