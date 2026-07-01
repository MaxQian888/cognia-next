import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import fs from "node:fs"
import path from "node:path"

import { execGitStatus } from "./status.mjs"
import { seededRepo, initRepo, git, rm } from "./_fixtures.mjs"

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

test("git_status renders non-ASCII (CJK) paths verbatim, not octal-escaped", async () => {
  const dir = initRepo("cognia-git-cjk-")
  try {
    const name = "测试文件.txt"
    fs.writeFileSync(path.join(dir, name), "x\n")
    git(["add", "-A"], dir)
    const r = await execGitStatus({ cwd: dir })
    assert.equal(r.isError, undefined)
    const text = r.content[0].text
    // With core.quotepath=false the path is human-readable; without it git
    // would emit the octal escape sequence \346\265\213…
    assert.match(text, /测试文件\.txt/)
    assert.doesNotMatch(text, /\\346/)
  } finally {
    rm(dir)
  }
})
