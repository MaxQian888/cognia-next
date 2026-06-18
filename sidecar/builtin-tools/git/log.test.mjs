import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitLog, execGitHistory } from "./log.mjs"
import { seededRepo, rm } from "./_fixtures.mjs"

let REPO
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

function decodeJSON(result) {
  return JSON.parse(result.content[0].text)
}

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

test("git_history limits to a pathspec", async () => {
  const r = await execGitHistory({ cwd: REPO, pathspec: ["a.txt"], limit: 5 })
  assert.equal(r.isError, undefined)
  const data = decodeJSON(r)
  assert.equal(data.commits.length, 1)
})
