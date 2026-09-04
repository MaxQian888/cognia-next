import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  __resetSandboxSessionRuntimeForTesting,
  HOST_FALLBACK_RUNTIME_REF,
  sandboxSessionRuntime,
  SandboxSessionRuntime,
  type SandboxSessionRuntimeDeps,
} from "./session-runtime"
import { SandboxCapabilityError } from "./lifecycle-contract"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"
import type { MicrovmExecPayload } from "./microvm-bridge"
import { __resetMicrovmBridgeForTesting, setMicrovmExec } from "./microvm-bridge"
import { __resetOsSandboxBridgeForTesting, setOsSandboxExec } from "./os-exec-bridge"

const payload = {
  tool: "sandbox_bash",
  command: {
    argv: ["bash", "-c", "pwd"],
    cwd: "/workspace",
    env: {},
    stdin: null,
    timeout: 30,
  },
  request: {
    writable: ["/workspace"],
    readable: [],
    targetFiles: [],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off" as const,
    networkHosts: [],
  },
}

function createDeps(): jest.Mocked<SandboxSessionRuntimeDeps> {
  return {
    getConnection: jest.fn(),
    getMicrovmAdapter: jest.fn(() => null),
    executeOsSandbox: jest.fn(async (_payload: MicrovmExecPayload) => ({
      exit_code: 0,
      stdout: "/workspace\n",
      stderr: "",
      duration: 1,
      timed_out: false,
    })),
    makeRef: jest.fn(() => "sandbox-runtime:test-ref"),
    recordAudit: jest.fn(async () => undefined),
  }
}

function runningConnection(
  capabilities = defaultSandboxCapabilities("docker", "computer-server")
): SandboxConnectionRow {
  return {
    id: "connection-1",
    name: "Desktop",
    provider: "docker",
    driver: "computer-server",
    config: {
      provider: "docker",
      image: "example/cua:latest",
      host: "127.0.0.1",
      port: 49152,
    },
    state: "running",
    capabilities,
    lastHealthStatus: "ok",
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("SandboxSessionRuntime", () => {
  afterEach(() => {
    __resetMicrovmBridgeForTesting()
    jest.mocked(transport.call).mockReset()
  })

  it("reuses the default OS/local binding without touching remote connections", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)
    const input = {
      sessionId: "session-1",
      binding: { shellTier: "os", computerTarget: "local" } as const,
      policy: null as SandboxResourcePolicy | null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }

    const first = await runtime.bindSession(input)
    const second = await runtime.bindSession(input)
    const result = await runtime.executeSandbox(first, payload)

    expect(second).toBe(first)
    expect(deps.getConnection).not.toHaveBeenCalled()
    expect(deps.executeOsSandbox).toHaveBeenCalledTimes(1)
    expect(result.stdout).toBe("/workspace\n")
  })

  it("serves callers with no send envelope on the host OS tier", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)

    // Workflow nodes, plan steps, External Bridge orchestration and the CLI
    // rail have no send to carry a ref. They must keep working, on the host,
    // which is exactly where they ran before the runtime existed.
    await expect(runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)).resolves.toMatchObject(
      { exit_code: 0 }
    )
    await expect(
      runtime.decorateComputerUseContext(HOST_FALLBACK_RUNTIME_REF, { surface: "computerUse" })
    ).resolves.toEqual({ surface: "computerUse" })
    expect(deps.getConnection).not.toHaveBeenCalled()

    // …and no session release can strand it.
    await runtime.releaseSession("session-1")
    await expect(runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)).resolves.toMatchObject(
      { exit_code: 0 }
    )
  })

  it("decorates bound Computer Use with the live connection and frozen confinement", async () => {
    const deps = createDeps()
    deps.getConnection.mockResolvedValue(runningConnection())
    const runtime = new SandboxSessionRuntime(deps)
    const ref = await runtime.bindSession({
      sessionId: "session-1",
      binding: {
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "connection-1",
      },
      policy: null,
      confine: { writable: ["/workspace"], network: "off" },
      sandboxEnabled: true,
      computerUseEnabled: true,
      workspaceRoot: "/workspace",
    })

    const context = await runtime.decorateComputerUseContext(ref, {
      surface: "computerUse",
      pluginId: "computer-use",
    })

    expect(deps.getConnection).toHaveBeenCalledTimes(2)
    expect(context).toMatchObject({
      surface: "computerUse",
      sandboxConnectionId: "connection-1",
      sandboxConfine: { writable: ["/workspace"], network: "off" },
    })
  })

  it("keeps bound GUI confinement when sandboxed shell tools are disabled", async () => {
    const deps = createDeps()
    deps.getConnection.mockResolvedValue(runningConnection())
    const runtime = new SandboxSessionRuntime(deps)
    const ref = await runtime.bindSession({
      sessionId: "session-1",
      binding: {
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "connection-1",
      },
      policy: null,
      confine: { writable: ["/workspace"], network: "off" },
      sandboxEnabled: false,
      computerUseEnabled: true,
      workspaceRoot: "/workspace",
    })

    await expect(runtime.decorateComputerUseContext(ref, {})).resolves.toMatchObject({
      sandboxConnectionId: "connection-1",
      sandboxConfine: { writable: ["/workspace"], network: "off" },
    })
  })

  it("fails closed for invalid or missing explicit bindings", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)
    const base = {
      sessionId: "session-1",
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: true,
      workspaceRoot: "/workspace",
    }

    await expect(
      runtime.bindSession({
        ...base,
        binding: { shellTier: "os", computerTarget: "bound" },
      })
    ).rejects.toMatchObject({ code: "invalid-binding" })

    await expect(
      runtime.bindSession({
        ...base,
        binding: {
          shellTier: "os",
          computerTarget: "bound",
          connectionId: "missing",
        },
      })
    ).rejects.toMatchObject({ code: "target-not-found" })
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
  })

  it("enforces surface enablement and keeps local Computer Use local", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)
    const disabledRef = await runtime.bindSession({
      sessionId: "disabled",
      binding: { shellTier: "os", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: false,
      computerUseEnabled: false,
    })

    await expect(runtime.executeSandbox(disabledRef, payload)).rejects.toMatchObject({
      code: "surface-disabled",
    })
    await expect(runtime.decorateComputerUseContext(disabledRef, {})).rejects.toMatchObject({
      code: "surface-disabled",
    })

    const localRef = await runtime.bindSession({
      sessionId: "local-gui",
      binding: { shellTier: "os", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: false,
      computerUseEnabled: true,
    })
    await expect(
      runtime.decorateComputerUseContext(localRef, { pluginId: "computer-use" })
    ).resolves.toEqual({
      pluginId: "computer-use",
    })
    expect(deps.getConnection).not.toHaveBeenCalled()
  })

  it("rejects new microVM binds after unregister while bound owners keep their adapter", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)
    const input = {
      sessionId: "microvm",
      binding: { shellTier: "microvm", computerTarget: "local" } as const,
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }

    await expect(runtime.bindSession(input)).rejects.toMatchObject({ code: "microvm-unavailable" })

    const adapter = {
      preflight: jest.fn(async () => undefined),
      execute: jest.fn(),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const ref = await runtime.bindSession(input)
    expect(adapter.preflight).toHaveBeenCalledWith(ref, "/workspace", "microvm")
    deps.getMicrovmAdapter.mockReturnValue(null)
    adapter.execute.mockResolvedValue({
      exit_code: 0,
      stdout: "remote",
      stderr: "",
      duration: 1,
      timed_out: false,
    })
    await expect(runtime.executeSandbox(ref, payload)).resolves.toMatchObject({ stdout: "remote" })
    await expect(runtime.bindSession({ ...input, sessionId: "new-owner" })).rejects.toMatchObject({
      code: "microvm-unavailable",
    })
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
    expect(deps.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "sandbox",
        processName: "microvm:e2b",
        decision: "allow",
        reason:
          "tier=microvm;provider=e2b;termination=completed;requested_timeout_seconds=30;timeout=false;stdout_truncated=false;stderr_truncated=false;exit_code=0",
      })
    )
  })

  it("audits microVM provider failures without changing the thrown error", async () => {
    const deps = createDeps()
    const failure = new Error("provider disconnected")
    const adapter = {
      preflight: jest.fn(async () => undefined),
      execute: jest.fn(async () => {
        throw failure
      }),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const runtime = new SandboxSessionRuntime(deps)
    const ref = await runtime.bindSession({
      sessionId: "microvm-failure",
      binding: { shellTier: "microvm", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    })

    await expect(runtime.executeSandbox(ref, payload)).rejects.toBe(failure)
    expect(deps.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        error: "provider disconnected",
        reason: expect.stringContaining("termination=provider_error"),
      })
    )
  })

  it("freezes policy intent and applies it to request and path checks", async () => {
    const deps = createDeps()
    const runtime = new SandboxSessionRuntime(deps)
    const writableRoots = ["/workspace"]
    const readableRoots = ["/workspace/read"]
    const networkAllowlist = ["example.com"]
    const ref = await runtime.bindSession({
      sessionId: "policy",
      binding: { shellTier: "os", computerTarget: "local" },
      policy: {
        writableRoots,
        readableRoots,
        network: "allowlist",
        networkAllowlist,
        maxCpuSeconds: 5,
        maxMemoryMb: 64,
      },
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
    })
    writableRoots[0] = "/mutated"
    readableRoots[0] = "/mutated"
    networkAllowlist[0] = "mutated.example"

    expect(
      runtime.clampRequest(ref, {
        ...payload.request,
        writable: ["/workspace/out"],
        maxCpuSeconds: 20,
        maxMemoryMb: 128,
        network: "on",
      })
    ).toMatchObject({
      writable: ["/workspace/out"],
      maxCpuSeconds: 5,
      maxMemoryMb: 64,
      network: "allowlist",
      networkHosts: ["example.com"],
    })
    expect(() => runtime.assertWritablePath(ref, "/workspace/out")).not.toThrow()
    expect(() => runtime.assertWritablePath(ref, "/host/out", "output")).toThrow(
      /output.*outside the configured writable roots/
    )
  })

  it("binds cua-desktop when the connection carries workspace execution", async () => {
    // The tier was withdrawn while a bound desktop could only prove GUI
    // isolation. `docker exec` runs inside the container, so a connection that
    // advertises the capability may now carry shell and file work.
    const deps = createDeps()
    deps.getConnection.mockResolvedValue(
      runningConnection({
        ...defaultSandboxCapabilities("docker", "computer-server"),
        workspaceExec: true,
      })
    )
    const runtime = new SandboxSessionRuntime(deps)

    await expect(
      runtime.bindSession({
        sessionId: "session-1",
        binding: {
          shellTier: "cua-desktop",
          computerTarget: "bound",
          connectionId: "connection-1",
        },
        policy: null,
        confine: null,
        sandboxEnabled: true,
        computerUseEnabled: true,
        workspaceRoot: "/workspace",
      })
    ).resolves.toBeDefined()
    // Whatever happens, it must not have quietly run on this machine.
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
  })

  it("refuses cua-desktop without touching the OS sandbox when the connection cannot carry it", async () => {
    // cua-cloud and lume have no adapter at all, so the refusal is still the
    // whole answer, and it must never fall back to this host.
    const deps = createDeps()
    deps.getConnection.mockResolvedValue(
      runningConnection({
        ...defaultSandboxCapabilities("docker", "computer-server"),
        workspaceExec: false,
      })
    )
    const runtime = new SandboxSessionRuntime(deps)

    await expect(
      runtime.bindSession({
        sessionId: "session-1",
        binding: {
          shellTier: "cua-desktop",
          computerTarget: "bound",
          connectionId: "connection-1",
        },
        policy: null,
        confine: null,
        sandboxEnabled: true,
        computerUseEnabled: true,
        workspaceRoot: "/workspace",
      })
    ).rejects.toBeInstanceOf(SandboxCapabilityError)
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
  })

  it("retires the superseded generation so a tightened ceiling takes effect", async () => {
    const deps = createDeps()
    deps.makeRef
      .mockReturnValueOnce("sandbox-runtime:one")
      .mockReturnValueOnce("sandbox-runtime:two")
    const runtime = new SandboxSessionRuntime(deps)
    const base = {
      sessionId: "session-1",
      binding: { shellTier: "os", computerTarget: "local" } as const,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }
    const first = await runtime.bindSession({ ...base, policy: null })
    const second = await runtime.bindSession({
      ...base,
      policy: { writableRoots: ["/workspace/src"] },
    })

    expect(second).not.toBe(first)
    // The whole point of rebinding is that the NEW ceiling governs. A ref the
    // session has moved off must stop executing, or a queued call still
    // holding it keeps writing under the roots the user just narrowed away.
    await expect(runtime.executeSandbox(first, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
    expect(() => runtime.assertWritablePath(second, "/workspace/other")).toThrow(
      /outside the configured writable roots/
    )
    await expect(runtime.executeSandbox(second, payload)).resolves.toMatchObject({ exit_code: 0 })
    await runtime.releaseSession("session-1")
    await expect(runtime.executeSandbox(second, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
  })

  it("does not re-read the connection when the binding is unchanged", async () => {
    const deps = createDeps()
    deps.makeRef.mockReturnValue("sandbox-runtime:stable")
    deps.getConnection.mockResolvedValue(runningConnection())
    const runtime = new SandboxSessionRuntime(deps)
    const input = {
      sessionId: "session-1",
      binding: {
        shellTier: "os",
        computerTarget: "bound",
        connectionId: "connection-1",
      } as const,
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: true,
      workspaceRoot: "/workspace",
    }

    const first = await runtime.bindSession(input)
    expect(deps.getConnection).toHaveBeenCalledTimes(1)
    // Fifty sends with no settings change must not be fifty Dexie reads.
    for (let i = 0; i < 5; i++) expect(await runtime.bindSession(input)).toBe(first)
    expect(deps.getConnection).toHaveBeenCalledTimes(1)
  })

  it("releases the superseded E2B generation at rebind, not at session close", async () => {
    const deps = createDeps()
    deps.makeRef
      .mockReturnValueOnce("sandbox-runtime:microvm-one")
      .mockReturnValueOnce("sandbox-runtime:microvm-two")
    const adapter = {
      preflight: jest.fn(async (_ownerRef: string, _workspaceRoot?: string) => undefined),
      execute: jest.fn(async (_ownerRef: string, _payload: MicrovmExecPayload) => ({
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        duration: 1,
        timed_out: false,
      })),
      release: jest.fn(async (_ownerRef: string) => undefined),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const runtime = new SandboxSessionRuntime(deps)
    const base = {
      sessionId: "session-1",
      binding: { shellTier: "microvm", computerTarget: "local" } as const,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }
    const first = await runtime.bindSession({ ...base, policy: null })
    const second = await runtime.bindSession({ ...base, policy: { network: "on" } })

    // Retirement is best-effort and deferred a microtask so it cannot fail the
    // bind that already succeeded; let it settle before asserting.
    await Promise.resolve()
    await Promise.resolve()
    expect(adapter.release).toHaveBeenCalledWith(first)
    await expect(runtime.executeSandbox(first, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })

    await runtime.executeSandbox(second, payload)
    expect(adapter.execute.mock.calls.map(([ownerRef]) => ownerRef)).toEqual([second])
    await runtime.releaseSession("session-1")
    expect(adapter.release.mock.calls.map(([ownerRef]) => ownerRef)).toEqual([first, second])
  })

  it("surfaces provider cleanup failure and allows release to be retried", async () => {
    const deps = createDeps()
    const adapter = {
      execute: jest.fn(),
      preflight: jest.fn(async () => undefined),
      release: jest
        .fn<Promise<void>, [string]>()
        .mockRejectedValueOnce(new Error("close failed"))
        .mockResolvedValue(undefined),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const runtime = new SandboxSessionRuntime(deps)
    const ref = await runtime.bindSession({
      sessionId: "session-1",
      binding: { shellTier: "microvm", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    })

    await expect(runtime.releaseSession("session-1")).rejects.toThrow(/close failed/)
    await expect(runtime.executeSandbox(ref, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
    // The next bind retries the cleanup that failed instead of refusing
    // forever — a provider blip must not brick the session id permanently.
    await expect(
      runtime.bindSession({
        sessionId: "session-1",
        binding: { shellTier: "microvm", computerTarget: "local" },
        policy: null,
        confine: null,
        sandboxEnabled: true,
        computerUseEnabled: false,
        workspaceRoot: "/workspace",
      })
    ).resolves.toEqual(expect.any(String))
    expect(adapter.release).toHaveBeenCalledTimes(2)
    // The stranded generation is gone, so the retried ref is the only owner.
    await expect(runtime.releaseSession("session-1")).resolves.toBeUndefined()
    expect(adapter.release).toHaveBeenCalledTimes(3)
  })

  it("keeps a failed rebind retirement in the cleanup ledger for session release", async () => {
    const deps = createDeps()
    deps.makeRef
      .mockReturnValueOnce("sandbox-runtime:old")
      .mockReturnValueOnce("sandbox-runtime:new")
    const adapter = {
      execute: jest.fn(async () => ({
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        duration: 1,
        timed_out: false,
      })),
      preflight: jest.fn(async () => undefined),
      release: jest
        .fn<Promise<void>, [string]>()
        .mockRejectedValueOnce(new Error("retire failed"))
        .mockResolvedValue(undefined),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const runtime = new SandboxSessionRuntime(deps)
    const base = {
      sessionId: "session-1",
      binding: { shellTier: "microvm", computerTarget: "local" } as const,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }

    await runtime.bindSession({ ...base, policy: null })
    await runtime.bindSession({ ...base, policy: { network: "on" } })
    await Promise.resolve()
    await Promise.resolve()

    await expect(runtime.releaseSession("session-1")).resolves.toBeUndefined()
    expect(adapter.release.mock.calls.map(([ownerRef]) => ownerRef)).toEqual([
      "sandbox-runtime:old",
      "sandbox-runtime:old",
      "sandbox-runtime:new",
    ])
  })

  it("keeps releasing the other generations when one provider close fails", async () => {
    const deps = createDeps()
    deps.makeRef
      .mockReturnValueOnce("sandbox-runtime:ok")
      .mockReturnValueOnce("sandbox-runtime:bad")
    let failedOnce = false
    const adapter = {
      execute: jest.fn(),
      preflight: jest.fn(async () => undefined),
      release: jest.fn<Promise<void>, [string]>(async (ownerRef) => {
        if (ownerRef !== "sandbox-runtime:bad" || failedOnce) return
        failedOnce = true
        throw new Error("close failed")
      }),
    }
    deps.getMicrovmAdapter.mockReturnValue(adapter)
    const runtime = new SandboxSessionRuntime(deps)
    const base = {
      sessionId: "session-1",
      binding: { shellTier: "microvm", computerTarget: "local" } as const,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/workspace",
    }
    const healthy = await runtime.bindSession({ ...base, policy: null })
    const stuck = await runtime.bindSession({ ...base, policy: { network: "off" } })

    await expect(runtime.releaseSession("session-1")).rejects.toThrow(/close failed/)

    // `healthy` was already retired when `stuck` superseded it; `stuck` is the
    // only generation release had to reach, and it is retained for retry.
    await expect(runtime.executeSandbox(healthy, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
    await expect(runtime.executeSandbox(stuck, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
    await runtime.releaseSession("session-1")
    expect(adapter.release.mock.calls.map(([ownerRef]) => ownerRef)).toEqual([
      healthy,
      stuck,
      stuck,
    ])
  })

  describe("bindUnplacedSession — a bind that failed is never answered with the host", () => {
    const base = {
      sessionId: "session-1",
      policy: { writableRoots: ["/workspace"], network: "off" } as SandboxResourcePolicy,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: true,
      workspaceRoot: "/workspace",
    }

    it("refuses a non-os shell tier instead of running it on this machine", async () => {
      const deps = createDeps()
      const runtime = new SandboxSessionRuntime(deps)
      const ref = runtime.bindUnplacedSession(
        { ...base, binding: { shellTier: "microvm", computerTarget: "local" } },
        new Error("no live E2B workspace")
      )

      await expect(runtime.executeSandbox(ref, payload)).rejects.toMatchObject({
        code: "placement-unavailable",
      })
      // The refusal is the point: nothing reached the host OS sandbox.
      expect(deps.executeOsSandbox).not.toHaveBeenCalled()
      expect(deps.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deny",
          error: expect.stringContaining("no live E2B workspace"),
          reason: expect.stringContaining("termination=placement_unavailable"),
        })
      )
    })

    it("refuses a bound GUI target instead of driving the local desktop", async () => {
      const deps = createDeps()
      const runtime = new SandboxSessionRuntime(deps)
      const ref = runtime.bindUnplacedSession(
        {
          ...base,
          binding: { shellTier: "os", computerTarget: "bound", connectionId: "connection-1" },
        },
        new Error("connection is stopped")
      )

      await expect(runtime.decorateComputerUseContext(ref, {})).rejects.toMatchObject({
        code: "placement-unavailable",
      })
    })

    it("keeps the resolved ceiling on the host tier the session actually asked for", async () => {
      const deps = createDeps()
      const runtime = new SandboxSessionRuntime(deps)
      const ref = runtime.bindUnplacedSession(
        { ...base, binding: { shellTier: "os", computerTarget: "bound", connectionId: "c1" } },
        new Error("connection is stopped")
      )

      // `os` IS this machine by request, so shell work still runs — but it runs
      // clamped. Falling back to the unpoliced host default threw this away.
      await expect(runtime.executeSandbox(ref, payload)).resolves.toMatchObject({ exit_code: 0 })
      expect(() => runtime.assertWritablePath(ref, "/etc")).toThrow(
        /outside the configured writable roots/
      )
      expect(
        runtime.clampRequest(ref, { ...payload.request, network: "on", networkHosts: ["x"] })
      ).toMatchObject({ network: "off", networkHosts: [] })
    })

    it("lets the next send recover instead of pinning the degraded generation", async () => {
      const deps = createDeps()
      deps.makeRef
        .mockReturnValueOnce("sandbox-runtime:unplaced")
        .mockReturnValueOnce("sandbox-runtime:recovered")
      const runtime = new SandboxSessionRuntime(deps)
      const input = { ...base, binding: { shellTier: "os", computerTarget: "local" } as const }

      const degraded = runtime.bindUnplacedSession(input, new Error("transient"))
      // Same input — the fingerprint fast-path must NOT match the degraded
      // generation, or a one-off failure would never heal.
      const recovered = await runtime.bindSession(input)

      expect(recovered).not.toBe(degraded)
      await expect(runtime.executeSandbox(degraded, payload)).rejects.toMatchObject({
        code: "runtime-released",
      })
    })
  })

  it("allows a session id to bind again after successful release", async () => {
    const deps = createDeps()
    deps.makeRef
      .mockReturnValueOnce("sandbox-runtime:first")
      .mockReturnValueOnce("sandbox-runtime:rebound")
    const runtime = new SandboxSessionRuntime(deps)
    const input = {
      sessionId: "rebound-session",
      binding: { shellTier: "os", computerTarget: "local" } as const,
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
    }

    await runtime.bindSession(input)
    await runtime.releaseSession(input.sessionId)
    await expect(runtime.bindSession(input)).resolves.toBe("sandbox-runtime:rebound")
  })

  it("wires the default singleton to the existing OS transport and microVM registry", async () => {
    jest.mocked(transport.call).mockResolvedValue({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      duration: 1,
      timed_out: false,
    })
    const osRef = await sandboxSessionRuntime.bindSession({
      sessionId: "singleton-os",
      binding: { shellTier: "os", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
    })
    const osPayload = {
      ...payload,
      command: { ...payload.command, stdin: "hello" },
    }

    await expect(sandboxSessionRuntime.executeSandbox(osRef, osPayload)).resolves.toMatchObject({
      stdout: "ok",
    })
    await sandboxSessionRuntime.executeSandbox(osRef, payload)
    expect(transport.call).toHaveBeenCalledWith(
      "sandbox_exec",
      expect.objectContaining({
        command: expect.objectContaining({ stdin: [104, 101, 108, 108, 111] }),
      })
    )

    const adapter = {
      preflight: jest.fn(async () => undefined),
      execute: jest.fn(async () => ({
        exit_code: 0,
        stdout: "remote",
        stderr: "",
        duration: 1,
        timed_out: false,
      })),
      release: jest.fn(async () => undefined),
    }
    setMicrovmExec(adapter)
    const microvmRef = await sandboxSessionRuntime.bindSession({
      sessionId: "singleton-microvm",
      binding: { shellTier: "microvm", computerTarget: "local" },
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/remote/work",
    })
    await sandboxSessionRuntime.releaseSession("singleton-os")
    await sandboxSessionRuntime.releaseSession("singleton-microvm")
    expect(adapter.preflight).toHaveBeenCalledWith(microvmRef, "/remote/work", "singleton-microvm")
    expect(adapter.release).toHaveBeenCalledWith(microvmRef)
  })

  it("exposes a test reset so singleton bindings cannot leak between tests", async () => {
    const input = {
      sessionId: "leaky-session",
      binding: { shellTier: "os", computerTarget: "local" } as const,
      policy: null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
    }
    const first = await sandboxSessionRuntime.bindSession(input)

    __resetSandboxSessionRuntimeForTesting()

    // Without the reset the fingerprint fast-path would hand back `first` and
    // the next test would silently exercise this test's record.
    expect(await sandboxSessionRuntime.bindSession(input)).not.toBe(first)
    // The host fallback survives the reset — it is not a session binding.
    jest.mocked(transport.call).mockResolvedValue({ exit_code: 0, stdout: "ok" })
    await expect(
      sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    ).resolves.toMatchObject({ stdout: "ok" })
    __resetSandboxSessionRuntimeForTesting()
  })
  describe("rebindWorkspaceRoot — the placement follows the cwd the turn resolved to", () => {
    const baseInput = {
      sessionId: "session-rebind",
      binding: { shellTier: "os", computerTarget: "local" } as const,
      policy: null as SandboxResourcePolicy | null,
      confine: null,
      sandboxEnabled: true,
      computerUseEnabled: false,
      workspaceRoot: "/repos/source",
    }

    it("mints a new generation when the root moved", async () => {
      const deps = createDeps()
      deps.makeRef
        .mockReturnValueOnce("sandbox-runtime:first")
        .mockReturnValueOnce("sandbox-runtime:second")
      const runtime = new SandboxSessionRuntime(deps)

      const first = await runtime.bindSession(baseInput)
      const rebound = await runtime.rebindWorkspaceRoot(first, "/bundles/alias-a")

      expect(rebound).not.toBe(first)
      expect(runtime.activeRefForSession("session-rebind")).toBe(rebound)
    })

    it("returns the same ref when the root did not move", async () => {
      const deps = createDeps()
      const runtime = new SandboxSessionRuntime(deps)
      const first = await runtime.bindSession(baseInput)
      expect(await runtime.rebindWorkspaceRoot(first, "/repos/source")).toBe(first)
    })

    it("leaves the shared host-fallback placement alone", async () => {
      const runtime = new SandboxSessionRuntime(createDeps())
      expect(await runtime.rebindWorkspaceRoot(HOST_FALLBACK_RUNTIME_REF, "/anywhere")).toBe(
        HOST_FALLBACK_RUNTIME_REF
      )
    })

    it("records an unplaced generation instead of throwing when the rebind refuses", async () => {
      const deps = createDeps()
      // The corrected root is exactly what a microVM preflight refuses on, so
      // the rebind must degrade to an unplaced record rather than throw and
      // take the send down with it.
      const preflight = jest
        .fn<Promise<void>, [string, string | undefined, string | undefined]>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("cannot claim /bundles/alias-b"))
      deps.getMicrovmAdapter.mockReturnValue({
        preflight,
        execute: jest.fn(),
      } as never)
      let refSeq = 0
      deps.makeRef.mockImplementation(() => `sandbox-runtime:gen-${++refSeq}`)
      const runtime = new SandboxSessionRuntime(deps)
      const first = await runtime.bindSession({
        ...baseInput,
        binding: { shellTier: "microvm", computerTarget: "local" } as const,
      })

      const rebound = await runtime.rebindWorkspaceRoot(first, "/bundles/alias-b")

      expect(preflight).toHaveBeenCalledTimes(2)
      expect(rebound).not.toBe(first)
      await expect(runtime.executeSandbox(rebound, payload)).rejects.toThrow(
        /cannot claim \/bundles\/alias-b/
      )
    })
  })
})

describe("the production OS-tier route", () => {
  // The singleton wires the module-level `executeOsSandbox`, which every other
  // test in this file replaces through injected deps. An injected-deps default
  // nobody exercises is a default nobody has run.
  const okResult = {
    exit_code: 0,
    stdout: "ok",
    stderr: "",
    duration: 0,
    timed_out: false,
  }

  afterEach(() => {
    __resetOsSandboxBridgeForTesting()
    __resetSandboxSessionRuntimeForTesting()
    jest.clearAllMocks()
  })

  it("prefers a registered host executor over the Tauri transport", async () => {
    const execute = jest.fn(async () => okResult)
    setOsSandboxExec({ execute, probe: async () => ({ confined: true, backend: "t", detail: "" }) })
    await expect(
      sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    ).resolves.toMatchObject({ stdout: "ok" })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(transport.call).not.toHaveBeenCalled()
  })

  it("encodes stdin as bytes for whichever route runs it", async () => {
    // The Rust `SandboxCommand.stdin` is `Option<Vec<u8>>`, so the string the
    // plugin carries has to become a byte array on both routes or the desktop
    // and the CLI would disagree about what the child reads.
    const execute = jest.fn(async () => okResult)
    setOsSandboxExec({ execute, probe: async () => ({ confined: true, backend: "t", detail: "" }) })
    await sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, {
      ...payload,
      command: { ...payload.command, stdin: "hi" },
    })
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      command: expect.objectContaining({ stdin: [104, 105] }),
    })
  })

  it("falls back to the Tauri transport when no executor is registered", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(okResult)
    await expect(
      sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    ).resolves.toMatchObject({ stdout: "ok" })
    expect(transport.call).toHaveBeenCalledWith("sandbox_exec", expect.any(Object))
  })

  it("names the missing backend when neither route exists", async () => {
    // The sandboxed tools are offered wherever a backend COULD exist, because a
    // manifest states a static fact and this one is a runtime fact. A host with
    // neither must refuse in words a reader can act on, not with the
    // transport's `tauri-only command from web mode`.
    ;(transport.call as jest.Mock).mockRejectedValueOnce(
      new Error("tauri-only command from web mode: sandbox_exec")
    )
    await expect(
      sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    ).rejects.toMatchObject({
      code: "placement-unavailable",
      message: expect.stringContaining("no OS sandbox backend"),
    })
  })

  it("keeps the underlying transport error in the refusal", async () => {
    ;(transport.call as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await expect(
      sandboxSessionRuntime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    ).rejects.toThrow(/boom/)
  })
})

describe("OS-tier audit", () => {
  // On the desktop the Rust command records the row. A host running the tier
  // itself never reaches that code, so before this a CLI session executed
  // confined commands and left no trace while the desktop recorded every one.
  const okResult = {
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration: 2,
    timed_out: false,
  }

  afterEach(() => {
    __resetOsSandboxBridgeForTesting()
  })

  function runtimeWithAudit() {
    const deps = createDeps()
    const rows: Array<Record<string, unknown>> = []
    deps.recordAudit = jest.fn(async (row) => {
      rows.push(row as unknown as Record<string, unknown>)
    })
    return { runtime: new SandboxSessionRuntime(deps), deps, rows }
  }

  it("records nothing when the desktop's Rust command owns the row", async () => {
    const { runtime, rows } = runtimeWithAudit()
    await runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    expect(rows).toEqual([])
  })

  it("records an allow row when a host executor ran the call", async () => {
    const { runtime, deps, rows } = runtimeWithAudit()
    deps.executeOsSandbox.mockResolvedValueOnce(okResult)
    setOsSandboxExec({
      execute: async () => okResult,
      probe: async () => ({ confined: true, backend: "t", detail: "" }),
    })
    await runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      surface: "sandbox",
      pluginId: "cognia-sandboxed-tools",
      command: "sandbox_bash",
      processName: "os:cognia-sandbox-exec",
      decision: "allow",
    })
    expect(String(rows[0]!.reason)).toContain("tier=os")
    expect(String(rows[0]!.reason)).toContain("termination=completed")
  })

  it("records a deny row carrying the refusal, and still throws", async () => {
    const { runtime, deps, rows } = runtimeWithAudit()
    deps.executeOsSandbox.mockRejectedValueOnce(new Error("invalid policy: no writable dir"))
    setOsSandboxExec({
      execute: async () => okResult,
      probe: async () => ({ confined: true, backend: "t", detail: "" }),
    })
    await expect(runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)).rejects.toThrow(
      "invalid policy"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", error: "invalid policy: no writable dir" })
  })

  it("marks a non-zero exit as allowed-but-failed rather than denied", async () => {
    // The sandbox permitted the call. The command failed. Collapsing those two
    // into one verdict would make the audit useless for either question.
    const { runtime, deps, rows } = runtimeWithAudit()
    deps.executeOsSandbox.mockResolvedValueOnce({ ...okResult, exit_code: 3 })
    setOsSandboxExec({
      execute: async () => okResult,
      probe: async () => ({ confined: true, backend: "t", detail: "" }),
    })
    await runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)
    expect(rows[0]).toMatchObject({ decision: "allow" })
    expect(String(rows[0]!.reason)).toContain("termination=exit_nonzero")
  })

  it("does not let an audit-persist failure take the tool call down", async () => {
    const { runtime, deps, rows } = runtimeWithAudit()
    deps.recordAudit = jest.fn(async () => {
      throw new Error("dexie is closed")
    })
    deps.executeOsSandbox.mockResolvedValueOnce(okResult)
    setOsSandboxExec({
      execute: async () => okResult,
      probe: async () => ({ confined: true, backend: "t", detail: "" }),
    })
    await expect(runtime.executeSandbox(HOST_FALLBACK_RUNTIME_REF, payload)).resolves.toMatchObject(
      { exit_code: 0 }
    )
    expect(rows).toEqual([])
  })
})
