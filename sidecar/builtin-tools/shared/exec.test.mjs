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

test("sandbox process target never grants the requested cwd additional write access", async () => {
  const { sandboxedProcessTarget } = await import("./exec.mjs")
  const scope = {
    launcher: process.execPath,
    writableRoots: [process.cwd()],
    readableRoots: [],
    network: false,
  }
  assert.throws(
    () => sandboxedProcessTarget("sh", ["-c", "echo ok"], "/", scope),
    /outside.*writable/
  )
  const target = sandboxedProcessTarget("sh", ["-c", "echo 'a b'"], process.cwd(), scope)
  assert.equal(target.command, process.execPath)
  assert.deepEqual(target.args.slice(-4), ["--", "sh", "-c", "echo 'a b'"])
  assert.equal(target.args.includes("--network"), false)
  assert.throws(
    () => sandboxedProcessTarget("sh", [], process.cwd(), { ...scope, launcher: "" }),
    /launcher.*unavailable/
  )
})

test("shared-exec sandbox scope is isolated between concurrent tool sessions", async () => {
  const { withProcessSandbox } = await import("./exec.mjs")
  const denied = withProcessSandbox(
    { launcher: "", writableRoots: [], readableRoots: [], network: false },
    process.cwd(),
    async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return execFileAsync(process.execPath, ["-e", "console.log('must not run')"])
    }
  )
  const allowed = execFileAsync(process.execPath, ["-e", "console.log('legacy')"])
  await assert.rejects(denied, /launcher is unavailable/)
  assert.match((await allowed).stdout, /legacy/)
})

test("sandbox process environment strips ambient credentials and injected loader options", async () => {
  const { sandboxedProcessEnv } = await import("./exec.mjs")
  const env = sandboxedProcessEnv(
    {
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      LD_PRELOAD: "evil",
      NODE_OPTIONS: "--require evil",
      PNPM_HOME: "/tools",
    },
    {},
    { DYLD_INSERT_LIBRARIES: "evil", NODE_OPTIONS: "--require evil", CUSTOM_BUILD_MODE: "debug" }
  )
  assert.deepEqual(env, { PATH: "/bin", PNPM_HOME: "/tools", CUSTOM_BUILD_MODE: "debug" })
})
