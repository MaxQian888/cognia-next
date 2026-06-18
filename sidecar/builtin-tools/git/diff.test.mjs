import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitDiff } from "./diff.mjs"
import { seededRepo, rm } from "./_fixtures.mjs"

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
