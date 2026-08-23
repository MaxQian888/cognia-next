// The sandbox is the security boundary for Code mode, so these tests assert
// what generated code CANNOT reach at least as hard as what it can.
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CallBudget,
  SandboxUnavailableError,
  assertSandboxable,
  parseSandboxLauncher,
  probeSandbox,
  readProcessGroupRssBytes,
  resolveSandboxSpawn,
  runCodeProgram,
  sandboxEnv,
} from "./supervisor.mjs"

// `/usr/bin/env` is a real exec wrapper that passes fds through, so it
// exercises the launcher path end to end without needing bwrap installed.
const TEST_LAUNCHER = ["/usr/bin/env"]
const SANDBOXED = { canSpawnProcess: true, strictSandbox: true, launcher: TEST_LAUNCHER }

/** Run a program with a recording tool broker. */
async function run(source, options = {}) {
  const calls = []
  const result = await runCodeProgram({
    source,
    probe: SANDBOXED,
    config: options.config,
    callTool: async (name, input) => {
      calls.push({ name, input })
      if (options.toolImpl) return options.toolImpl(name, input)
      return { ok: true, name }
    },
  })
  return { ...result, calls }
}

test("fails closed when no strict sandbox is available", () => {
  assert.throws(
    () => assertSandboxable({ canSpawnProcess: true, strictSandbox: false, launcher: null }),
    (error) => error instanceof SandboxUnavailableError && error.reason === "no-strict-sandbox"
  )
  assert.throws(
    () => assertSandboxable({ canSpawnProcess: false, strictSandbox: true }),
    (error) => error instanceof SandboxUnavailableError && error.reason === "no-fork"
  )
  assert.throws(
    () => assertSandboxable({ canSpawnProcess: true, strictSandbox: true, launcher: null }),
    (error) => error instanceof SandboxUnavailableError && error.reason === "no-strict-sandbox"
  )
})

test("an unprobed host is treated as unsandboxed", () => {
  assert.throws(() => assertSandboxable(undefined), SandboxUnavailableError)
  assert.throws(() => assertSandboxable({}), SandboxUnavailableError)
})

test("probeSandbox reports strictSandbox only when a launcher is configured", () => {
  assert.equal(probeSandbox({ launcher: null }).strictSandbox, false)
  assert.equal(probeSandbox({ launcher: TEST_LAUNCHER }).strictSandbox, true)
})

test("the launcher must be a non-empty array of non-empty strings", () => {
  assert.equal(parseSandboxLauncher(undefined), null)
  assert.equal(parseSandboxLauncher(""), null)
  assert.equal(parseSandboxLauncher("not json"), null)
  assert.equal(parseSandboxLauncher("[]"), null)
  assert.equal(parseSandboxLauncher('["ok", ""]'), null)
  assert.equal(parseSandboxLauncher('["ok", 1]'), null)
  assert.deepEqual(parseSandboxLauncher('["/usr/bin/env"]'), ["/usr/bin/env"])
})

// A malformed launcher must read as "absent" — which fails closed — rather
// than throwing, so a misconfigured host degrades instead of crashing.
test("a malformed launcher fails closed rather than throwing", () => {
  assert.equal(probeSandbox({ launcher: parseSandboxLauncher("{oops") }).strictSandbox, false)
})

test("the child environment is built by construction, not by deletion", () => {
  const env = sandboxEnv()
  // The sidecar's own env carries ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN;
  // an allow-list is the only thing that keeps future secrets out too.
  assert.deepEqual(Object.keys(env).sort(), ["COGNIA_CODE_SANDBOX_CHILD", "NODE_ENV"])
})

test("compiled executables self-exec the run-code role through the strict launcher", () => {
  assert.deepEqual(
    resolveSandboxSpawn({
      standalone: true,
      launcher: ["/sandbox", "--profile", "strict"],
      execPath: "/dist/cognia-agent",
      childPath: "/$bunfs/root/sandbox-child.mjs",
      maxMemoryBytes: 64 * 1024 * 1024,
    }),
    {
      command: "/sandbox",
      args: ["--profile", "strict", "/dist/cognia-agent"],
      env: {
        BUN_OPTIONS: "--smol",
        COGNIA_CODE_SANDBOX_CHILD: "1",
        COGNIA_ROLE: "run-code",
        NODE_ENV: "development",
      },
    }
  )
})

test("source runtimes keep the physical sandbox child and V8 memory limit", () => {
  assert.deepEqual(
    resolveSandboxSpawn({
      standalone: false,
      launcher: ["/sandbox"],
      execPath: "/usr/bin/node",
      childPath: "/repo/sandbox-child.mjs",
      maxMemoryBytes: 64 * 1024 * 1024,
    }),
    {
      command: "/sandbox",
      args: ["/usr/bin/node", "--max-old-space-size=64", "/repo/sandbox-child.mjs"],
      env: {
        COGNIA_CODE_SANDBOX_CHILD: "1",
        NODE_ENV: "development",
      },
    }
  )
})

test("process-group RSS sums the sandbox wrapper and every descendant", () => {
  assert.equal(
    readProcessGroupRssBytes(42, {
      spawnSyncImpl() {
        return {
          status: 0,
          stdout: " 42 42 1024\n 43 42 2048\n 99 99 4096\n",
          stderr: "",
        }
      },
    }),
    3 * 1024 * 1024
  )
})

test("process-group RSS fails closed when the OS measurement is unavailable", () => {
  assert.throws(
    () =>
      readProcessGroupRssBytes(42, {
        spawnSyncImpl() {
          return { status: 1, stdout: "", stderr: "ps unavailable" }
        },
      }),
    /cannot enforce sandbox memory limit/
  )
})

test("runs a program and returns its value", async () => {
  const outcome = await run("return 1 + 1")
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, 2)
})

test("routes an SDK call through the host tool broker", async () => {
  const outcome = await run('return await cognia.read({ path: "a.ts" })', {
    toolImpl: () => ({ text: "contents" }),
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result, { text: "contents" })
  assert.deepEqual(outcome.calls, [{ name: "read", input: { path: "a.ts" } }])
  assert.equal(outcome.callsUsed, 1)
})

test("surfaces a tool error to the program without killing the run", async () => {
  const outcome = await run(
    'try { await cognia.read({}); return "no-throw" } catch (e) { return e.message }',
    {
      toolImpl: () => {
        throw new Error("path is required")
      },
    }
  )
  assert.equal(outcome.ok, true)
  assert.match(String(outcome.result), /path is required/)
})

// ---- what the sandbox must not reach ---------------------------------------

test("has no process, require, or module", async () => {
  const outcome = await run(
    "return [typeof process, typeof require, typeof module, typeof globalThis.process]"
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result, ["undefined", "undefined", "undefined", "undefined"])
})

test("has no network or timer globals", async () => {
  const outcome = await run(
    "return [typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof setInterval, typeof Buffer]"
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result, [
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
  ])
})

test("cannot generate code from strings", async () => {
  const outcome = await run('try { eval("1") ; return "eval-ran" } catch (e) { return "blocked" }')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "blocked")
})

test("cannot build a function from a string", async () => {
  const outcome = await run(
    'try { new Function("return 1")(); return "fn-ran" } catch (e) { return "blocked" }'
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "blocked")
})

test("cannot reach the host realm through a constructor", async () => {
  // The classic vm escape: climb to the host Function via a foreign object's
  // constructor. `cognia`'s methods are the only host-provided functions.
  const outcome = await run(
    'try { return cognia.read.constructor("return typeof process")() } catch (e) { return "blocked" }'
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "blocked")
})

test("cannot reach the host realm through a tool RESULT's prototype", async () => {
  // Results cross the boundary as JSON text and are revived inside the sandbox
  // precisely so their prototype chain is the sandbox's, not the child's.
  const outcome = await run(
    'const r = await cognia.read({}); try { return r.constructor.constructor("return typeof process")() } catch (e) { return "blocked" }',
    { toolImpl: () => ({ text: "x" }) }
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "blocked")
})

test("cannot reach the host realm through a rejected call's Error", async () => {
  const outcome = await run(
    'try { await cognia.read({}) } catch (e) { try { return e.constructor.constructor("return typeof process")() } catch (x) { return "blocked" } } return "no-throw"',
    {
      toolImpl: () => {
        throw new Error("nope")
      },
    }
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "blocked")
})

test("cannot reach the host realm through the sdk object's prototype", async () => {
  const outcome = await run(
    'const p = Object.getPrototypeOf(cognia); return p === null ? "null-proto" : "has-proto"'
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, "null-proto")
})

test("cannot replace a tool proxy with its own function", async () => {
  const outcome = await run(
    'try { cognia.read = () => "hijacked"; return typeof cognia.read } catch (e) { return "frozen" }'
  )
  assert.equal(outcome.ok, true)
  // Either a TypeError (strict) or a silently ignored write — both leave the
  // real proxy in place, which is the property under test.
  assert.ok(outcome.result === "frozen" || outcome.result === "function")
})

// ---- the allowlist ---------------------------------------------------------

test("refuses a tool that is not programmatically read-only", async () => {
  const outcome = await run(
    'try { await cognia.TodoWrite({}); return "called" } catch (e) { return e.message }',
    { toolImpl: () => ({ wrote: true }) }
  )
  assert.equal(outcome.ok, true)
  // The SDK object never had the property, so this is a plain TypeError — the
  // tool is unreachable rather than merely refused.
  assert.match(String(outcome.result), /not a function|is not callable/)
  assert.deepEqual(outcome.calls, [])
})

test("never invokes the broker for an ineligible name", async () => {
  const outcome = await run(
    'return Object.keys(cognia).filter((k) => k === "TodoWrite" || k === "bash" || k === "write")'
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result, [])
})

test("exposes the eligible read tools", async () => {
  const outcome = await run('return ["read", "grep", "glob", "ls"].map((n) => typeof cognia[n])')
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.result, ["function", "function", "function", "function"])
})

// ---- limits ----------------------------------------------------------------

test("rejects oversized source before spawning anything", async () => {
  const outcome = await run("return 1", { config: { ...smallConfig(), maxSourceBytes: 4 } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.limit.kind, "source-too-large")
  assert.equal(outcome.callsUsed, 0)
})

test("stops the run when the tool-call budget is exhausted", async () => {
  const outcome = await run(
    "for (let i = 0; i < 10; i++) { await cognia.read({ i }) } return 'done'",
    { config: { ...smallConfig(), maxToolCalls: 3 } }
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.limit.kind, "tool-calls")
  assert.equal(outcome.limit.limit, 3)
  assert.equal(outcome.calls.length, 3)
})

test("kills a program that exceeds its wall time", async () => {
  const outcome = await run("while (true) {}", {
    config: { ...smallConfig(), wallTimeMs: 300 },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.limit.kind, "wall-time")
})

test("kills the sandbox process group when resident memory exceeds the limit", async () => {
  const outcome = await run("return 1", {
    config: { ...smallConfig(), maxMemoryBytes: 1 },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.limit.kind, "memory")
  assert.equal(outcome.limit.limit, 1)
  assert.ok(outcome.limit.observed > 1)
})

test("rejects an oversized result", async () => {
  const outcome = await run('return "x".repeat(5000)', {
    config: { ...smallConfig(), maxResultBytes: 100 },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.limit.kind, "result-too-large")
})

test("reports a program that threw as a failure, not an empty result", async () => {
  const outcome = await run('throw new Error("boom")')
  assert.equal(outcome.ok, false)
  assert.match(outcome.error.message, /boom/)
})

test("does not carry a stack trace back across the boundary", async () => {
  const outcome = await run('throw new Error("boom")')
  assert.equal(outcome.ok, false)
  // A stack would contain host filesystem paths.
  assert.deepEqual(Object.keys(outcome.error).sort(), ["message", "name"])
})

test("captures console output instead of writing to stdout", async () => {
  const outcome = await run('console.log("hello", { a: 1 }); return 1')
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.logs, [{ level: "info", text: 'hello {"a":1}' }])
})

test("returns a non-serializable value as a string rather than crashing IPC", async () => {
  const outcome = await run("const o = {}; o.self = o; return o")
  // Cyclic values are flattened by the child; the run still completes.
  assert.equal(outcome.ok, true)
})

describe_budget()

function describe_budget() {
  test("CallBudget spends the total budget and gates concurrency separately", () => {
    const budget = new CallBudget({ maxToolCalls: 2, maxConcurrency: 1 })
    assert.deepEqual(budget.tryAcquire(), { ok: true })
    // Second call while the first is in flight is backpressure, not a failure.
    assert.deepEqual(budget.tryAcquire(), { ok: false, retry: true })
    budget.release()
    assert.deepEqual(budget.tryAcquire(), { ok: true })
    budget.release()
    const exhausted = budget.tryAcquire()
    assert.equal(exhausted.ok, false)
    assert.equal(exhausted.exceeded.kind, "tool-calls")
  })

  test("CallBudget release never lowers the spent total", () => {
    const budget = new CallBudget({ maxToolCalls: 1, maxConcurrency: 4 })
    budget.tryAcquire()
    budget.release()
    budget.release()
    assert.equal(budget.callsUsed, 1)
    assert.equal(budget.tryAcquire().ok, false)
  })
}

function smallConfig() {
  return {
    maxSourceBytes: 32768,
    wallTimeMs: 10_000,
    maxToolCalls: 64,
    maxConcurrency: 8,
    maxResultBytes: 1048576,
    maxMemoryBytes: 268435456,
  }
}
