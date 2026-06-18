import { test } from "node:test"
import assert from "node:assert/strict"

import {
  parsePosixPs,
  parseWindowsCsv,
  parseCsvRow,
  isProgramAllowed,
  formatProcess,
  pickField,
  compareBy,
} from "./inventory.mjs"

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
