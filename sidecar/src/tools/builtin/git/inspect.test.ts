import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { execGitRepoInspect, execGitChanges } from "./inspect.ts"
import { seededRepo, rm } from "../../../../test-support/git-repo.ts"
import { firstJson } from "../../../../test-support/tool-result.ts"
import type { ToolResult } from "../../kernel/result.ts"

let REPO: string
before(() => {
  REPO = seededRepo()
})
after(() => rm(REPO))

interface Inspect {
  headHash: string
  headRef: string | null
  upstream: string | null
  entries: { status: string; file: string }[]
}

function decodeJSON(result: ToolResult): Inspect {
  return firstJson<Inspect>(result)
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
