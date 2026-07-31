import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitRepoInspect, execGitChanges } from "./inspect.mjs"
import { seededRepo, rm } from "./_fixtures.mjs"

let REPO
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

function decodeJSON(result) {
  return JSON.parse(result.content[0].text)
}

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
