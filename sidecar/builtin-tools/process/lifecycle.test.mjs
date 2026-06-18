import { test } from "node:test"
import assert from "node:assert/strict"

import { execTerminateProcess } from "./lifecycle.mjs"
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
