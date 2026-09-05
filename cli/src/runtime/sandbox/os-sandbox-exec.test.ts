import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { MicrovmExecPayload } from "@cognia/plugin-sdk/api/sandbox"

import { __resetOsSandboxBridgeForTesting, setOsSandboxExec } from "@/lib/sandbox/os-exec-bridge"
import {
  __resetSandboxSessionRuntimeForTesting,
  HOST_FALLBACK_RUNTIME_REF,
  sandboxSessionRuntime,
} from "@/lib/sandbox/session-runtime"

import {
  createNodeOsSandboxExecutor,
  findSandboxExecBinary,
  formatSandboxError,
  MAX_ENVELOPE_BYTES,
  sandboxExecUnavailableMessage,
  SANDBOX_EXEC_BASE_NAME,
  type SandboxExecChild,
  type SandboxExecSpawn,
} from "./os-sandbox-exec"

interface FakeChildControls {
  emitStdout(text: string): void
  emitStderr(text: string): void
  close(code: number | null): void
  fail(error: Error): void
  killed: NodeJS.Signals[]
  stdinChunks: string[]
  stdinEnded: boolean
}

function fakeSpawn(): {
  spawn: SandboxExecSpawn
  calls: Array<{ binary: string; args: string[] }>
  last(): FakeChildControls
} {
  const calls: Array<{ binary: string; args: string[] }> = []
  let controls: FakeChildControls | null = null
  const spawn: SandboxExecSpawn = (binary, args) => {
    calls.push({ binary, args: [...args] })
    const stdoutHandlers: Array<(c: Buffer | string) => void> = []
    const stderrHandlers: Array<(c: Buffer | string) => void> = []
    let onClose: ((code: number | null) => void) | null = null
    let onError: ((err: Error) => void) | null = null
    const killed: NodeJS.Signals[] = []
    const stdinChunks: string[] = []
    const state = { stdinEnded: false }

    const child: SandboxExecChild = {
      stdin: {
        write: (chunk) => {
          stdinChunks.push(chunk)
        },
        end: () => {
          state.stdinEnded = true
        },
      },
      stdout: { on: (_e, cb) => stdoutHandlers.push(cb) },
      stderr: { on: (_e, cb) => stderrHandlers.push(cb) },
      on: (event, cb) => {
        if (event === "close") onClose = cb as (code: number | null) => void
        else onError = cb as (err: Error) => void
      },
      kill: (signal) => {
        killed.push(signal ?? "SIGTERM")
      },
    }
    controls = {
      emitStdout: (text) => stdoutHandlers.forEach((h) => h(text)),
      emitStderr: (text) => stderrHandlers.forEach((h) => h(text)),
      close: (code) => onClose?.(code),
      fail: (error) => onError?.(error),
      killed,
      stdinChunks,
      get stdinEnded() {
        return state.stdinEnded
      },
    }
    return child
  }
  return { spawn, calls, last: () => controls! }
}

const payload = (timeout = 5): MicrovmExecPayload => ({
  tool: "sandbox_bash",
  command: { argv: ["bash", "-lc", "true"], cwd: "/w", env: {}, stdin: null, timeout },
  request: {
    writable: ["/w"],
    readable: [],
    targetFiles: [],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off",
    networkHosts: [],
  },
})

const OK_ENVELOPE = JSON.stringify({
  ok: true,
  result: { exit_code: 0, stdout: "hi\n", stderr: "", duration: 0, timed_out: false },
})

describe("formatSandboxError", () => {
  it("reproduces the Rust error strings the desktop already shows", () => {
    // The plugin surfaces these verbatim to the model, so a refusal must read
    // identically on both rails.
    expect(formatSandboxError({ kind: "invalid_policy", reason: "no writable dir" })).toBe(
      "invalid policy: no writable dir"
    )
    expect(formatSandboxError({ kind: "setup_required", reason: "runner missing" })).toBe(
      "sandbox setup required: runner missing"
    )
    expect(formatSandboxError({ kind: "unavailable", reason: "no bwrap" })).toBe(
      "sandbox unavailable: no bwrap"
    )
    expect(formatSandboxError({ kind: "backend_failed", reason: "spawn failed" })).toBe(
      "backend failed: spawn failed"
    )
    expect(formatSandboxError({ kind: "timeout", seconds: 30 })).toBe("timeout after 30s")
  })

  it("still says something when the envelope carries no recognisable error", () => {
    expect(formatSandboxError(undefined)).toMatch(/without a reason/)
    expect(formatSandboxError({ reason: "raw" })).toBe("raw")
  })
})

describe("findSandboxExecBinary", () => {
  it("returns the first executable candidate", () => {
    expect(findSandboxExecBinary(["/a", "/b", "/c"], (c) => c === "/b")).toBe("/b")
  })

  it("returns undefined when nothing is executable", () => {
    expect(findSandboxExecBinary(["/a"], () => false)).toBeUndefined()
  })
})

describe("createNodeOsSandboxExecutor without a helper binary", () => {
  it("refuses the call instead of running it unconfined", async () => {
    const executor = createNodeOsSandboxExecutor({ binary: undefined, devCheckout: false })
    await expect(executor.execute(payload())).rejects.toThrow(sandboxExecUnavailableMessage(false))
  })

  it("probes as unconfined and explains why", async () => {
    const executor = createNodeOsSandboxExecutor({ binary: undefined, devCheckout: true })
    const status = await executor.probe()
    expect(status.confined).toBe(false)
    expect(status.detail).toContain(SANDBOX_EXEC_BASE_NAME)
    // The build hint belongs only to a checkout, where it is actionable.
    expect(status.detail).toContain("pnpm cli:sandbox-exec:build")
  })

  it("omits the maintainer build hint for an installed CLI", () => {
    expect(sandboxExecUnavailableMessage(false)).not.toContain("pnpm")
  })
})

describe("createNodeOsSandboxExecutor", () => {
  it("sends the payload on stdin and returns the result", async () => {
    const { spawn, calls, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().emitStdout(OK_ENVELOPE)
    last().close(0)
    await expect(promise).resolves.toEqual({
      exit_code: 0,
      stdout: "hi\n",
      stderr: "",
      duration: 0,
      timed_out: false,
    })
    expect(calls[0]).toEqual({ binary: "/bin/helper", args: ["--exec"] })
    // Never argv: the payload carries the caller's environment, and argv is
    // readable by any process on the machine.
    expect(JSON.parse(last().stdinChunks.join(""))).toEqual({
      ...payload(),
      command: { ...payload().command, env: process.env.PATH ? { PATH: process.env.PATH } : {} },
    })
    expect(last().stdinEnded).toBe(true)
  })

  it("throws the structured refusal when the envelope says ok:false", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().emitStdout(
      JSON.stringify({ ok: false, error: { kind: "invalid_policy", reason: "no writable dir" } })
    )
    last().close(0)
    await expect(promise).rejects.toThrow("invalid policy: no writable dir")
  })

  it("throws rather than resolving when the helper writes nothing", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().emitStderr("boom")
    last().close(2)
    await expect(promise).rejects.toThrow(/returned no response: boom/)
  })

  it("throws on an unparseable envelope", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().emitStdout("not json")
    last().close(0)
    await expect(promise).rejects.toThrow(/unparseable/)
  })

  it("surfaces a spawn failure as an actionable error", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().fail(new Error("ENOENT"))
    await expect(promise).rejects.toThrow(/failed to start cognia-sandbox-exec: ENOENT/)
  })

  it("kills a helper that overruns the envelope ceiling", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.execute(payload())
    last().emitStdout("x".repeat(MAX_ENVELOPE_BYTES + 1))
    last().close(null)
    await expect(promise).rejects.toThrow(/more than \d+ bytes/)
    expect(last().killed).toContain("SIGKILL")
  })

  it("kills a wedged helper after the policy timeout plus the grace", async () => {
    jest.useFakeTimers()
    try {
      const { spawn, last } = fakeSpawn()
      const executor = createNodeOsSandboxExecutor({
        binary: "/bin/helper",
        spawn,
        supervisorGraceMs: 1_000,
      })
      const promise = executor.execute(payload(2))
      const assertion = expect(promise).rejects.toThrow(/did not answer within 3000ms/)
      jest.advanceTimersByTime(3_001)
      await assertion
      expect(last().killed).toContain("SIGKILL")
    } finally {
      jest.useRealTimers()
    }
  })

  it("sets no supervisor deadline when the policy asked for none", async () => {
    jest.useFakeTimers()
    try {
      const { spawn, last } = fakeSpawn()
      const executor = createNodeOsSandboxExecutor({
        binary: "/bin/helper",
        spawn,
        supervisorGraceMs: 1_000,
      })
      // `timeout: 0` means "no deadline" on the Rust side. Killing a long build
      // the policy deliberately left unbounded would be the supervisor
      // overriding the policy.
      const promise = executor.execute(payload(0))
      jest.advanceTimersByTime(600_000)
      expect(last().killed).toEqual([])
      last().emitStdout(OK_ENVELOPE)
      last().close(0)
      await expect(promise).resolves.toMatchObject({ exit_code: 0 })
    } finally {
      jest.useRealTimers()
    }
  })

  it("probes through the helper's --probe mode", async () => {
    const { spawn, calls, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.probe()
    last().emitStdout(
      JSON.stringify({
        ok: true,
        probe: { backend: "macos-sandbox-exec", confined: true, detail: "ok" },
      })
    )
    last().close(0)
    await expect(promise).resolves.toEqual({
      confined: true,
      backend: "macos-sandbox-exec",
      detail: "ok",
    })
    expect(calls[0]?.args).toEqual(["--probe"])
  })

  it("reports unconfined when the probe itself fails", async () => {
    const { spawn, last } = fakeSpawn()
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const promise = executor.probe()
    last().fail(new Error("ENOENT"))
    const status = await promise
    expect(status.confined).toBe(false)
    expect(status.detail).toContain("ENOENT")
  })

  it("runs concurrent calls in separate helper processes", async () => {
    // Each call owns its own process and shares no state, so two tool calls in
    // flight cannot read each other's output.
    const calls: Array<{ binary: string; args: string[] }> = []
    const children: FakeChildControls[] = []
    const spawn: SandboxExecSpawn = (binary, args) => {
      const single = fakeSpawn()
      const child = single.spawn(binary, args)
      calls.push({ binary, args: [...args] })
      children.push(single.last())
      return child
    }
    const executor = createNodeOsSandboxExecutor({ binary: "/bin/helper", spawn })
    const first = executor.execute(payload())
    const second = executor.execute(payload())
    children[1].emitStdout(
      JSON.stringify({
        ok: true,
        result: { exit_code: 7, stdout: "second", stderr: "", duration: 0, timed_out: false },
      })
    )
    children[1].close(0)
    children[0].emitStdout(OK_ENVELOPE)
    children[0].close(0)
    await expect(first).resolves.toMatchObject({ stdout: "hi\n" })
    await expect(second).resolves.toMatchObject({ exit_code: 7, stdout: "second" })
    expect(calls).toHaveLength(2)
  })
})

/**
 * The whole path, end to end: the session runtime, the bridge, this executor,
 * the helper binary, and the kernel. Everything above asserts on a fake child,
 * which proves the mapping and nothing about whether a command is confined.
 *
 * Skipped where the helper has not been built (`pnpm cli:sandbox-exec:build`),
 * which is honest about what was checked rather than passing on a stub.
 */
const binary = findSandboxExecBinary()
const maybe = binary ? describe : describe.skip

maybe("end to end through the real helper and the real kernel", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sbx-e2e-"))
  beforeAll(() => setOsSandboxExec(createNodeOsSandboxExecutor()))
  afterAll(() => {
    __resetOsSandboxBridgeForTesting()
    __resetSandboxSessionRuntimeForTesting()
    fs.rmSync(ws, { recursive: true, force: true })
  })

  const run = (script: string, writable = [ws]) =>
    sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, {
      tool: "sandbox_bash",
      command: {
        argv: ["/bin/bash", "-c", script],
        cwd: ws,
        env: { PATH: "/usr/bin:/bin", HOME: ws },
        stdin: null,
        timeout: 30,
      },
      request: {
        writable,
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 30,
        maxMemoryMb: 1024,
        network: "off",
        networkHosts: [],
      },
    })

  it("runs a command and returns its output", async () => {
    const r = await run("echo end-to-end")
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain("end-to-end")
  })

  it("writes inside the workspace", async () => {
    const r = await run(`echo written > ${ws}/f.txt && cat ${ws}/f.txt`)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain("written")
  })

  it("refuses a write outside the workspace", async () => {
    const outside = path.join(os.homedir(), "cognia-sbx-should-not-exist.txt")
    const r = await run(`echo pwned > ${outside}`)
    expect(r.exit_code).not.toBe(0)
    expect(fs.existsSync(outside)).toBe(false)
  })

  it("refuses to read a credential store", async () => {
    const r = await run(`ls ${path.join(os.homedir(), ".ssh")} 2>&1 || true`)
    expect(`${r.stdout}${r.stderr}`).toMatch(/not permitted|No such file/)
  })

  it("has no network when the policy says off", async () => {
    const r = await run("getent hosts example.com 2>&1 || echo NO-DNS")
    expect(`${r.stdout}${r.stderr}`).toMatch(/NO-DNS|not permitted|not found/)
  })

  it("refuses a forbidden writable root before spawning", async () => {
    await expect(run("echo x", ["/etc"])).rejects.toThrow(/protected system/)
  })

  it("reports confinement through the same bridge the status RPC reads", async () => {
    const { __resetCodeSandboxStatus, codeSandboxStatus } =
      await import("@/lib/ai/code-mode/sandbox-status")
    __resetCodeSandboxStatus()
    const status = await codeSandboxStatus()
    expect(status.confined).toBe(true)
    expect(status.backend).toMatch(/sandbox-exec|bwrap|cognia-sandbox/)
  })
})
