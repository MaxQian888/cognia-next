import { test } from "node:test"
import assert from "node:assert/strict"

import { execStartProcess, execTerminateProcess } from "./lifecycle.mjs"
import { trackedPids } from "./inventory.mjs"

test("terminate_process refuses untracked pids by default", async () => {
  trackedPids.clear()
  const r = await execTerminateProcess({
    pid: 0x7fffffff,
    force: false,
    allowUntracked: false,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not started by this session/)
})

test("terminate_process surfaces a kill error with allowUntracked=true", async () => {
  const r = await execTerminateProcess({
    pid: 0x7fffffff,
    force: false,
    allowUntracked: true,
  })
  assert.equal(r.isError, true)
})

test("start_process surfaces a non-zero exit as a result (not a tool error)", async () => {
  // `git` is allowlisted and present; a bogus flag exits non-zero on every OS.
  const r = await execStartProcess({
    program: "git",
    args: ["--no-such-flag"],
    detached: false,
    timeoutSecs: 30,
  })
  assert.notEqual(r.isError, true) // a non-zero exit is a normal outcome
  const payload = JSON.parse(r.content[0].text)
  assert.notEqual(payload.exitCode, 0) // the REAL exit code, not hard-coded 0
  assert.ok(payload.stderr.length > 0) // captured output is preserved
})

test("start_process rejects a program not on the allowlist", async () => {
  const r = await execStartProcess({ program: "definitely-not-allowed", args: [], detached: true })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /allowlist/)
})
