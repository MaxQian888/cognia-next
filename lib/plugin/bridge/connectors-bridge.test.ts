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

jest.mock("@/lib/connectors/bus", () => ({
  getBus: jest.fn(() => ({
    registerAdapter: mockRegisterAdapter,
    unregisterAdapter: mockUnregisterAdapter,
  })),
  __resetBusForTesting: jest.fn(),
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
    expect(adapter.health()).toEqual({ state: "down" })
  })

  it("forwards inbound python pushes into ctx.emit and tracks health", async () => {
    stubProxy()
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    const adapter = mockRegisterAdapter.mock.calls[0]![0] as PlatformAdapter

    const emit = jest.fn().mockResolvedValue(undefined)
    await adapter.start({ adapterId: "py.connector:mastodon", emit } as never)
    expect(adapter.health().state).toBe("running")

    // A push from the Python subprocess must reach the bus via ctx.emit.
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "msg-1" } },
    })
    expect(emit).toHaveBeenCalledWith({ id: "msg-1" })

    // Non-inbound channels and other contributions are ignored.
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "telemetry", payload: { id: "nope" } },
    })
    expect(emit).toHaveBeenCalledTimes(1)

    // stop() detaches the inbound subscription.
    await adapter.stop()
    expect(adapter.health()).toEqual({ state: "down" })
    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "msg-2" } },
    })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it("reports start failure as down and detaches the inbound subscription", async () => {
    stubProxy({ start: jest.fn().mockRejectedValue(new Error("python boom")) })
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    const adapter = mockRegisterAdapter.mock.calls[0]![0] as PlatformAdapter

    const emit = jest.fn()
    await expect(
      adapter.start({ adapterId: "py.connector:mastodon", emit } as never)
    ).rejects.toThrow("python boom")
    expect(adapter.health()).toEqual({ state: "down", reason: "python boom" })

    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "x" } },
    })
    expect(emit).not.toHaveBeenCalled()
  })
})

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRegisterAdapter.mockClear()
  mockUnregisterAdapter.mockClear()
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
