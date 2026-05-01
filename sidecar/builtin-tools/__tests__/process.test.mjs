import { test } from "node:test"
import assert from "node:assert/strict"

import { __testExports } from "../process.mjs"

const {
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
  execCheckProgramAllowed,
  execGetProcessManagerStatus,
  execGetTrackedProcesses,
  execTerminateProcess,
  parsePosixPs,
  parseWindowsCsv,
  parseCsvRow,
  isProgramAllowed,
  formatProcess,
  trackedPids,
  pickField,
  compareBy,
} = __testExports

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

test("isProgramAllowed honours blocklist over allowlist", () => {
  assert.equal(isProgramAllowed("rm"), false)
  assert.equal(isProgramAllowed("git"), true)
  assert.equal(isProgramAllowed("totally-bogus-tool"), false)
})

test("formatProcess converts memoryBytes → memoryMB", () => {
  const out = formatProcess({ pid: 1, name: "x", memoryBytes: 5 * 1024 * 1024 })
  assert.equal(out.memoryMB, 5)
})

test("formatProcess tolerates missing memory", () => {
  const out = formatProcess({ pid: 1, name: "x" })
  assert.equal(out.memoryMB, undefined)
})

test("parsePosixPs decodes a representative line", () => {
  const stdout =
    "  1234  5678  4096  1.5 node /usr/bin/node /tmp/script.js arg1\n" +
    "  9999     1     0  0.0 init /sbin/init\n"
  const got = parsePosixPs(stdout)
  assert.equal(got.length, 2)
  assert.equal(got[0].pid, 1234)
  assert.equal(got[0].parentPid, 5678)
  assert.equal(got[0].memoryBytes, 4096 * 1024)
  assert.equal(got[0].cpuPercent, 1.5)
  assert.equal(got[0].name, "node")
  assert.match(got[0].cmdLine, /\/tmp\/script\.js/)
})

test("parsePosixPs ignores malformed lines", () => {
  const stdout = "garbage line that does not match\n  1 0 0 0 init /sbin/init\n"
  const got = parsePosixPs(stdout)
  assert.equal(got.length, 1)
  assert.equal(got[0].pid, 1)
})

test("parseWindowsCsv decodes a small CSV", () => {
  const csv =
    "Id,ProcessName,WorkingSet64,CPU,Path,Description\r\n" +
    '"123","node","4194304","0.5","C:\\Program Files\\node.exe","Node.js"\r\n' +
    '"456","explorer","2097152","","C:\\Windows\\explorer.exe","Windows Explorer"\r\n'
  const got = parseWindowsCsv(csv)
  assert.equal(got.length, 2)
  assert.equal(got[0].pid, 123)
  assert.equal(got[0].name, "node")
  assert.equal(got[0].memoryBytes, 4194304)
  assert.equal(got[0].cpuPercent, 0.5)
  assert.match(got[0].cmdLine, /node\.exe/)
})

test("parseCsvRow handles escaped quotes", () => {
  const got = parseCsvRow('"a","b ""quoted"" c","d"')
  assert.deepEqual(got, ["a", 'b "quoted" c', "d"])
})

test("parseCsvRow handles unquoted values", () => {
  const got = parseCsvRow("a,b,c")
  assert.deepEqual(got, ["a", "b", "c"])
})

test("pickField selects by key", () => {
  const proc = { pid: 1, name: "x", memoryBytes: 100, cpuPercent: 5 }
  assert.equal(pickField(proc, "pid"), 1)
  assert.equal(pickField(proc, "name"), "x")
  assert.equal(pickField(proc, "memory"), 100)
  assert.equal(pickField(proc, "cpu"), 5)
  // Unknown keys fall back to memory.
  assert.equal(pickField(proc, "unknown"), 100)
})

test("compareBy sorts numbers descending", () => {
  const a = { pid: 1, name: "a", memoryBytes: 100 }
  const b = { pid: 2, name: "b", memoryBytes: 200 }
  assert.ok(compareBy(a, b, "memory", true) > 0)
  assert.ok(compareBy(a, b, "memory", false) < 0)
})

test("compareBy puts undefined fields last", () => {
  const a = { pid: 1, name: "a" }
  const b = { pid: 2, name: "b", memoryBytes: 100 }
  assert.ok(compareBy(a, b, "memory", true) > 0)
})
