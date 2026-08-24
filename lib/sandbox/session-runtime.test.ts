import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  sandboxSessionRuntime,
  SandboxSessionRuntime,
  type SandboxSessionRuntimeDeps,
} from "./session-runtime"
import { SandboxCapabilityError } from "./lifecycle-contract"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import type { SandboxConnectionRow } from "@/types/sandbox"
import type { MicrovmExecPayload } from "./microvm-bridge"
import { __resetMicrovmBridgeForTesting, setMicrovmExec } from "./microvm-bridge"

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

  it("fails when the E2B adapter is missing at bind or disappears afterward", async () => {
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
    deps.getMicrovmAdapter.mockReturnValueOnce(adapter).mockReturnValue(null)
    const ref = await runtime.bindSession(input)
    expect(adapter.preflight).toHaveBeenCalledWith(ref, "/workspace", "microvm")
    await expect(runtime.executeSandbox(ref, payload)).rejects.toMatchObject({
      code: "microvm-unavailable",
    })
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
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

  it("refuses cua-desktop execution without touching the OS sandbox", async () => {
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
    ).rejects.toBeInstanceOf(SandboxCapabilityError)
    expect(deps.executeOsSandbox).not.toHaveBeenCalled()
  })

  it("keeps old generations valid until the session is released", async () => {
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
      policy: { network: "off" },
    })

    expect(second).not.toBe(first)
    await expect(runtime.executeSandbox(first, payload)).resolves.toMatchObject({ exit_code: 0 })
    await runtime.releaseSession("session-1")
    await expect(runtime.executeSandbox(first, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
    await expect(runtime.executeSandbox(second, payload)).rejects.toMatchObject({
      code: "runtime-released",
    })
  })

  it("keeps E2B generations independently addressable until session release", async () => {
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

    await runtime.executeSandbox(first, payload)
    await runtime.executeSandbox(second, payload)

    expect(adapter.execute.mock.calls.map(([ownerRef]) => ownerRef)).toEqual([first, second])
    await runtime.releaseSession("session-1")
    expect(adapter.release.mock.calls.map(([ownerRef]) => ownerRef).sort()).toEqual(
      [first, second].sort()
    )
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
    ).rejects.toMatchObject({ code: "runtime-released" })
    await expect(runtime.releaseSession("session-1")).resolves.toBeUndefined()
    expect(adapter.release).toHaveBeenCalledTimes(2)
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
})
