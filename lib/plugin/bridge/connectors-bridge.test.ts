/** @jest-environment jsdom */
/**
 * Tests for the plugin connectors bridge.
 *
 * The contract changed shape: enabling a plugin used to build and start one
 * unmanaged adapter per contribution, under a synthetic id, with nothing
 * persisted — so that bot had no settings, no credentials, no enable switch,
 * and there could only ever be one of it. Enabling a plugin now REGISTERS a
 * definition; the bots themselves are ordinary `AdapterInstanceRow`s owned by
 * the supervisor.
 *
 * So the assertions worth making are: the factory is not called at
 * registration, a first instance is seeded once and only once, conflicting
 * kinds are refused with a reason the author can act on, and disabling the
 * plugin takes the kind away without taking the user's rows with it.
 */

import "fake-indexeddb/auto"

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

const mockUnregisterRunningAdapter = jest.fn()
jest.mock("@/lib/connectors/lifecycle", () => ({
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
  getPluginConnectorKinds,
  __resetBridgeForTesting,
} from "./connectors-bridge"
import { buildPluginAdapter } from "@/lib/connectors/plugin-connector-registry"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
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

function makeManifest(
  factoryName: string,
  connectorOverrides: Record<string, unknown> = {}
): PluginManifest {
  return {
    id: "com.example.mastodon",
    name: "Mastodon Adapter",
    version: "1.2.3",
    description: "Hypothetical Mastodon adapter",
    type: "frontend",
    capabilities: ["connectors"],
    connectors: [
      {
        type: "mastodon",
        factory: factoryName,
        configSchema: { type: "object", properties: {} },
        transportModes: ["longpoll"],
        ...connectorOverrides,
      },
    ],
  } as unknown as PluginManifest
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "mastodon",
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

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  mockRegisterAdapter.mockClear()
  mockUnregisterAdapter.mockClear()
  mockDispatchInboundFull.mockClear()
  mockUnregisterRunningAdapter.mockClear()
  __resetBridgeForTesting()
  __resetPythonEventBusForTesting()
  mockCreateProxy.mockReset()
}, 30_000)

// ── registration ─────────────────────────────────────────────────────────────

describe("registerPluginAdapters", () => {
  it("registers the kind without calling the factory or touching the bus", async () => {
    const exports = { createMastodonAdapter: jest.fn() }
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter"),
      exports
    )

    expect(report.registered).toEqual(["mastodon"])
    expect(report.rejected).toEqual([])
    // The whole point: nothing is built or started at enable time.
    expect(exports.createMastodonAdapter).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(getPluginConnectorKinds("com.example.mastodon")).toEqual(["mastodon"])
  })

  it("seeds one enabled instance carrying its plugin provenance", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter", { displayName: "Mastodon Bot" }),
      { createMastodonAdapter: jest.fn() }
    )

    expect(report.seeded).toHaveLength(1)
    const rows = await listAdapterInstancesByType("mastodon")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: "mastodon",
      displayName: "Mastodon Bot",
      enabled: true,
      // Backfilled by the create helper — a plugin bot must not start life
      // with permission to ship binaries to a cloud model.
      mediaModelPolicy: "local_extract_only",
      plugin: {
        pluginId: "com.example.mastodon",
        contributionId: "mastodon",
        pluginRelease: "1.2.3",
      },
    })
  })

  it("does not seed a second instance when one already exists", async () => {
    const manifest = makeManifest("createMastodonAdapter")
    const exports = { createMastodonAdapter: jest.fn() }
    await registerPluginAdapters("com.example.mastodon", manifest, exports)
    __resetBridgeForTesting()
    // Re-enabling (or a second app boot) must not accumulate duplicate bots.
    const second = await registerPluginAdapters("com.example.mastodon", manifest, exports)

    expect(second.seeded).toEqual([])
    expect(await listAdapterInstancesByType("mastodon")).toHaveLength(1)
  })

  it("keeps a user's extra instances and never re-seeds over them", async () => {
    const manifest = makeManifest("createMastodonAdapter")
    const exports = { createMastodonAdapter: jest.fn() }
    await registerPluginAdapters("com.example.mastodon", manifest, exports)
    const { createAdapterInstance } = await import("@/lib/db/adapter-instances")
    await createAdapterInstance({
      type: "mastodon",
      displayName: "Second bot",
      enabled: true,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
    })

    __resetBridgeForTesting()
    await registerPluginAdapters("com.example.mastodon", manifest, exports)
    expect(await listAdapterInstancesByType("mastodon")).toHaveLength(2)
  })

  it("builds the adapter lazily, once an instance asks for it", async () => {
    const adapter = makeAdapter("row-1")
    const exports = { createMastodonAdapter: jest.fn().mockResolvedValue(adapter) }
    await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter"),
      exports
    )

    const built = await buildPluginAdapter({ id: "row-1", type: "mastodon" })
    expect(built).toBe(adapter)
    expect(exports.createMastodonAdapter).toHaveBeenCalledTimes(1)
  })

  it("returns null for a kind no enabled plugin owns", async () => {
    expect(await buildPluginAdapter({ id: "row-1", type: "mastodon" })).toBeNull()
  })
})

// ── refusals ─────────────────────────────────────────────────────────────────

describe("registerPluginAdapters — refusals", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  afterAll(() => warn.mockRestore())

  it("refuses a built-in platform kind", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter", { type: "telegram" }),
      { createMastodonAdapter: jest.fn() }
    )
    expect(report.registered).toEqual([])
    expect(report.rejected[0]).toMatchObject({ type: "telegram", reason: "kind_conflict_builtin" })
  })

  it("refuses a kind the host has reserved but not shipped", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter", { type: "email" }),
      { createMastodonAdapter: jest.fn() }
    )
    expect(report.rejected[0]).toMatchObject({ reason: "kind_conflict_reserved" })
  })

  it("refuses a kind another plugin already owns", async () => {
    await registerPluginAdapters("com.example.mastodon", makeManifest("createMastodonAdapter"), {
      createMastodonAdapter: jest.fn(),
    })
    const other = makeManifest("createOther")
    ;(other as unknown as { id: string }).id = "com.example.other"
    const report = await registerPluginAdapters("com.example.other", other, {
      createOther: jest.fn(),
    })
    // Two owners for one kind would make which adapter you get depend on load
    // order, which is not a thing a user could ever debug.
    expect(report.rejected[0]).toMatchObject({ reason: "kind_conflict_plugin" })
  })

  it("refuses a kind that cannot be part of a webhook path", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter", { type: "My Connector/v2" }),
      { createMastodonAdapter: jest.fn() }
    )
    expect(report.rejected[0]).toMatchObject({ reason: "kind_invalid" })
  })

  it("refuses a config schema no settings form can be generated from", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter", { configSchema: "not-a-schema" }),
      { createMastodonAdapter: jest.fn() }
    )
    expect(report.rejected[0]).toMatchObject({ reason: "schema_unsupported" })
  })

  it("refuses a factory the plugin does not export", async () => {
    const report = await registerPluginAdapters(
      "com.example.mastodon",
      makeManifest("createMastodonAdapter"),
      {}
    )
    expect(report.rejected[0]).toMatchObject({ reason: "factory_missing" })
  })

  it("refusing one contribution does not stop the others", async () => {
    const manifest = makeManifest("createMastodonAdapter")
    ;(manifest as unknown as { connectors: unknown[] }).connectors = [
      { type: "telegram", factory: "createMastodonAdapter", configSchema: {}, transportModes: [] },
      {
        type: "mastodon",
        factory: "createMastodonAdapter",
        configSchema: { type: "object" },
        transportModes: ["longpoll"],
      },
    ]
    const report = await registerPluginAdapters("com.example.mastodon", manifest, {
      createMastodonAdapter: jest.fn(),
    })
    expect(report.registered).toEqual(["mastodon"])
    expect(report.rejected).toHaveLength(1)
  })
})

// ── unregistration ───────────────────────────────────────────────────────────

describe("unregisterPluginAdapters", () => {
  it("gives up the kind but leaves the user's instance rows alone", async () => {
    await registerPluginAdapters("com.example.mastodon", makeManifest("createMastodonAdapter"), {
      createMastodonAdapter: jest.fn().mockResolvedValue(makeAdapter("row-1")),
    })
    expect(await listAdapterInstancesByType("mastodon")).toHaveLength(1)

    unregisterPluginAdapters("com.example.mastodon")

    expect(getPluginConnectorKinds("com.example.mastodon")).toEqual([])
    // The kind can no longer be built — that is what stops the bots.
    expect(await buildPluginAdapter({ id: "row-1", type: "mastodon" })).toBeNull()
    // …but the settings and credentials the user configured survive.
    expect(await listAdapterInstancesByType("mastodon")).toHaveLength(1)
  })
})

// ── python-backed adapters ───────────────────────────────────────────────────

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

  function stubProxy(overrides: Record<string, unknown> = {}) {
    mockCreateProxy.mockReturnValue({
      describe: jest.fn().mockResolvedValue({
        a2uiCapability: { mode: "none" },
        meta: {
          type: "mastodon",
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

  beforeEach(() => {
    // connectors is `pythonExecution: "experimental"` — open the gate explicitly.
    setExperimentalPythonBackedEnabled(true)
  })

  afterEach(() => {
    __resetExperimentalPythonFlagForTesting()
  })

  it("refuses a python-backed connector while the experimental flag is off", async () => {
    __resetExperimentalPythonFlagForTesting()
    stubProxy()
    const report = await registerPluginAdapters("py.connector", pythonManifest(), {})
    expect(report.registered).toEqual([])
    expect(report.rejected[0]).toMatchObject({ reason: "factory_missing" })
  })

  it("registers without a JS export and builds the proxy adapter lazily", async () => {
    stubProxy()
    // Empty exports: a pure-Python plugin ships no JS module at all.
    const report = await registerPluginAdapters("py.connector", pythonManifest(), {})
    expect(report.registered).toEqual(["mastodon"])
    // No subprocess is touched until an instance actually needs the adapter.
    expect(mockCreateProxy).not.toHaveBeenCalled()

    const adapter = await buildPluginAdapter({ id: "row-1", type: "mastodon" })
    expect(adapter?.meta.displayName).toBe("Py Mail")
    // `health()` answers synchronously from wrapper-tracked state.
    expect(adapter?.health()).toEqual(expect.objectContaining({ state: "down" }))
    // Python connector v1 intentionally stays on the generic A2UI/plain-text
    // projection path; live TypeScript driver functions do not cross IPC.
    expect(adapter?.runPresentation).toBeUndefined()
    expect(adapter?.runtimeCapabilities).toBeUndefined()
  })

  it("forwards inbound python pushes into ctx.emit and tracks health", async () => {
    stubProxy()
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    const adapter = (await buildPluginAdapter({ id: "row-1", type: "mastodon" }))!

    const emit = jest.fn()
    await adapter.start({ adapterId: "row-1", emit } as never)
    expect(adapter.health().state).toBe("running")

    dispatchPythonPluginEvent({
      pluginId: "py.connector",
      kind: "emit",
      data: { contributionId: "mastodon", channel: "inbound", payload: { id: "msg-1" } },
    })
    expect(emit).toHaveBeenCalledWith({ id: "msg-1" })

    // Non-inbound channels are ignored.
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

  it("surfaces a failed python start to the supervisor rather than swallowing it", async () => {
    stubProxy({ start: jest.fn().mockRejectedValue(new Error("python boom")) })
    await registerPluginAdapters("py.connector", pythonManifest(), {})
    const adapter = (await buildPluginAdapter({ id: "row-1", type: "mastodon" }))!

    // The supervisor owns retry/backoff now, so start() must reject rather than
    // report a healthy adapter.
    await expect(adapter.start({ adapterId: "row-1", emit: jest.fn() } as never)).rejects.toThrow(
      "python boom"
    )
    expect(adapter.health()).toMatchObject({ state: "down" })
  })
})
