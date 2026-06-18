import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitStatus } from "./status.mjs"
import { seededRepo, rm } from "./_fixtures.mjs"

let REPO
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

test("git_status reports unstaged + untracked work", async () => {
  const r = await execGitStatus({ cwd: REPO })
  assert.equal(r.isError, undefined)
  const text = r.content[0].text
  assert.match(text, /a\.txt/)
  assert.match(text, /b\.txt/)
})
