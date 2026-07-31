import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"

import {
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
} from "./query.mjs"

function decode(r) {
  return JSON.parse(r.content[0].text)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

test("list_processes explains capped results with an explicit note", async () => {
  const r = await execListProcesses({ limit: 1, sortBy: "memory", sortDesc: true })
  const data = decode(r)
  if (data.total > 1) {
    assert.equal(data.truncated, true)
    assert.match(data.note, /result capped at 1 processes/)
    assert.match(data.note, /more exist/)
  }
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

test("search_processes does not echo inputs and reports truncation metadata", async () => {
  const r = await execSearchProcesses({
    name: "nonsense-marker-that-shouldnt-match-anything-xyz",
    limit: 1,
  })
  const data = decode(r)
  assert.equal(Object.hasOwn(data, "query"), false)
  assert.equal(data.total, 0)
  assert.equal(data.truncated, false)
  assert.equal(Object.hasOwn(data, "note"), false)
})

test("search_processes explains capped matches with an explicit note", async () => {
  const children = [
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      windowsHide: true,
    }),
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      windowsHide: true,
    }),
  ]
  try {
    await delay(200)
    const r = await execSearchProcesses({ name: "node", limit: 1 })
    const data = decode(r)
    if (data.total > 1) {
      assert.equal(data.truncated, true)
      assert.match(data.note, /result capped at 1 processes/)
      assert.match(data.note, /more exist/)
    }
  } finally {
    for (const child of children) child.kill()
  }
})

test("top_memory_processes returns at most N entries", async () => {
  const r = await execTopMemoryProcesses({ limit: 3 })
  const data = decode(r)
  assert.ok(data.processes.length <= 3)
})

test("top_memory_processes reports total and capped results", async () => {
  const r = await execTopMemoryProcesses({ limit: 1 })
  const data = decode(r)
  assert.equal(typeof data.total, "number")
  assert.equal(typeof data.truncated, "boolean")
  if (data.total > 1) {
    assert.equal(data.truncated, true)
    assert.match(data.note, /result capped at 1 processes/)
    assert.match(data.note, /more exist/)
  }
})
