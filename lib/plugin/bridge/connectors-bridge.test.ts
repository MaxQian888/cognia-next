/** @jest-environment jsdom */
/**
 * Tests for lib/plugin/connectors-bridge.ts — Task 110.
 *
 * Verifies register/unregister flow via a mock bus and mock plugin exports.
 */

import "fake-indexeddb/auto"

// ── Mock bus ─────────────────────────────────────────────────────────────────

const mockRegisterAdapter = jest.fn()
const mockUnregisterAdapter = jest.fn()
const mockDispatchInboundFull = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/connectors/bus", () => ({
  getBus: jest.fn(() => ({
    registerAdapter: mockRegisterAdapter,
    unregisterAdapter: mockUnregisterAdapter,
    dispatchInboundFull: mockDispatchInboundFull,
  })),
  __resetBusForTesting: jest.fn(),
}))

const mockRunningAdapters = new Map<string, unknown>()
const mockRegisterRunningAdapter = jest.fn((id: string, entry: unknown) => {
  mockRunningAdapters.set(id, entry)
})
const mockUnregisterRunningAdapter = jest.fn((id: string) => {
  mockRunningAdapters.delete(id)
})
jest.mock("@/lib/connectors/lifecycle", () => ({
  getRunningAdapter: (id: string) => mockRunningAdapters.get(id),
  registerRunningAdapter: (id: string, entry: unknown) => mockRegisterRunningAdapter(id, entry),
  unregisterRunningAdapter: (id: string) => mockUnregisterRunningAdapter(id),
}))

// Only the transport-facing proxy is faked; `isPythonBackedContribution` and
// the push channel stay real so the inbound wiring is genuinely exercised.
jest.mock("@/lib/plugin/bridge/_shared/python-backed-proxy", () => ({
  ...jest.requireActual("@/lib/plugin/bridge/_shared/python-backed-proxy"),
  createPythonBackedProxy: jest.fn(),
}))

import {
  registerPluginAdapters,
  unregisterPluginAdapters,
  getPluginAdapterIds,
  __resetBridgeForTesting,
} from "./connectors-bridge"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PlatformAdapter } from "@/types/connectors"
import { createPythonBackedProxy } from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  __resetExperimentalPythonFlagForTesting,
  setExperimentalPythonBackedEnabled,
} from "@/lib/plugin/python/experimental-flag"
import {
  __resetPythonEventBusForTesting,
  dispatchPythonPluginEvent,
} from "@/lib/plugin/python/event-bus"

const mockCreateProxy = createPythonBackedProxy as jest.MockedFunction<
  typeof createPythonBackedProxy
>

// ── helpers ──────────────────────────────────────────────────────────────────

function makeManifest(factoryName: string): PluginManifest {
  return {
    id: "com.example.mastodon",
    name: "Mastodon Adapter",
    version: "1.0.0",
    description: "Hypothetical Mastodon adapter",
    type: "frontend",
    capabilities: ["connectors"],
    connectors: [
      {
        type: "mastodon",
        factory: factoryName,
        configSchema: { type: "object" },
        transportModes: ["longpoll"],
      },
    ],
  }
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram" as const, // re-use allowed type; real plugin would declare its own
      displayName: "Mastodon",
      version: "1.0.0",
      capabilities: [],
      transportModes: ["longpoll"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

// ── python-backed adapter ────────────────────────────────────────────────────

describe("connectors-bridge python backend", () => {
  const pythonManifest = (): PluginManifest =>
    ({
      id: "py.connector",
      name: "Py Connector",
      version: "1.0.0",
      description: "",
      type: "python",
      pythonMain: "main.py",
      capabilities: ["connectors", "python"],
      connectors: [
        {
          id: "mail",
          type: "mastodon",
          factory: "createAdapter",
          configSchema: { type: "object" },
          transportModes: ["longpoll"],
        },
      ],
    }) as unknown as PluginManifest

  beforeEach(() => {
    mockRegisterAdapter.mockClear()
    mockUnregisterAdapter.mockClear()
    mockDispatchInboundFull.mockClear()
    mockRegisterRunningAdapter.mockClear()
    mockUnregisterRunningAdapter.mockClear()
    mockRunningAdapters.clear()
    __resetBridgeForTesting()
    __resetPythonEventBusForTesting()
    mockCreateProxy.mockReset()
    // connectors is `pythonExecution: "experimental"` — open the gate explicitly.
    setExperimentalPythonBackedEnabled(true)
  })

  afterEach(() => {
    __resetExperimentalPythonFlagForTesting()
  })

  it("skips a python-backed connector while the experimental flag is off", async () => {
    __resetExperimentalPythonFlagForTesting()
    stubProxy()
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
  })

  function stubProxy(overrides: Record<string, unknown> = {}) {
    mockCreateProxy.mockReturnValue({
      describe: jest.fn().mockResolvedValue({
        a2uiCapability: { mode: "none" },
        meta: {
          type: "telegram",
          displayName: "Py Mail",
          version: "1.0.0",
          capabilities: [],
          transportModes: ["longpoll"],
          configSchema: {},
        },
      }),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    } as never)
  }

  it("builds a python-backed adapter without looking at plugin JS exports", async () => {
    stubProxy()
    // Empty exports: a pure-Python plugin ships no JS module at all.
    await registerPluginAdapters("py.connector", pythonManifest(), {})

    expect(mockRegisterAdapter).toHaveBeenCalledTimes(1)
    const adapter = mockRegisterAdapter.mock.calls[0]![0] as PlatformAdapter
    expect(adapter.id).toBe("py.connector:mastodon")
    expect(adapter.meta.displayName).toBe("Py Mail")
    // `health()` answers synchronously from wrapper-tracked state.
    expect(adapter.health()).toEqual(expect.objectContaining({ state: "running" }))
    // Python connector v1 intentionally stays on the generic A2UI/plain-text
    // projection path; live TypeScript driver functions do not cross IPC.
    expect(adapter.runPresentation).toBeUndefined()
    expect(adapter.runtimeCapabilities).toBeUndefined()
  })

  it("forwards inbound python pushes into ctx.emit and tracks health", async () => {
    stubProxy()
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    const adapter = mockRegisterAdapter.mock.calls[0]![0] as PlatformAdapter

    expect(adapter.health().state).toBe("running")

    // A push from the Python subprocess must reach the shared bus context.
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "msg-1" } },
    })
    expect(mockDispatchInboundFull).toHaveBeenCalledWith({ id: "msg-1" })

    // Non-inbound channels and other contributions are ignored.
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "telemetry", payload: { id: "nope" } },
    })
    expect(mockDispatchInboundFull).toHaveBeenCalledTimes(1)

    // stop() detaches the inbound subscription.
    await adapter.stop()
    expect(adapter.health()).toEqual({ state: "down" })
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "msg-2" } },
    })
    expect(mockDispatchInboundFull).toHaveBeenCalledTimes(1)
  })

  it("does not expose a python adapter whose automatic start fails", async () => {
    stubProxy({ start: jest.fn().mockRejectedValue(new Error("python boom")) })
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    await registerPluginAdapters("py.connector", pythonManifest(), {})

    expect(mockUnregisterAdapter).toHaveBeenCalledWith("py.connector:mastodon")
    expect(mockRegisterRunningAdapter).not.toHaveBeenCalled()
    expect(getPluginAdapterIds("py.connector")).toHaveLength(0)
    errorSpy.mockRestore()
  })
})

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRegisterAdapter.mockClear()
  mockUnregisterAdapter.mockClear()
  mockDispatchInboundFull.mockClear()
  mockRegisterRunningAdapter.mockClear()
  mockUnregisterRunningAdapter.mockClear()
  mockRunningAdapters.clear()
  __resetBridgeForTesting()
})

describe("registerPluginAdapters", () => {
  it("calls bus.registerAdapter for each declared connector", async () => {
    const adapter = makeAdapter("mastodon_adp_1")
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }
    const manifest = makeManifest("createMastodonAdapter")

    await registerPluginAdapters("com.example.mastodon", manifest, exports)

    expect(exports.createMastodonAdapter).toHaveBeenCalledTimes(1)
    expect(mockRegisterAdapter).toHaveBeenCalledWith(adapter)
  })

  it("preserves TypeScript run presentation extensions on the registered adapter", async () => {
    const runPresentation = {
      capabilities: { interactiveControls: false },
      open: jest.fn(),
      update: jest.fn(),
      finish: jest.fn(),
    }
    const runtimeCapabilities = {
      topicIsolation: "native",
      unmentionedDelivery: true,
      historyPagination: true,
      liveSteer: true,
      textStreaming: true,
      componentMutation: false,
      fullReplacement: false,
      messageEditing: true,
      appendFallback: true,
      interactiveControls: false,
      followUpBubbles: false,
      staticMenus: false,
      suggestedPrompts: false,
      ambiguousDelivery: "remote_idempotent",
    } as const
    const adapter = {
      ...makeAdapter("mastodon_timeline"),
      runPresentation,
      runtimeCapabilities,
    } as PlatformAdapter
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }

    await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter"),
      exports
    )

    const registered = mockRegisterAdapter.mock.calls[0]![0] as PlatformAdapter
    expect(registered.runPresentation).toBe(runPresentation)
    expect(registered.runtimeCapabilities).toBe(runtimeCapabilities)
    expect(adapter.start).toHaveBeenCalledTimes(1)
    expect(mockRegisterRunningAdapter).toHaveBeenCalledWith(
      adapter.id,
      expect.objectContaining({ adapter, owner: "plugin", abortController: expect.anything() })
    )
  })

  it("tracks adapter id under the plugin id", async () => {
    const adapter = makeAdapter("mastodon_adp_2")
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }
    const manifest = makeManifest("createMastodonAdapter")

    await registerPluginAdapters("com.example.mastodon", manifest, exports)

    expect(getPluginAdapterIds("com.example.mastodon")).toContain("mastodon_adp_2")
  })

  it("skips missing factory with a warning (no crash)", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const manifest = makeManifest("nonExistentFactory")

    await registerPluginAdapters("com.example.mastodon", manifest, {})

    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("nonExistentFactory"))
    consoleSpy.mockRestore()
  })

  it("skips a factory that throws (no crash, continues to next)", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const exports = {
      createBrokenAdapter: jest.fn().mockRejectedValue(new Error("factory boom")),
    }
    const manifest = makeManifest("createBrokenAdapter")

    await registerPluginAdapters("com.example.mastodon", manifest, exports)

    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("factory"), expect.any(Error))
    consoleSpy.mockRestore()
  })

  it("is a no-op when manifest.connectors is empty", async () => {
    const manifest: PluginManifest = {
      id: "com.example.empty",
      name: "Empty",
      version: "1.0.0",
      description: "",
      type: "frontend",
      capabilities: [],
      connectors: [],
    }
    await registerPluginAdapters("com.example.empty", manifest, {})
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
  })

  it("is a no-op when manifest.connectors is absent", async () => {
    const manifest: PluginManifest = {
      id: "com.example.noconn",
      name: "No conn",
      version: "1.0.0",
      description: "",
      type: "frontend",
      capabilities: [],
    }
    await registerPluginAdapters("com.example.noconn", manifest, {})
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
  })
})

describe("unregisterPluginAdapters", () => {
  it("calls bus.unregisterAdapter for each registered adapter", async () => {
    const adapter = makeAdapter("mastodon_adp_3")
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }
    const manifest = makeManifest("createMastodonAdapter")

    await registerPluginAdapters("com.example.mastodon", manifest, exports)
    unregisterPluginAdapters("com.example.mastodon")

    expect(mockUnregisterRunningAdapter).toHaveBeenCalledWith("mastodon_adp_3")
    expect(mockUnregisterAdapter).toHaveBeenCalledWith("mastodon_adp_3")
  })

  it("clears the plugin's adapter id list", async () => {
    const adapter = makeAdapter("mastodon_adp_4")
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }
    const manifest = makeManifest("createMastodonAdapter")

    await registerPluginAdapters("com.example.mastodon", manifest, exports)
    unregisterPluginAdapters("com.example.mastodon")

    expect(getPluginAdapterIds("com.example.mastodon")).toHaveLength(0)
  })

  it("is a no-op for unknown plugin id", () => {
    expect(() => unregisterPluginAdapters("unknown.plugin")).not.toThrow()
    expect(mockUnregisterAdapter).not.toHaveBeenCalled()
  })
})
