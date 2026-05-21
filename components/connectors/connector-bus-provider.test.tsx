/**
 * @jest-environment jsdom
 *
 * Task 41 — ConnectorBusProvider.
 *
 * Verifies:
 *  - In web mode: bus.registerAdapter is NOT called.
 *  - In Tauri mode: bus.registerAdapter is called once per enabled adapter row.
 *  - installRuntime is called in Tauri mode.
 *  - startOutboundRunner is called in Tauri mode.
 */

import { render, waitFor } from "@testing-library/react"
import { ConnectorBusProvider } from "./connector-bus-provider"
import { isTauri } from "@/lib/tauri"

// ── Mock isTauri ─────────────────────────────────────────────────────────────
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// ── Mock listEnabledAdapterInstances ─────────────────────────────────────────
const mockListEnabled = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  listEnabledAdapterInstances: (...args: unknown[]) => mockListEnabled(...args),
}))

// ── Mock installRuntime ───────────────────────────────────────────────────────
const mockInstallRuntime = jest.fn()
jest.mock("@/lib/connectors/runtime", () => ({
  installRuntime: (...args: unknown[]) => mockInstallRuntime(...args),
}))

// ── Mock startOutboundRunner ─────────────────────────────────────────────────
const mockStartOutboundRunner = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/outbound-runner", () => ({
  startOutboundRunner: (...args: unknown[]) => mockStartOutboundRunner(...args),
}))

// ── Mock getBus + registerAdapter ────────────────────────────────────────────
const mockRegisterAdapter = jest.fn()
const mockListAdapters = jest.fn().mockReturnValue([])
const mockBus = {
  registerAdapter: mockRegisterAdapter,
  listAdapters: mockListAdapters,
}
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => mockBus,
}))

// ── Mock buildAdapterFromRow ──────────────────────────────────────────────────
const mockBuildAdapterFromRow = jest.fn()
jest.mock("@/lib/connectors/adapter-registry", () => ({
  buildAdapterFromRow: (...args: unknown[]) => mockBuildAdapterFromRow(...args),
}))

// ── Mock Tauri keyring / http (not used directly in provider) ────────────────
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn().mockResolvedValue(null),
  connectorsHttpRequest: jest.fn().mockResolvedValue({ status: 200, body: "{}", headers: {} }),
}))

// ── Mock the AdapterContext factory (no IndexedDB needed for unit test) ──
const mockBuildAdapterContext = jest.fn().mockReturnValue({
  adapterId: "stub",
  signal: new AbortController().signal,
  emit: jest.fn(),
  tauri: {},
  secrets: {},
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
})
jest.mock("@/lib/connectors/adapter-context", () => ({
  buildAdapterContext: (...args: unknown[]) => mockBuildAdapterContext(...args),
}))

// ── Mock appendAudit (writes to Dexie; jsdom has no IDB) ─────────────────
const mockAppendAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: (...args: unknown[]) => mockAppendAudit(...args),
}))

// ── Mock the heartbeat (writes to Dexie; jsdom has no IDB) ───────────────
const mockHeartbeatDispose = jest.fn()
const mockStartAdapterHeartbeat = jest
  .fn()
  .mockImplementation(() => ({ dispose: mockHeartbeatDispose }))
jest.mock("@/lib/connectors/health/heartbeat", () => ({
  startAdapterHeartbeat: (...args: unknown[]) => mockStartAdapterHeartbeat(...args),
}))

// ── Mock the lifecycle registry so we can assert registration calls ──────
interface MockLifecycleEntry {
  adapter: { id: string; stop: jest.Mock }
  heartbeat: { dispose: jest.Mock }
  abortController: AbortController
  restart: jest.Mock
}
const lifecycleRegistry = new Map<string, MockLifecycleEntry>()
const mockRegisterRunning = jest.fn((id: string, entry: unknown) => {
  lifecycleRegistry.set(id, entry as MockLifecycleEntry)
})
const mockUnregisterRunning = jest.fn((id: string) => {
  const entry = lifecycleRegistry.get(id)
  lifecycleRegistry.delete(id)
  if (!entry) return
  entry.heartbeat.dispose()
  entry.abortController.abort()
  // Same fire-and-forget shape as the production implementation,
  // including the error log so the "swallows adapter.stop()" test passes.
  void entry.adapter.stop().catch((err: unknown) => {
    console.error(
      `[lifecycle] adapter ${id} failed to stop: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  })
})
const mockListRunning = jest.fn(() => Array.from(lifecycleRegistry.values()))
jest.mock("@/lib/connectors/lifecycle", () => ({
  registerRunningAdapter: (...args: [string, unknown]) => mockRegisterRunning(...args),
  unregisterRunningAdapter: (...args: [string]) => mockUnregisterRunning(...args),
  listRunningAdapters: () => mockListRunning(),
  subscribeCredentialsRotatedToLifecycle: () => () => {},
}))

// ── Mock the dynamic import of `@/lib/db/schema` used by the G6 capability
// refresh block. Returning a stub `getDb` with a no-op `update` keeps the
// provider's startup loop from hitting IndexedDB. ────────────────────────────
const mockAdapterInstancesUpdate = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    adapterInstances: { update: (...args: unknown[]) => mockAdapterInstancesUpdate(...args) },
  }),
}))

const makeTelegramRow = (id = "cai_tg_1") => ({
  id,
  type: "telegram" as const,
  displayName: "Test Bot",
  enabled: true,
  transportMode: "longpoll" as const,
  settings: {},
  credentialsRef: { keyringService: "cognia", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto" as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const makeFakeAdapter = (id: string) => ({
  id,
  meta: {
    type: "telegram" as const,
    displayName: "Test Bot",
    version: "0.1.0",
    capabilities: [],
    transportModes: ["longpoll" as const],
    configSchema: {},
  },
  // Both lifecycle entry-points are awaited via `.catch()` in production
  // (see `lifecycle.ts`), so they must return Promises by default — bare
  // `jest.fn()` returns undefined which trips the catch chain.
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  health: jest.fn(),
  send: jest.fn(),
  a2uiCapability: jest.fn().mockReturnValue({}),
})

beforeEach(() => {
  jest.clearAllMocks()
  mockListAdapters.mockReturnValue([])
  lifecycleRegistry.clear()
  mockStartAdapterHeartbeat.mockImplementation(() => ({ dispose: mockHeartbeatDispose }))
})

describe("ConnectorBusProvider", () => {
  it("does nothing in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    // Give async effect time to run
    await new Promise((r) => setTimeout(r, 50))
    expect(mockListEnabled).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(mockInstallRuntime).not.toHaveBeenCalled()
    expect(mockStartOutboundRunner).not.toHaveBeenCalled()
  })

  it("registers one adapter per enabled row in Tauri mode", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow()
    const fakeAdapter = makeFakeAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(fakeAdapter)
    mockListAdapters.mockReturnValue([fakeAdapter])

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(mockRegisterAdapter).toHaveBeenCalledTimes(1)
      expect(mockRegisterAdapter).toHaveBeenCalledWith(fakeAdapter)
    })
    expect(mockInstallRuntime).toHaveBeenCalledTimes(1)
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("registers multiple adapters when multiple rows are enabled", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row1 = makeTelegramRow("cai_tg_1")
    const row2 = makeTelegramRow("cai_tg_2")
    const adapter1 = makeFakeAdapter(row1.id)
    const adapter2 = makeFakeAdapter(row2.id)
    mockListEnabled.mockResolvedValue([row1, row2])
    mockBuildAdapterFromRow.mockResolvedValueOnce(adapter1).mockResolvedValueOnce(adapter2)
    mockListAdapters.mockReturnValue([adapter1, adapter2])

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(mockRegisterAdapter).toHaveBeenCalledTimes(2)
    })
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("skips null adapters (unsupported type) without crashing", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow()
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(null) // unsupported → null
    mockListAdapters.mockReturnValue([])

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(mockBuildAdapterFromRow).toHaveBeenCalledTimes(1)
    })
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    // Runner still starts (with empty adapter map)
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("logs and bails when the adapterInstances store is missing (stale IDB)", async () => {
    mockedIsTauri.mockReturnValue(true)
    const notFound = Object.assign(new Error("store missing"), { name: "NotFoundError" })
    mockListEnabled.mockRejectedValue(notFound)
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("adapterInstances"))
    })
    expect(mockInstallRuntime).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(mockStartOutboundRunner).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("renders children in both modes", () => {
    mockedIsTauri.mockReturnValue(false)
    mockListEnabled.mockResolvedValue([])
    const { getByText } = render(
      <ConnectorBusProvider>
        <span>hello world</span>
      </ConnectorBusProvider>
    )
    expect(getByText("hello world")).toBeTruthy()
  })

  // im-refactored-crayon — `adapter.start(ctx)` lifecycle wiring.

  it("calls adapter.start(ctx) with a buildAdapterContext result", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_start_ok")
    const fakeAdapter = makeFakeAdapter(row.id)
    fakeAdapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(fakeAdapter)
    mockListAdapters.mockReturnValue([fakeAdapter])

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(fakeAdapter.start).toHaveBeenCalledTimes(1)
    })
    expect(mockBuildAdapterContext).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: row.id })
    )
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: row.id, kind: "adapter.started" })
    )
  })

  it("isolates per-adapter start failures so the others still boot", async () => {
    mockedIsTauri.mockReturnValue(true)
    const okRow = makeTelegramRow("cai_start_ok")
    const failRow = makeTelegramRow("cai_start_fail")
    const okAdapter = makeFakeAdapter(okRow.id)
    const failAdapter = makeFakeAdapter(failRow.id)
    okAdapter.start.mockResolvedValue(undefined)
    failAdapter.start.mockRejectedValue(new Error("transport broken"))
    mockListEnabled.mockResolvedValue([failRow, okRow])
    mockBuildAdapterFromRow.mockResolvedValueOnce(failAdapter).mockResolvedValueOnce(okAdapter)
    mockListAdapters.mockReturnValue([okAdapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})

    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )

    await waitFor(() => {
      expect(failAdapter.start).toHaveBeenCalledTimes(1)
      expect(okAdapter.start).toHaveBeenCalledTimes(1)
    })

    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: failRow.id,
        kind: "adapter.error",
        reason: "start_failed",
      })
    )
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: okRow.id, kind: "adapter.started" })
    )
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it("calls adapter.stop() on unmount for every started adapter", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row1 = makeTelegramRow("cai_stop_1")
    const row2 = makeTelegramRow("cai_stop_2")
    const adapter1 = makeFakeAdapter(row1.id)
    const adapter2 = makeFakeAdapter(row2.id)
    adapter1.start.mockResolvedValue(undefined)
    adapter2.start.mockResolvedValue(undefined)
    adapter1.stop.mockResolvedValue(undefined)
    adapter2.stop.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row1, row2])
    mockBuildAdapterFromRow.mockResolvedValueOnce(adapter1).mockResolvedValueOnce(adapter2)
    mockListAdapters.mockReturnValue([adapter1, adapter2])

    const { unmount } = render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(adapter1.start).toHaveBeenCalledTimes(1)
      expect(adapter2.start).toHaveBeenCalledTimes(1)
    })

    unmount()
    await waitFor(() => {
      expect(adapter1.stop).toHaveBeenCalledTimes(1)
      expect(adapter2.stop).toHaveBeenCalledTimes(1)
    })
  })

  it("does not call adapter.stop() for adapters whose start() failed", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_stop_skip")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockRejectedValue(new Error("never started"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })

    unmount()
    // adapter.stop() must NOT fire — start failed, so the adapter never
    // entered the startedAdapters list.
    await new Promise((r) => setTimeout(r, 30))
    expect(adapter.stop).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("swallows adapter.stop() rejections so teardown does not crash", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_stop_throws")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    adapter.stop.mockRejectedValue(new Error("stop bombed"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })

    expect(() => unmount()).not.toThrow()
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`adapter ${row.id} failed to stop`)
      )
    })
    errSpy.mockRestore()
  })

  // im-refactored-crayon — heartbeat + lifecycle registry wiring.

  it("starts a heartbeat probe per adapter", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_hb")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(mockStartAdapterHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ adapter }))
    })
  })

  it("registers each successfully-started adapter in the lifecycle registry", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_reg")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(mockRegisterRunning).toHaveBeenCalledWith(row.id, expect.objectContaining({ adapter }))
    })
  })

  it("does not register adapters whose start() failed", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_reg_fail")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockRejectedValue(new Error("nope"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(
      <ConnectorBusProvider>
        <div>child</div>
      </ConnectorBusProvider>
    )
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })
    expect(mockRegisterRunning).not.toHaveBeenCalled()
    expect(mockStartAdapterHeartbeat).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
