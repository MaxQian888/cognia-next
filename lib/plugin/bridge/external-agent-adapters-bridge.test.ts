import {
  registerExternalAgentAdaptersForPlugin,
  unregisterExternalAgentAdaptersForPlugin,
} from "./external-agent-adapters-bridge"
import {
  BaseProtocolAdapter,
  protocolAdapterRegistry,
  registerPluginProtocolAdapter,
  getPluginProtocolAdapterMetadata,
  __resetPluginProtocolAdaptersForTesting,
  type SessionCreateOptions,
} from "@/lib/ai/agent/external/protocol-adapter"
import { ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@/types/agent/external-agent"
import type { PluginManifest } from "@/types/plugin"

class StubAdapter extends BaseProtocolAdapter {
  readonly protocol = "stub"
  async connect(_config: ExternalAgentConfig): Promise<void> {
    this._connectionStatus = "connected"
  }
  async disconnect(): Promise<void> {
    this._connectionStatus = "disconnected"
  }
  async createSession(_options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const s: ExternalAgentSession = {
      id: this.generateSessionId(),
      agentId: "a",
      status: "active",
      createdAt: new Date(),
      lastActivityAt: new Date(),
    }
    this._sessions.set(s.id, s)
    return s
  }
  async closeSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId)
  }
  async *prompt(): AsyncIterable<ExternalAgentEvent> {
    yield { type: "done", success: true, timestamp: new Date() }
  }
  async respondToPermission(): Promise<void> {}
  async cancel(): Promise<void> {}
}

const createStubAdapter = () => new StubAdapter()

const MANIFEST = {
  id: "wire-plugin",
  name: "Wire Plugin",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: ["external-agent-adapter"],
  externalAgentAdapters: [
    { id: "demo", label: "Demo", entry: "src/demo.js", export: "createStubAdapter" },
  ],
} as unknown as PluginManifest

describe("external-agent-adapters-bridge python backend", () => {
  afterEach(() => {
    unregisterExternalAgentAdaptersForPlugin("wire-plugin")
    __resetPluginProtocolAdaptersForTesting()
  })

  it("registers a python-backed adapter whose isConnected() stays synchronous", async () => {
    const importer = jest.fn()
    const manifest = {
      ...MANIFEST,
      type: "python",
      pythonMain: "main.py",
      externalAgentAdapters: [{ id: "py-agent", label: "Py agent" }],
    } as unknown as PluginManifest

    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/p", { importer })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()

    expect(protocolAdapterRegistry.has("wire-plugin:py-agent")).toBe(true)
    const adapter = protocolAdapterRegistry.create("wire-plugin:py-agent")!
    // `isConnected()` must answer synchronously — the wrapper tracks it locally
    // because an IPC round-trip cannot satisfy a sync contract.
    expect(adapter.isConnected()).toBe(false)
    expect(typeof adapter.prompt).toBe("function")
    expect(typeof adapter.execute).toBe("function")
  })

  it("sanitises a manifest's capability declaration before it becomes layer 2", async () => {
    // Plugin manifests are third-party data. `mergeExternalAgentCapabilities`
    // enforces the ladder but checks no shapes, so an unvalidated cell reaches
    // `profile.effective`, the digest and the UI intact — and a `level` outside
    // the vocabulary makes `PERMISSIVENESS[level]` undefined, which quietly
    // stops the ceiling layer clamping that cell.
    const manifest = {
      ...MANIFEST,
      externalAgentAdapters: [
        {
          id: "demo",
          label: "Demo",
          entry: "src/demo.js",
          export: "createStubAdapter",
          capabilities: {
            streaming: { level: "native", evidence: "cognia-verified" },
            mcp: { level: "yes", evidence: "adapter-code" },
            "not-a-capability": { level: "native", evidence: "adapter-code" },
          },
        },
      ],
    } as unknown as PluginManifest

    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/p", {
      importer: jest.fn().mockResolvedValue({ createStubAdapter }),
    })
    expect(result.registered).toBe(1)

    const declared = getPluginProtocolAdapterMetadata("wire-plugin:demo")?.capabilities
    // A plugin speaks for its own code, not for a conformance run.
    expect(declared?.streaming).toEqual({ level: "native", evidence: "adapter-code" })
    // Both the bogus level and the unknown id are dropped, so they fall back to
    // `unknown` — which never satisfies a hard requirement.
    expect(declared).not.toHaveProperty("mcp")
    expect(declared).not.toHaveProperty("not-a-capability")
  })

  it("still requires entry/export for a JS-backed adapter", async () => {
    const manifest = {
      ...MANIFEST,
      externalAgentAdapters: [{ id: "broken", label: "Broken" }],
    } as unknown as PluginManifest

    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/p", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toBe("entry is required")
  })
})

afterEach(() => {
  __resetPluginProtocolAdaptersForTesting()
})

describe("external-agent-adapters-bridge", () => {
  it("imports the factory and registers it under the namespaced protocol", async () => {
    const importer = jest.fn(async () => ({ createStubAdapter }))
    const result = await registerExternalAgentAdaptersForPlugin(MANIFEST, "/plugins/wire-plugin", {
      importer,
    })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).toHaveBeenCalledWith("/plugins/wire-plugin/src/demo.js")
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(true)
    expect(protocolAdapterRegistry.create("wire-plugin:demo")).toBeInstanceOf(StubAdapter)
  })

  it("collects validation errors without blocking other adapters", async () => {
    const manifest = {
      ...MANIFEST,
      externalAgentAdapters: [
        { id: "no-label", entry: "src/a.js", export: "x" },
        { id: "no-entry", label: "NoEntry", export: "x" },
        { id: "no-export", label: "NoExport", entry: "src/c.js" },
        { id: "good", label: "Good", entry: "src/demo.js", export: "createStubAdapter" },
      ],
    } as unknown as PluginManifest
    const importer = jest.fn(async () => ({ createStubAdapter }))
    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/p", { importer })
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((e) => e.adapterId).sort()).toEqual([
      "no-entry",
      "no-export",
      "no-label",
    ])
    expect(protocolAdapterRegistry.has("wire-plugin:good")).toBe(true)
  })

  it("errors when the entry does not export the named factory", async () => {
    const importer = jest.fn(async () => ({}))
    const result = await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain("does not export a factory")
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(false)
  })

  it("unregister drops every adapter of the plugin; re-enable replaces", async () => {
    const importer = jest.fn(async () => ({ createStubAdapter }))
    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(true)
    unregisterExternalAgentAdaptersForPlugin("wire-plugin")
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(false)

    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(true)
  })

  it("reports a missing id as an invalid contribution", async () => {
    const manifest = {
      ...MANIFEST,
      externalAgentAdapters: [{ label: "NoId", entry: "src/x.js", export: "x" }],
    } as unknown as PluginManifest
    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/p", {
      importer: jest.fn(),
    })
    expect(result.registered).toBe(0)
    expect(result.errors[0]).toEqual({
      pluginId: "wire-plugin",
      adapterId: "(missing id)",
      message: "id is required",
    })
  })

  it("reports a collision when the protocol is already owned by another plugin", async () => {
    // Another plugin already owns wire-plugin's namespaced protocol slot — the
    // bridge's own unregister won't reclaim it, so registration must refuse.
    registerPluginProtocolAdapter("wire-plugin:demo", createStubAdapter, { pluginId: "intruder" })
    const importer = jest.fn(async () => ({ createStubAdapter }))
    const result = await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/collides/i)
  })

  it("falls back to the default importer when none is provided", async () => {
    // No importer injected → the bridge uses its dynamic-import default, which
    // rejects for a non-existent module and is surfaced as a per-entry error.
    const result = await registerExternalAgentAdaptersForPlugin(MANIFEST, "/nonexistent-root")
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(false)
  })

  it("manifests without externalAgentAdapters are a fast no-op", async () => {
    const result = await registerExternalAgentAdaptersForPlugin(
      { ...MANIFEST, externalAgentAdapters: undefined } as PluginManifest,
      "/p"
    )
    expect(result).toEqual({ registered: 0, errors: [] })
  })
})

describe("external-agent-adapters-bridge — manager lifecycle wiring", () => {
  afterEach(async () => {
    await ExternalAgentManager.getInstance({ healthCheckInterval: 0 }).dispose()
    ExternalAgentManager.resetInstance()
    __resetPluginProtocolAdaptersForTesting()
  })

  it("disable forwards the plugin's protocols to the manager teardown", async () => {
    const importer = jest.fn(async () => ({ createStubAdapter }))
    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    const manager = ExternalAgentManager.getInstance({ healthCheckInterval: 0 })
    const spy = jest.spyOn(manager, "teardownAgentsByProtocols").mockResolvedValue([])

    await unregisterExternalAgentAdaptersForPlugin("wire-plugin")

    expect(spy).toHaveBeenCalledWith(["wire-plugin:demo"])
    // Protocols are captured BEFORE the registry forgets ownership.
    expect(protocolAdapterRegistry.has("wire-plugin:demo")).toBe(false)
  })

  it("enable forwards the registered protocols to the manager restore", async () => {
    const manager = ExternalAgentManager.getInstance({ healthCheckInterval: 0 })
    const spy = jest.spyOn(manager, "restoreAgentsForProtocols").mockReturnValue([])
    const importer = jest.fn(async () => ({ createStubAdapter }))

    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })

    expect(spy).toHaveBeenCalledWith(["wire-plugin:demo"])
  })

  it("never instantiates the manager when none exists yet (peek is null)", async () => {
    const importer = jest.fn(async () => ({ createStubAdapter }))
    await registerExternalAgentAdaptersForPlugin(MANIFEST, "/p", { importer })
    await unregisterExternalAgentAdaptersForPlugin("wire-plugin")
    expect(ExternalAgentManager.peekInstance()).toBeNull()
  })
})
