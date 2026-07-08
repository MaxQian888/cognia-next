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

import {
  registerPluginAdapters,
  unregisterPluginAdapters,
  getPluginAdapterIds,
  __resetBridgeForTesting,
} from "./connectors-bridge"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PlatformAdapter } from "@/types/connectors"

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
