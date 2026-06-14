import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fsp from "node:fs/promises"

import {
  createBashTool,
  createBashOutputTool,
  createKillShellTool,
  resolveShellInvocation,
  tailTruncate,
  composeBashBody,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
} from "./bash.mjs"
import { createBgShellRegistry } from "./bash-sessions.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

function extractShellId(text) {
  const m = text.match(/background shell started: (\S+)/)
  return m ? m[1] : null
}

async function pollUntil(outputTool, shellId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let acc = ""
  while (Date.now() < deadline) {
    const res = await outputTool.handler({ shellId }, {})
    acc += textOf(res)
    if (predicate(textOf(res), acc)) return acc
    await new Promise((r) => setTimeout(r, 25))
  }
  return acc
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

test("composeBashBody inlines small output and previews large spilled output", () => {
  // Small / no spill → inline.
  const small = composeBashBody({ head: "", tail: "hello", total: 5, fullPath: null })
  assert.deepEqual(small, { body: "hello", truncated: false })

  // Large + spilled → head/tail preview that names the file.
  const head = "H".repeat(12_000)
  const tail = "T".repeat(18_000)
  const big = composeBashBody({ head, tail, total: 50_000, fullPath: "/tmp/x.log" })
  assert.equal(big.truncated, true)
  assert.match(big.body, /full output saved to \/tmp\/x\.log/)
  assert.match(big.body, /characters omitted/)
  assert.ok(big.body.startsWith(head))
  assert.ok(big.body.endsWith(tail))
})

test("bash spills oversized output to a temp file and previews it", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  // Emit ~80k chars of output, well over MAX_OUTPUT_CHARS.
  const n = 80_000
  const cmd = `node -e "process.stdout.write('x'.repeat(${n}))"`
  const res = await tool.handler({ command: cmd }, {})
  assert.ok(!res.isError, textOf(res))
  const text = textOf(res)
  assert.match(text, /full output saved to .+cognia-bash-.+\.log/)
  // The named spill file exists and holds the complete output.
  const m = text.match(/full output saved to (\S+\.log)/)
  assert.ok(m, "expected a spill path")
  const full = await fsp.readFile(m[1], "utf-8")
  assert.equal(full.length, n)
  await fsp.unlink(m[1]).catch(() => {})
})

test("bash inlines output under the limit without leaving a spill file", async () => {
  const tool = createBashTool({ cwd: os.tmpdir() })
  const res = await tool.handler({ command: "echo small-inline" }, {})
  assert.ok(!res.isError, textOf(res))
  assert.match(textOf(res), /small-inline/)
  assert.doesNotMatch(textOf(res), /full output saved/)
})

test("timeout bounds are sane", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
  assert.equal(MAX_TIMEOUT_MS, 600_000)
})

test("resolveShellInvocation returns a platform shell + argv", () => {
  const { shell, shellArgs, isWin } = resolveShellInvocation("echo hi")
  assert.equal(typeof shell, "string")
  assert.ok(shellArgs.includes("echo hi"))
  assert.equal(isWin, process.platform === "win32")
})

test("bash run_in_background returns a shellId and does not block", async () => {
  const bgShells = createBgShellRegistry()
  const bash = createBashTool({ cwd: os.tmpdir(), bgShells })
  const longCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const res = await bash.handler({ command: longCmd, run_in_background: true }, {})
  assert.ok(!res.isError, textOf(res))
  const id = extractShellId(textOf(res))
  assert.ok(id, "expected a shellId in the output")
  // Clean up the long-running shell.
  bgShells.killAll()
})

test("bash run_in_background errors without a registry", async () => {
  const bash = createBashTool({ cwd: os.tmpdir() })
  const res = await bash.handler({ command: "echo hi", run_in_background: true }, {})
  assert.equal(res.isError, true)
  assert.match(textOf(res), /not available/)
})

test("bash_output follows a background shell to completion", async () => {
  const bgShells = createBgShellRegistry()
  const bash = createBashTool({ cwd: os.tmpdir(), bgShells })
  const output = createBashOutputTool({ bgShells })
  const start = await bash.handler({ command: "echo follow-me", run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const acc = await pollUntil(output, id, (_t, all) => /exited/.test(all))
  assert.match(acc, /follow-me/)
  assert.match(acc, /exited/)
})

test("bash_output reports no-new-output and unknown ids", async () => {
  const bgShells = createBgShellRegistry()
  const output = createBashOutputTool({ bgShells })
  const bash = createBashTool({ cwd: os.tmpdir(), bgShells })
  const start = await bash.handler({ command: "echo once", run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  await pollUntil(output, id, (_t, all) => /exited/.test(all))
  const again = await output.handler({ shellId: id }, {})
  assert.match(textOf(again), /no new output/)
  const missing = await output.handler({ shellId: "nope" }, {})
  assert.equal(missing.isError, true)
})

test("kill_shell terminates a background shell and is idempotent", async () => {
  const bgShells = createBgShellRegistry()
  const bash = createBashTool({ cwd: os.tmpdir(), bgShells })
  const kill = createKillShellTool({ bgShells })
  const longCmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const start = await bash.handler({ command: longCmd, run_in_background: true }, {})
  const id = extractShellId(textOf(start))
  const k1 = await kill.handler({ shellId: id }, {})
  assert.ok(!k1.isError, textOf(k1))
  assert.match(textOf(k1), /killed background shell/)
  const k2 = await kill.handler({ shellId: id }, {})
  assert.ok(!k2.isError)
  const missing = await kill.handler({ shellId: "nope" }, {})
  assert.equal(missing.isError, true)
})

test("bash_output / kill_shell error without a registry", async () => {
  const output = createBashOutputTool({})
  const kill = createKillShellTool({})
  assert.equal((await output.handler({ shellId: "x" }, {})).isError, true)
  assert.equal((await kill.handler({ shellId: "x" }, {})).isError, true)
})
