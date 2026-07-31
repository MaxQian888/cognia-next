import { test } from "node:test"
import assert from "node:assert/strict"

import {
  execCheckProgramAllowed,
  execGetProcessManagerStatus,
  execGetTrackedProcesses,
} from "./manager.mjs"
import { trackedPids } from "./inventory.mjs"

function decode(r) {
  return JSON.parse(r.content[0].text)
}

test("check_program_allowed accepts git", async () => {
  const r = await execCheckProgramAllowed({ program: "git" })
  assert.equal(decode(r).allowed, true)
})

test("check_program_allowed rejects rm", async () => {
  const r = await execCheckProgramAllowed({ program: "rm" })
  assert.equal(decode(r).allowed, false)
})

test("check_program_allowed strips .exe", async () => {
  const r = await execCheckProgramAllowed({ program: "git.exe" })
  assert.equal(decode(r).allowed, true)
})

test("get_process_manager_status reports tracked count", async () => {
  trackedPids.clear()
  const r = await execGetProcessManagerStatus({})
  const data = decode(r)
  assert.equal(data.trackedCount, 0)
  assert.equal(data.platform, process.platform)
})

test("get_tracked_processes with no tracked PIDs returns empty", async () => {
  trackedPids.clear()
  const r = await execGetTrackedProcesses({ includeDetails: true })
  const data = decode(r)
  assert.equal(data.trackedCount, 0)
})

test("get_tracked_processes returns ids without details when includeDetails=false", async () => {
  trackedPids.clear()
  trackedPids.add(123456)
  const r = await execGetTrackedProcesses({ includeDetails: false })
  const data = decode(r)
  assert.deepEqual(data.trackedPids, [123456])
  assert.equal(data.processes, undefined)
  trackedPids.clear()
})
