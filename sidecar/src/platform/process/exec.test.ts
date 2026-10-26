import { test } from "node:test"
import assert from "node:assert/strict"
import type { ExecFileException } from "node:child_process"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import {
  execFileAsync,
  runCapped,
  withProcessSandbox,
  resolveProcessPortEnv,
  sandboxedProcessEnv,
  spawnInProcessSandbox,
} from "./exec.ts"

test("port env accepts an empty standalone overlay but rejects malformed allocations", async () => {
  for (const value of [{}, null]) {
    assert.deepEqual(
      await withProcessSandbox(undefined, process.cwd(), () => resolveProcessPortEnv(), {
        hostRpc: {
          async call() {
            return value
          },
        },
      }),
      {}
    )
  }
  for (const value of [{ PORT: "41000" }, { COGNIA_PORT: 41000 }, []]) {
    await assert.rejects(
      withProcessSandbox(undefined, process.cwd(), () => resolveProcessPortEnv(), {
        hostRpc: {
          async call() {
            return value
          },
        },
      }),
      /invalid/
    )
  }
})

test("execFileAsync resolves with stdout for a successful run", async () => {
  const { stdout } = await execFileAsync("node", ["-e", "process.stdout.write('hi')"])
  assert.equal(String(stdout), "hi")
})

test("execFileAsync keeps all standard streams connected for tool children", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    `const fs = require('node:fs'); process.stdout.write([0, 1, 2].map((fd) => { try { fs.fstatSync(fd); return 'open' } catch { return 'closed' } }).join(','))`,
  ])
  assert.equal(String(stdout), "open,open,open")
})

test("execFileAsync rejects with code attached on non-zero exit", async () => {
  await assert.rejects(
    () => execFileAsync("node", ["-e", "process.exit(3)"]),
    (err: ExecFileException) => {
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
    (err: ExecFileException) => {
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
  const { sandboxedProcessTarget } = await import("./exec.ts")
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
  const { withProcessSandbox } = await import("./exec.ts")
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
  assert.match(String((await allowed).stdout), /legacy/)
})

test("sandbox process environment strips ambient credentials and injected loader options", async () => {
  const { sandboxedProcessEnv } = await import("./exec.ts")
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

const trustedPorts = { COGNIA_PORT: "41000", COGNIA_PORT_COUNT: "10", PORT: "41000" }

test("trusted ports win after user overrides with and without sandbox filtering", () => {
  for (const scope of [undefined, {}]) {
    const result = sandboxedProcessEnv(
      { PORT: "1111" },
      scope,
      { PORT: "2222", COGNIA_PORT: "2222" },
      trustedPorts
    )
    assert.deepEqual(result, trustedPorts)
  }
})

test("port resolution caches canonical cwd per call and isolates concurrent sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "port-env-"))
  const other = path.join(root, "other")
  const alias = path.join(root, "alias")
  fs.mkdirSync(other)
  fs.symlinkSync(other, alias, "dir")
  const calls: unknown[] = []
  const hostRpc = {
    async call(method: string, params: unknown) {
      calls.push([method, params])
      return trustedPorts
    },
  }
  try {
    await withProcessSandbox(
      undefined,
      root,
      async () => {
        await Promise.all([resolveProcessPortEnv(), resolveProcessPortEnv(root)])
        await resolveProcessPortEnv(other)
        await resolveProcessPortEnv(alias)
        assert.equal(calls.length, 2)
      },
      { hostRpc, sessionId: "one" }
    )
    await withProcessSandbox(undefined, root, () => resolveProcessPortEnv(), {
      hostRpc,
      sessionId: "one",
    })
    assert.equal(calls.length, 3, "a new tool call receives a fresh cache")
    const results = await Promise.all(
      ["41000", "42000"].map((port) =>
        withProcessSandbox(
          undefined,
          root,
          async () => {
            await new Promise((resolve) => setImmediate(resolve))
            return resolveProcessPortEnv()
          },
          { sessionId: port, hostRpc: { call: async () => ({ ...trustedPorts, PORT: port }) } }
        )
      )
    )
    assert.deepEqual(
      results.map((value) => value.PORT),
      ["41000", "42000"]
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("shared exec and streaming spawn apply trusted ports to the actual cwd", async () => {
  const script =
    "process.stdout.write([process.env.COGNIA_PORT,process.env.COGNIA_PORT_COUNT,process.env.PORT].join(','))"
  await withProcessSandbox(
    undefined,
    process.cwd(),
    async () => {
      const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
        env: { PORT: "3333" },
      })
      assert.equal(String(stdout), "41000,10,41000")
      const child = await spawnInProcessSandbox(process.execPath, ["-e", script], {
        env: { PORT: "3333" },
      })
      let output = ""
      child.stdout!.on("data", (chunk) => {
        output += String(chunk)
      })
      await once(child, "close")
      assert.equal(output, "41000,10,41000")
    },
    { hostRpc: { call: async () => trustedPorts }, sessionId: "shared" }
  )
})

test("host resolution errors refuse both shared spawn paths and standalone is a no-op", async () => {
  assert.deepEqual(await resolveProcessPortEnv("/a/path/that/does/not/exist"), {})
  await withProcessSandbox(
    undefined,
    process.cwd(),
    async () => {
      await assert.rejects(
        execFileAsync(process.execPath, ["-e", "throw Error('spawned')"]),
        /port range exhausted/
      )
      await assert.rejects(spawnInProcessSandbox(process.execPath, []), /port range exhausted/)
    },
    {
      hostRpc: {
        call: async () => {
          throw new Error("port range exhausted")
        },
      },
    }
  )
})
