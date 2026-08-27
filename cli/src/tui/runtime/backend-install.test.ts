/** @jest-environment node */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { EXTERNAL_AGENT_RUNTIMES, findRuntimeById } from "@/lib/ai/agent/external/runtime-catalog"

import {
  INSTALL_PLANS,
  installOfferFor,
  pickInstallMethod,
  resolveInstallPlan,
  runInstall,
  type InstallMethod,
  type InstallPlan,
  type RunInstallDeps,
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
    ownership: "user-managed",
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
    const killProcessTree: NonNullable<RunInstallDeps["killProcessTree"]> = jest.fn((target) => {
      target.kill("SIGTERM")
    })
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
        ownership: "user-managed",
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

describe("catalog reconciliation", () => {
  it("binds every agent plan to a runtime the catalog governs", () => {
    // A plan that installs something the catalog does not describe is an
    // ungoverned install path hiding behind a governed-looking UI.
    const unknown = Object.values(INSTALL_PLANS)
      .filter((plan) => plan.runtimeId && !findRuntimeById(plan.runtimeId))
      .map((plan) => `${plan.command} -> ${plan.runtimeId}`)
    expect(unknown).toEqual([])
  })

  it("leaves only a non-runtime prerequisite unbound", () => {
    const unbound = Object.values(INSTALL_PLANS).filter((plan) => !plan.runtimeId)
    // Node provides `npx`; it is a prerequisite, not an agent runtime.
    expect(unbound.map((plan) => plan.command)).toEqual(["npx"])
  })

  it("offers an install plan for every runtime that launches its own binary", () => {
    // The direction that matters, and the one that was missing: catalog -> plans.
    // The two existing reconciliation tests both walk plans -> catalog, so a
    // runtime with NO plan at all was invisible to them. That is exactly how
    // native Pi shipped with `resolveInstallPlan("pi") === undefined`, leaving
    // a missing `pi` with neither an install offer nor a docs link.
    //
    // `npx` runtimes are excluded on purpose: they resolve themselves on every
    // start, so the only thing to install is Node, which has its own entry.
    const ownBinary = EXTERNAL_AGENT_RUNTIMES.filter(
      (entry) => entry.systemCommand && entry.systemCommand !== "npx"
    )
    // Guard the walk itself: an empty catalog read would make the assertion
    // below pass while checking nothing.
    expect(ownBinary.length).toBeGreaterThanOrEqual(8)

    const uncovered = ownBinary
      .filter((entry) => !INSTALL_PLANS[entry.systemCommand as string])
      .map((entry) => `${entry.runtimeId} (${entry.systemCommand})`)
    expect(uncovered).toEqual([])
  })

  it("points each plan at the runtime that actually launches its command", () => {
    // A plan may be docs-only, but it must not claim a runtime whose
    // `systemCommand` is something else — that would install the wrong binary.
    const mismatched = Object.values(INSTALL_PLANS)
      .filter((plan) => plan.runtimeId)
      .filter((plan) => {
        const entry = findRuntimeById(plan.runtimeId as string)
        return entry ? entry.systemCommand !== plan.command : false
      })
      .map((plan) => `${plan.command} -> ${plan.runtimeId}`)
    expect(mismatched).toEqual([])
  })

  it("marks every global install method as user-managed", () => {
    for (const plan of Object.values(INSTALL_PLANS)) {
      for (const method of plan.methods) {
        // `npm install -g`, brew and vendor curl scripts all install outside
        // any root Cognia owns: no receipt, no verification, no rollback.
        expect(method.ownership).toBe("user-managed")
      }
    }
  })
})

describe("installOfferFor", () => {
  const plan: InstallPlan = {
    command: "droid",
    runtimeId: "droid",
    name: "Factory Droid",
    methods: [
      {
        kind: "curl",
        ownership: "user-managed",
        label: "sh installer",
        display: "curl -fsSL https://example.test | sh",
        command: "sh",
        args: ["-c", "curl -fsSL https://example.test | sh"],
        requires: ["curl", "sh"],
      },
    ],
    docsUrl: "https://docs.example.test",
  }

  it("hands off to the user's own package manager when nothing is pinned", () => {
    const offer = installOfferFor(plan)
    expect(offer.ownership).toBe("user-managed")
    expect(offer.methods).toHaveLength(1)
    expect(offer.managedVersion).toBeUndefined()
  })

  it("prefers the catalog's docs URL over the plan's", () => {
    // The catalog is the source; a plan's copy is a convenience that can drift.
    const offer = installOfferFor(plan)
    expect(offer.docsUrl).toBe(findRuntimeById("droid")?.docsUrl)
  })

  it("falls back to the plan's docs URL for an unbound prerequisite", () => {
    const offer = installOfferFor({
      command: "npx",
      name: "Node.js",
      methods: [],
      docsUrl: "https://nodejs.org/en/download",
    })
    expect(offer.ownership).toBe("user-managed")
    expect(offer.docsUrl).toBe("https://nodejs.org/en/download")
  })

  it("reports an unknown runtime as user-managed rather than crashing", () => {
    const offer = installOfferFor({ ...plan, runtimeId: "ghost" })
    expect(offer.ownership).toBe("user-managed")
    expect(offer.docsUrl).toBe("https://docs.example.test")
  })
})
