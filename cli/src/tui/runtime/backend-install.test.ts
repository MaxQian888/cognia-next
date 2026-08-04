/** @jest-environment node */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import {
  INSTALL_PLANS,
  pickInstallMethod,
  resolveInstallPlan,
  runInstall,
  type InstallMethod,
} from "./backend-install"

describe("resolveInstallPlan", () => {
  it("maps native-binary agents to their official install methods", () => {
    expect(resolveInstallPlan("claude-agent-acp")?.methods[0]?.display).toBe(
      "npm install -g @agentclientprotocol/claude-agent-acp"
    )
    expect(resolveInstallPlan("codex")?.methods.map((m) => m.kind)).toEqual(["npm", "brew"])
    expect(resolveInstallPlan("copilot")?.methods[0]?.display).toBe(
      "npm install -g @github/copilot"
    )
    expect(resolveInstallPlan("droid")?.methods[0]?.display).toBe(
      "curl -fsSL https://app.factory.ai/cli | sh"
    )
    expect(resolveInstallPlan("cursor-agent")?.methods[0]?.command).toBe("bash")
  })

  it("keeps sign-in-required and Node-only agents docs-only", () => {
    expect(resolveInstallPlan("kiro-cli")?.methods).toEqual([])
    expect(resolveInstallPlan("kiro-cli")?.docsUrl).toContain("kiro.dev")
    expect(resolveInstallPlan("npx")?.methods).toEqual([])
  })

  it("returns undefined for an unknown or absent command", () => {
    expect(resolveInstallPlan("totally-unknown")).toBeUndefined()
    expect(resolveInstallPlan(undefined)).toBeUndefined()
  })

  it("only requires prerequisites the method actually uses", () => {
    expect(INSTALL_PLANS.codex.methods[0].requires).toEqual(["npm"])
    expect(INSTALL_PLANS.codex.methods[1].requires).toEqual(["brew"])
    expect(INSTALL_PLANS.droid.methods[0].requires).toEqual(["curl", "sh"])
    expect(INSTALL_PLANS["cursor-agent"].methods[0].requires).toEqual(["curl", "bash"])
  })
})

describe("pickInstallMethod", () => {
  const plan = INSTALL_PLANS.codex

  it("picks the first method whose prerequisites are all present", async () => {
    // npm absent, brew present → the brew method is chosen.
    const method = await pickInstallMethod(plan, async (cmd) => cmd === "brew")
    expect(method?.kind).toBe("brew")
  })

  it("prefers the earlier method when several are available", async () => {
    const method = await pickInstallMethod(plan, async () => true)
    expect(method?.kind).toBe("npm")
  })

  it("returns undefined when no prerequisite is satisfied", async () => {
    expect(await pickInstallMethod(plan, async () => false)).toBeUndefined()
    // Docs-only plan → never picks anything.
    expect(await pickInstallMethod(INSTALL_PLANS["kiro-cli"], async () => true)).toBeUndefined()
  })

  it("requires EVERY prerequisite of a curl method, not just one", async () => {
    // curl present but the shell missing → the curl method is skipped.
    const method = await pickInstallMethod(INSTALL_PLANS.droid, async (cmd) => cmd === "curl")
    expect(method).toBeUndefined()
  })
})

describe("runInstall", () => {
  const method: InstallMethod = {
    kind: "npm",
    label: "npm",
    display: "npm install -g @openai/codex",
    command: "npm",
    args: ["install", "-g", "@openai/codex"],
    requires: ["npm"],
  }

  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    return child
  }

  it("streams output lines and resolves ok on a zero exit", async () => {
    const child = fakeChild()
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const lines: string[] = []
    const run = runInstall({ method, spawnFn, onLine: (line) => lines.push(line) })
    child.stdout.write("added 1 package\n")
    child.stderr.write("npm warn deprecated foo\n")
    // Let the readline interfaces flush before the process exits.
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", 0, null)
    await expect(run).resolves.toEqual({ ok: true, exitCode: 0, signal: null })
    expect(lines).toEqual(["added 1 package", "npm warn deprecated foo"])
  })

  it("resolves not-ok on a non-zero exit", async () => {
    const child = fakeChild()
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const run = runInstall({ method, spawnFn })
    child.emit("exit", 1, null)
    await expect(run).resolves.toEqual({ ok: false, exitCode: 1, signal: null })
  })

  it("terminates the installer process when the abort signal fires", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid: number; kill: jest.Mock }
    child.pid = 123
    child.kill = jest.fn(() => true)
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const killProcessTree = jest.fn((target: typeof child) => target.kill("SIGTERM"))
    const controller = new AbortController()
    const run = runInstall({ method, spawnFn, signal: controller.signal, killProcessTree })

    controller.abort()
    child.emit("exit", null, "SIGTERM")

    await expect(run).resolves.toEqual({ ok: false, exitCode: null, signal: "SIGTERM" })
    expect(killProcessTree).toHaveBeenCalledWith(child)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("treats a spawn error as a failed install, not a throw", async () => {
    const child = fakeChild()
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const lines: string[] = []
    const run = runInstall({ method, spawnFn, onLine: (line) => lines.push(line) })
    child.emit("error", new Error("spawn npm ENOENT"))
    await expect(run).resolves.toEqual({ ok: false, exitCode: null, signal: null })
    expect(lines).toContain("spawn npm ENOENT")
  })

  it("returns a failed result when spawn throws synchronously", async () => {
    const spawnFn = jest.fn(() => {
      throw new Error("boom")
    }) as unknown as typeof import("node:child_process").spawn
    await expect(runInstall({ method, spawnFn })).resolves.toEqual({
      ok: false,
      exitCode: null,
      signal: null,
    })
  })

  it("passes an explicit env and cwd through to the spawner", async () => {
    const child = fakeChild()
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const run = runInstall({
      method,
      spawnFn,
      env: { NODE_ENV: "test", PATH: "/x" } as NodeJS.ProcessEnv,
      cwd: "/work",
    })
    child.emit("exit", 0, null)
    await run
    expect(spawnFn).toHaveBeenCalledWith(
      "npm",
      method.args,
      expect.objectContaining({ cwd: "/work", env: { NODE_ENV: "test", PATH: "/x" } })
    )
  })

  it("stringifies a non-Error emitted on the child", async () => {
    const child = fakeChild()
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const lines: string[] = []
    const run = runInstall({ method, spawnFn, onLine: (line) => lines.push(line) })
    child.emit("error", "raw-string-error")
    await expect(run).resolves.toEqual({ ok: false, exitCode: null, signal: null })
    expect(lines).toContain("raw-string-error")
  })

  it("tolerates a child missing its stdout/stderr streams", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null }
    child.stdout = null
    child.stderr = null
    const spawnFn = jest.fn(() => child) as unknown as typeof import("node:child_process").spawn
    const run = runInstall({ method, spawnFn })
    child.emit("exit", 0, null)
    await expect(run).resolves.toEqual({ ok: true, exitCode: 0, signal: null })
  })

  it("spawns for real with the default runner and enriched PATH", async () => {
    // No `spawnFn` / `env` → exercises the default node spawn and the
    // enriched-PATH env, end to end, with a trivial process.
    const result = await runInstall({
      method: {
        kind: "npm",
        label: "node",
        display: "node -e",
        command: process.execPath,
        args: ["-e", "process.stdout.write('ok\\n')"],
        requires: [],
      },
      onLine: () => {},
    })
    expect(result).toEqual({ ok: true, exitCode: 0, signal: null })
  })
})
