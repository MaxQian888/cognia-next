/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { ConnectorsHealth } from "@/lib/connectors/tauri/commands"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AuditEntry } from "@/types/connectors/audit"

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(false) }))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHealth: jest.fn().mockResolvedValue({
    serverRunning: false,
    boundAddr: null,
    registeredAdapterCount: 0,
  } satisfies ConnectorsHealth),
}))

// Mock getDb so useLiveQuery never tries to open IndexedDB in jsdom.
const mockAdapters: AdapterInstanceRow[] = []
const mockAuditEntries: AuditEntry[] = []

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    // Return our fixture arrays based on which table is queried.
    // We identify by calling the factory and catching — simpler is to just
    // return a pre-chosen value based on call order.
    return factory instanceof Function ? undefined : undefined
  },
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------

import { isTauri } from "@/lib/tauri"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// We override useLiveQuery per test via jest.mock factory
let liveQueryCallCount = 0

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { OverviewTab } from "./overview-tab"

beforeEach(() => {
  jest.clearAllMocks()
  liveQueryCallCount = 0
  mockIsTauri.mockReturnValue(false)
  // Default: first useLiveQuery call = adapters, second = audit
  mockUseLiveQuery.mockImplementation((() => {
    liveQueryCallCount++
    if (liveQueryCallCount === 1) return mockAdapters as unknown
    return mockAuditEntries as unknown
  }) as typeof useLiveQuery)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OverviewTab", () => {
  it("renders the connector server card", () => {
    render(<OverviewTab />)
    expect(screen.getByText(/Connector Server/i)).toBeInTheDocument()
  })

  it("shows desktop-only notice in web mode", () => {
    mockIsTauri.mockReturnValue(false)
    render(<OverviewTab />)
    expect(screen.getByText(/desktop.*tauri/i)).toBeInTheDocument()
  })

  it("renders Adapters card heading", () => {
    render(<OverviewTab />)
    expect(screen.getByText("Adapters")).toBeInTheDocument()
  })

  it("shows empty state when no adapters configured", () => {
    mockUseLiveQuery.mockImplementation((() => {
      liveQueryCallCount++
      if (liveQueryCallCount === 1) return [] as unknown
      return [] as unknown
    }) as typeof useLiveQuery)
    render(<OverviewTab />)
    expect(screen.getByText(/no adapters configured/i)).toBeInTheDocument()
  })

  it("shows adapter list when adapters exist", () => {
    const adapters: Partial<AdapterInstanceRow>[] = [
      { id: "a1", displayName: "My Telegram Bot", type: "telegram", enabled: true },
    ]
    liveQueryCallCount = 0
    mockUseLiveQuery.mockImplementation((() => {
      liveQueryCallCount++
      if (liveQueryCallCount === 1) return adapters as unknown
      return [] as unknown
    }) as typeof useLiveQuery)
    render(<OverviewTab />)
    expect(screen.getByText("My Telegram Bot")).toBeInTheDocument()
  })

  it("shows recent activity from audit entries", () => {
    const entries: Partial<AuditEntry>[] = [
      {
        id: "e1",
        adapterId: "a1",
        kind: "delivery.success",
        at: Date.now(),
      },
    ]
    liveQueryCallCount = 0
    mockUseLiveQuery.mockImplementation((() => {
      liveQueryCallCount++
      if (liveQueryCallCount === 1) return [] as unknown
      return entries as unknown
    }) as typeof useLiveQuery)
    render(<OverviewTab />)
    // Humanized via the shared audit-kind-label helper.
    expect(screen.getByText("Delivered")).toBeInTheDocument()
  })

  it("renders Recent Activity heading", () => {
    render(<OverviewTab />)
    expect(screen.getByText("Recent Activity")).toBeInTheDocument()
  })

  it("shows empty activity state when no audit entries", () => {
    render(<OverviewTab />)
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument()
  })
})
