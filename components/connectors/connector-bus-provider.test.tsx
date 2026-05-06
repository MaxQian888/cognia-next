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
  start: jest.fn(),
  stop: jest.fn(),
  health: jest.fn(),
  send: jest.fn(),
})

beforeEach(() => {
  jest.clearAllMocks()
  mockListAdapters.mockReturnValue([])
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
})
