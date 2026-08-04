import { test } from "node:test"
import assert from "node:assert/strict"

import { execFileAsync, runCapped } from "./exec.mjs"

test("execFileAsync resolves with stdout for a successful run", async () => {
  const { stdout } = await execFileAsync("node", ["-e", "process.stdout.write('hi')"])
  assert.equal(String(stdout), "hi")
})

test("execFileAsync keeps all standard streams connected for tool children", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    `const fs = require('node:fs'); process.stdout.write([0, 1, 2].map((fd) => { try { fs.fstatSync(fd); return 'open' } catch { return 'closed' } }).join(','))`,
  ])
  assert.equal(stdout, "open,open,open")
})

test("execFileAsync rejects with code attached on non-zero exit", async () => {
  await assert.rejects(
    () => execFileAsync("node", ["-e", "process.exit(3)"]),
    (err) => {
      assert.equal(err.code, 3)
      return true
    }
  )
})

test("runCapped returns stringified stdout/stderr", async () => {
  const { stdout, stderr } = await runCapped("node", [
    "-e",
    "process.stdout.write('out'); process.stderr.write('err')",
  ])
  assert.equal(stdout, "out")
  assert.equal(stderr, "err")
  assert.equal(typeof stdout, "string")
})

test("runCapped enforces the timeout", async () => {
  await assert.rejects(
    () => runCapped("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 }),
    (err) => {
      assert.ok(err.killed || err.signal === "SIGTERM")
      return true
    }
  )
})

test("runCapped enforces maxBuffer", async () => {
  await assert.rejects(
    () => runCapped("node", ["-e", "process.stdout.write('x'.repeat(10000))"], { maxBuffer: 16 }),
    /maxBuffer/
  )
})
