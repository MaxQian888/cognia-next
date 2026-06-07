import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"

import { createBashTool, tailTruncate, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./bash.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

test("bash runs a command and returns its output", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  const res = await tool.handler({ command: "echo core-bash-ok" }, {})
  assert.ok(!res.isError, textOf(res))
  assert.match(textOf(res), /core-bash-ok/)
})

test("bash surfaces non-zero exit codes as errors", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  const res = await tool.handler({ command: "exit 3" }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /exit code 3/)
})

test("bash kills on timeout and says so", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  const sleepCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const res = await tool.handler({ command: sleepCmd, timeout: 500 }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /timed out after 500 ms/)
})

test("bash hard-rejects destructive chaining patterns", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  const res = await tool.handler({ command: "echo hi && rm -rf /" }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /rejected/)
})

test("bash respects workdir", async () => {
  const tool = createBashTool({ cwd: os.homedir() })
  const printCwd = process.platform === "win32" ? "cd" : "pwd"
  const res = await tool.handler({ command: printCwd, workdir: os.tmpdir() }, {})
  const out = textOf(res).toLowerCase()
  // Compare path tails — Windows `cd` prints the resolved 8.3-free path.
  assert.ok(out.includes(os.tmpdir().split(/[\\/]/).pop().toLowerCase()))
})

test("tailTruncate keeps the tail and flags truncation", () => {
  const { text, truncated } = tailTruncate("a".repeat(100), 10)
  assert.equal(truncated, true)
  assert.match(text, /earlier characters dropped/)
  assert.ok(text.endsWith("a".repeat(10)))
  assert.deepEqual(tailTruncate("short", 10), { text: "short", truncated: false })
})

test("timeout bounds are sane", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
  assert.equal(MAX_TIMEOUT_MS, 600_000)
})
