/**
 * Smoke tests for AcpClientAdapter — exercises the public surface that runs
 * without a live ACP process. Full protocol negotiation requires a Tauri
 * runtime + child process, which jsdom can't provide; those paths are covered
 * by integration tests under src-tauri/.
 */

jest.mock("@/lib/native/external-agent", () => ({
  acpTerminalCreate: jest.fn(async () => "terminal-1"),
  acpTerminalKill: jest.fn(async () => undefined),
  acpTerminalOutput: jest.fn(async () => ({
    output: "",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  })),
  acpTerminalRelease: jest.fn(async () => undefined),
  acpTerminalWaitForExit: jest.fn(async () => ({
    exitStatus: { exitCode: 0, signal: null },
  })),
}))

jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: jest.fn(),
}))

import { AcpClientAdapter, buildSpawnArgs, createAcpClient } from "./acp-client"
import type { ExternalAgentConfig, AcpPermissionResponse } from "@/types/agent/external-agent"

describe("buildSpawnArgs", () => {
  it("returns the original args verbatim when no toggles are on", () => {
    expect(buildSpawnArgs({ args: ["-y", "@anthropics/claude-code", "--stdio"] })).toEqual([
      "-y",
      "@anthropics/claude-code",
      "--stdio",
    ])
  })

  it("appends --bare and --debug when their toggles are true", () => {
    expect(
      buildSpawnArgs({
        args: ["-y", "@anthropics/claude-code", "--stdio"],
        bare: true,
        debug: true,
      })
    ).toEqual(["-y", "@anthropics/claude-code", "--stdio", "--bare", "--debug"])
  })

  it("is idempotent — does not add a flag that's already present in args", () => {
    expect(buildSpawnArgs({ args: ["--bare", "--debug"], bare: true, debug: true })).toEqual([
      "--bare",
      "--debug",
    ])
  })

  it("handles undefined args by starting from an empty list", () => {
    expect(buildSpawnArgs({ bare: true })).toEqual(["--bare"])
  })

  it("appends only the toggles that are on", () => {
    expect(buildSpawnArgs({ args: ["x"], bare: true })).toEqual(["x", "--bare"])
    expect(buildSpawnArgs({ args: ["x"], debug: true })).toEqual(["x", "--debug"])
  })
})

describe("AcpClientAdapter — basic state", () => {
  it("starts disconnected with no capabilities or tools", () => {
    const a = new AcpClientAdapter()
    expect(a.protocol).toBe("acp")
    expect(a.connectionStatus).toBe("disconnected")
    expect(a.isConnected()).toBe(false)
    expect(a.capabilities).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  it("createAcpClient produces a fresh instance", () => {
    expect(createAcpClient()).toBeInstanceOf(AcpClientAdapter)
  })

  it("getSessionExtensionSupport returns the unknown defaults before any probe", () => {
    const a = new AcpClientAdapter()
    const support = a.getSessionExtensionSupport()
    expect(support["session/list"].state).toBe("unknown")
    expect(support["session/fork"].state).toBe("unknown")
    expect(support["session/resume"].state).toBe("unknown")
  })

  it("getAcpInitializationMetadata reports an empty contract before connect()", () => {
    const a = new AcpClientAdapter()
    const meta = a.getAcpInitializationMetadata()
    expect(meta).toEqual({
      protocolVersion: undefined,
      agentInfo: undefined,
      agentCapabilities: undefined,
      authMethods: undefined,
    })
  })

  it("getAuthMethods/isAuthenticationRequired return safe defaults pre-connect", () => {
    const a = new AcpClientAdapter()
    expect(a.getAuthMethods()).toEqual([])
    expect(a.isAuthenticationRequired()).toBe(false)
  })

  it("clearSessionExtensionSupportCache clears extension state without throwing", () => {
    const a = new AcpClientAdapter()
    expect(() => a.clearSessionExtensionSupportCache()).not.toThrow()
  })
})

describe("AcpClientAdapter — unsupported transports and missing config", () => {
  function baseConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
    return {
      id: "agent",
      name: "Test",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
      defaultPermissionMode: "default",
      timeout: 1000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  it("rejects stdio transport when not in Tauri runtime", async () => {
    const a = new AcpClientAdapter()
    await expect(
      a.connect(baseConfig({ transport: "stdio", process: { command: "x", args: [] } }))
    ).rejects.toThrow(/Tauri/)
  })

  it("rejects unknown transports", async () => {
    const a = new AcpClientAdapter()
    await expect(a.connect(baseConfig({ transport: "carrier-pigeon" as never }))).rejects.toThrow(
      /Unsupported transport/
    )
  })

  it("rejects http transport when network endpoint is missing", async () => {
    const a = new AcpClientAdapter()
    await expect(a.connect(baseConfig({ transport: "http" }))).rejects.toThrow(
      /Network endpoint required/
    )
  })
})

describe("AcpClientAdapter — operations on a disconnected client", () => {
  let a: AcpClientAdapter

  beforeEach(() => {
    a = new AcpClientAdapter()
  })

  it("createSession throws when not connected", async () => {
    await expect(a.createSession()).rejects.toThrow()
  })

  it("respondToPermission silently no-ops when no pending permission exists", async () => {
    await expect(
      a.respondToPermission("session-id", {
        requestId: "missing",
        outcome: { outcome: "selected", optionId: "yes" },
      } as unknown as AcpPermissionResponse)
    ).resolves.toBeUndefined()
  })

  it("setSessionModel throws for an unknown session id", async () => {
    await expect(a.setSessionModel("nope", "claude")).rejects.toThrow(/not found/i)
  })

  it("getSessionModels and getConfigOptions return undefined for unknown session", () => {
    expect(a.getSessionModels("nope")).toBeUndefined()
    expect(a.getConfigOptions("nope")).toBeUndefined()
  })

  it("setConfigOption throws without an active session", async () => {
    await expect(a.setConfigOption("nope", "k", "v")).rejects.toThrow()
  })

  it("disconnect on a disconnected client is a no-op", async () => {
    await expect(a.disconnect()).resolves.toBeUndefined()
  })

  it("healthCheck returns false when never connected", async () => {
    expect(await a.healthCheck()).toBe(false)
  })

  it("cancel on a missing session is a no-op", async () => {
    await expect(a.cancel("nope")).resolves.toBeUndefined()
  })
})

describe("AcpClientAdapter — extension handler registry", () => {
  it("registers and unregisters extension handlers without error", () => {
    const a = new AcpClientAdapter()
    const handler = jest.fn()
    a.registerExtensionHandler("_custom/method", handler)
    a.unregisterExtensionHandler("_custom/method")
    expect(handler).not.toHaveBeenCalled()
  })
})
