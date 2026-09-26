import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitBranch, execGitRemote, execGitTag } from "./refs.ts"
import { seededRepo, rm } from "../../../../test-support/git-repo.ts"
import { firstText } from "../../../../test-support/tool-result.ts"

let REPO: string
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

test("git_branch lists current branch", async () => {
  const r = await execGitBranch({ cwd: REPO, remote: false })
  assert.equal(r.isError, undefined)
  assert.match(firstText(r), /main/)
})

test("git_remote returns '(no remotes)' for a fresh init", async () => {
  const r = await execGitRemote({ cwd: REPO })
  assert.equal(r.isError, undefined)
  assert.match(firstText(r), /no remotes/)
})

test("git_tag lists v0.1.0", async () => {
  const r = await execGitTag({ cwd: REPO })
  assert.equal(r.isError, undefined)
  assert.match(firstText(r), /v0\.1\.0/)
})

test("git_tag with pattern filters", async () => {
  const r = await execGitTag({ cwd: REPO, pattern: "v*" })
  assert.equal(r.isError, undefined)
  assert.match(firstText(r), /v0\.1\.0/)
})
