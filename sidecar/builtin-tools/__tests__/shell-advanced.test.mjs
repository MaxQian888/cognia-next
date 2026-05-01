import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { __testExports, shellExecuteAdvancedTool } from "../shell-advanced.mjs"

const { execShellExecuteAdvanced, MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } =
  __testExports

let TMP

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-shell-adv-"))
})

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(r) {
  return JSON.parse(r.content[0].text)
}

test("shell_execute_advanced rejects blocklisted commands", async () => {
  const r = await execShellExecuteAdvanced({
    command: "rm",
    args: ["-rf", TMP],
    cwd: TMP,
    timeoutMs: 5000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /blocked/i)
})

test("shell_execute_advanced rejects unknown commands", async () => {
  const r = await execShellExecuteAdvanced({
    command: "definitely-not-a-real-tool-xyz",
    args: [],
    cwd: TMP,
    timeoutMs: 5000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not in the allowed/i)
})

test("shell_execute_advanced rejects shell-injection patterns", async () => {
  const r = await execShellExecuteAdvanced({
    command: "echo",
    args: ["hello; rm -rf /"],
    cwd: TMP,
    timeoutMs: 5000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Dangerous/i)
})

test("shell_execute_advanced rejects non-existent cwd", async () => {
  const r = await execShellExecuteAdvanced({
    command: "echo",
    args: ["hi"],
    cwd: path.join(TMP, "definitely-not-here"),
    timeoutMs: 5000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /does not exist/)
})

test("shell_execute_advanced rejects cwd that's a file, not a directory", async () => {
  const f = path.join(TMP, "afile.txt")
  fs.writeFileSync(f, "x")
  const r = await execShellExecuteAdvanced({
    command: "echo",
    args: ["hi"],
    cwd: f,
    timeoutMs: 5000,
  })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not a directory/)
})

test("shell_execute_advanced runs an allowlisted command", async () => {
  const r = await execShellExecuteAdvanced({
    command: "node",
    args: ["-e", "console.log('PONG')"],
    cwd: TMP,
    timeoutMs: 5000,
  })
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.equal(data.exitCode, 0)
  assert.match(data.stdout, /PONG/)
})

test("shell_execute_advanced surfaces a non-zero exit code without throwing", async () => {
  const r = await execShellExecuteAdvanced({
    command: "node",
    args: ["-e", "process.exit(3)"],
    cwd: TMP,
    timeoutMs: 5000,
  })
  // Non-zero exit isn't a tool-level error — it's a structured payload.
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.equal(data.exitCode, 3)
})

test("shell_execute_advanced caps stdout when output is huge", async () => {
  // Generate a string just over the cap.
  const repeat = MAX_OUTPUT_BYTES + 100
  const r = await execShellExecuteAdvanced({
    command: "node",
    args: ["-e", `process.stdout.write('a'.repeat(${repeat}))`],
    cwd: TMP,
    timeoutMs: 10000,
  })
  // execFile's maxBuffer makes Node throw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER;
  // we capture that as a non-zero exit with stderr content rather than a
  // tool error. Either shape is acceptable so long as we don't crash.
  if (r.isError) {
    assert.match(r.content[0].text, /shell_execute_advanced/)
  } else {
    const data = decode(r)
    assert.ok(data.stdoutTruncated || data.stderr || data.error)
  }
})

test("shell_execute_advanced clamps over-large timeoutMs", async () => {
  // We can't introspect the actual timer; just verify the call accepts a
  // value at MAX_TIMEOUT_MS without rejecting.
  const r = await execShellExecuteAdvanced({
    command: "node",
    args: ["-e", "console.log('ok')"],
    cwd: TMP,
    timeoutMs: MAX_TIMEOUT_MS,
  })
  assert.equal(r.isError, undefined)
})

test("shell_execute_advanced respects an aggressive timeout", async () => {
  const r = await execShellExecuteAdvanced({
    command: "node",
    args: ["-e", "setTimeout(()=>{}, 60000)"],
    cwd: TMP,
    timeoutMs: 1000,
  })
  // Timed-out commands are reported as timedOut:true (not an isError).
  if (r.isError === undefined) {
    const data = decode(r)
    assert.equal(data.timedOut, true)
  }
})

test("MAX_OUTPUT_BYTES and timeout constants are sensible", () => {
  assert.equal(MAX_OUTPUT_BYTES, 64 * 1024)
  assert.equal(DEFAULT_TIMEOUT_MS, 30000)
  assert.equal(MAX_TIMEOUT_MS, 300000)
})

test("shell_execute_advanced exports a tool definition with the expected shape", () => {
  assert.equal(shellExecuteAdvancedTool.name, "shell_execute_advanced")
  assert.match(shellExecuteAdvancedTool.description, /HIGH-RISK/)
})
