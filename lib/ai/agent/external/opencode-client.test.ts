/**
 * Smoke tests for OpenCodeClientAdapter — verifies the public API surface
 * runs without a live OpenCode server. The mock at
 * `__mocks__/opencode-sdk-client.js` returns a StubClient with no methods,
 * so the adapter throws when it tries to call SDK methods. These tests
 * verify the adapter's pre-connect state, error handling, and the simple
 * accessors that don't require a connected client.
 */

import { OpenCodeClientAdapter } from "./opencode-client"
import type { ExternalAgentConfig, AcpPermissionResponse } from "@/types/agent/external-agent"

describe("OpenCodeClientAdapter — basic state", () => {
  it("has the expected protocol identifier", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.protocol).toBe("opencode")
  })

  it("starts disconnected", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.connectionStatus).toBe("disconnected")
    expect(a.isConnected()).toBe(false)
  })

  it("default capabilities and tools are undefined pre-connect", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.capabilities).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  it("getSessionExtensionSupport reports list/fork/resume as supported", () => {
    const a = new OpenCodeClientAdapter()
    const ext = a.getSessionExtensionSupport()
    expect(ext["session/list"].state).toBe("supported")
    expect(ext["session/resume"].state).toBe("supported")
    expect(ext["session/fork"].state).toBe("supported")
  })

  it("clearSessionExtensionSupportCache is a no-op", () => {
    const a = new OpenCodeClientAdapter()
    expect(() => a.clearSessionExtensionSupportCache()).not.toThrow()
  })

  it("getAcpInitializationMetadata returns the canonical opencode contract", () => {
    const a = new OpenCodeClientAdapter()
    const meta = a.getAcpInitializationMetadata()
    expect(meta.agentInfo?.name).toBeDefined()
    expect(meta.agentCapabilities).toBeDefined()
  })

  it("getAuthMethods returns an empty list", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.getAuthMethods()).toEqual([])
  })

  it("isAuthenticationRequired is false", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.isAuthenticationRequired()).toBe(false)
  })

  it("getSessionModels and getConfigOptions return undefined for unknown sessions", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.getSessionModels("missing")).toBeUndefined()
    expect(a.getConfigOptions("missing")).toBeUndefined()
  })

  it("authenticate without credentials resolves silently", async () => {
    const a = new OpenCodeClientAdapter()
    await expect(a.authenticate("any")).resolves.toBeUndefined()
  })
})

describe("OpenCodeClientAdapter — connect path", () => {
  function buildConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
    return {
      id: "agent",
      name: "OC",
      protocol: "opencode",
      transport: "http",
      enabled: true,
      defaultPermissionMode: "default",
      timeout: 1000,
      metadata: { hostname: "127.0.0.1", port: 4096 },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  it("connect with stub client (no global.event method) marks status as error", async () => {
    const a = new OpenCodeClientAdapter()
    // The mocked SDK returns a bare StubClient with no methods, so global.event
    // throws — connect() must capture and re-throw, leaving status='error'.
    await expect(a.connect(buildConfig())).rejects.toThrow()
    expect(a.connectionStatus).toBe("error")
  })

  it("connect honors explicit network endpoint", async () => {
    const a = new OpenCodeClientAdapter()
    await expect(
      a.connect(buildConfig({ network: { endpoint: "http://example/" } }))
    ).rejects.toThrow()
  })
})

describe("OpenCodeClientAdapter — operations on a disconnected client throw", () => {
  let a: OpenCodeClientAdapter
  beforeEach(() => {
    a = new OpenCodeClientAdapter()
  })

  it("createSession throws when client is not initialized", async () => {
    await expect(a.createSession()).rejects.toThrow()
  })

  it("listSessions throws when client is not initialized", async () => {
    await expect(a.listSessions()).rejects.toThrow()
  })

  it("forkSession throws an unsupported error", async () => {
    await expect(a.forkSession("anything")).rejects.toThrow()
  })

  it("respondToPermission swallows errors when client SDK has no method", async () => {
    await expect(
      a.respondToPermission("session", {
        requestId: "r",
        outcome: { outcome: "selected", optionId: "yes" },
      } as unknown as AcpPermissionResponse)
    ).resolves.toBeUndefined()
  })

  it("setSessionMode without registered config options is a no-op", async () => {
    await expect(a.setSessionMode("unknown", "default")).resolves.toBeUndefined()
  })

  it("setSessionModel swallows underlying SDK errors", async () => {
    await expect(a.setSessionModel("any", "broken")).resolves.toBeUndefined()
  })

  it("healthCheck returns false when client.config.get fails", async () => {
    const result = await a.healthCheck()
    expect(result).toBe(false)
  })

  it("disconnect on a never-connected client is a no-op", async () => {
    await expect(a.disconnect()).resolves.toBeUndefined()
  })
})
