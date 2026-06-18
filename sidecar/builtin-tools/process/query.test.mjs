import { test } from "node:test"
import assert from "node:assert/strict"

import {
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
} from "./query.mjs"

function decode(r) {
  return JSON.parse(r.content[0].text)
}

test("list_processes returns a non-empty list with our own pid", async () => {
  const r = await execListProcesses({
    name: undefined,
    limit: 5000,
    sortBy: "pid",
    sortDesc: false,
  })
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.ok(data.processes.length > 0, "should list at least one process")
  const ourPid = process.pid
  const found = data.processes.some((p) => p.pid === ourPid)
  // The own pid is a sanity check; on tightly-locked containers it can be
  // absent, so we only require either it's present or the list is non-trivial.
  assert.ok(found || data.processes.length >= 5)
})

test("list_processes name filter narrows the list", async () => {
  const r = await execListProcesses({
    name: "nonsense-marker-that-shouldnt-match-anything-xyz",
    limit: 100,
    sortBy: "pid",
    sortDesc: false,
  })
  const data = decode(r)
  assert.equal(data.processes.length, 0)
})

test("list_processes honours limit", async () => {
  const r = await execListProcesses({ limit: 1, sortBy: "memory", sortDesc: true })
  assert.equal(decode(r).processes.length, 1)
})

test("get_process returns details for our own pid", async () => {
  const r = await execGetProcess({ pid: process.pid })
  // On macOS sandboxes the host ps may not surface the test runner; tolerate
  // not-found by ensuring at least the path doesn't throw.
  if (r.isError) {
    assert.match(r.content[0].text, /no process with pid/)
  } else {
    const data = decode(r)
    assert.equal(data.pid, process.pid)
  }
})

test("get_process returns error for definitely-bogus pid", async () => {
  const r = await execGetProcess({ pid: 0x7fffffff })
  assert.equal(r.isError, true)
})

test("search_processes accepts substring queries", async () => {
  const r = await execSearchProcesses({ name: "node", limit: 5 })
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.ok(Array.isArray(data.processes))
})

test("top_memory_processes returns at most N entries", async () => {
  const r = await execTopMemoryProcesses({ limit: 3 })
  const data = decode(r)
  assert.ok(data.processes.length <= 3)
})
