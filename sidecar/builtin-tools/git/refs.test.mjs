import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitBranch, execGitRemote, execGitTag } from "./refs.mjs"
import { seededRepo, rm } from "./_fixtures.mjs"

let REPO
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

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
