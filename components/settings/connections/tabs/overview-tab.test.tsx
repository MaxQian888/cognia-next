/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { ConnectorsHealth } from "@/lib/connectors/tauri/commands"
import type { AdapterInstanceRow, ConnectorHeartbeatRow } from "@/lib/db/connector-types"
import type { AuditEntry } from "@/types/connectors/audit"

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(false) }))
jest.mock("./tunnel-tab", () => ({ TunnelTab: () => <div>Tunnel controls</div> }))

const mockRouterPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHealth: jest.fn().mockResolvedValue({
    serverRunning: false,
    boundAddr: null,
    registeredAdapterCount: 0,
  } satisfies ConnectorsHealth),
}))

// Mock getDb with a chainable no-op Dexie shape so the useLiveQuery
// factories can be executed (covering their window guards) without opening
// IndexedDB in jsdom.
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { toArray: () => Promise.resolve([]) },
    connectorAudit: {
      orderBy: () => ({
        reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
      }),
    },
    connectorHeartbeats: {
      where: () => ({ above: () => ({ toArray: () => Promise.resolve([]) }) }),
    },
  })),
}))

// The component imports HEARTBEAT_INTERVAL_MS from the heartbeat module,
// whose transitive graph (outbound-runner) is irrelevant here — stub the
// single constant instead of loading it.
jest.mock("@/lib/connectors/health/heartbeat", () => ({
  HEARTBEAT_INTERVAL_MS: 30_000,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------

import { isTauri } from "@/lib/tauri"
import { connectorsHealth } from "@/lib/connectors/tauri/commands"
import { useLiveQuery } from "dexie-react-hooks"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockConnectorsHealth = connectorsHealth as jest.MockedFunction<typeof connectorsHealth>
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { OverviewTab } from "./overview-tab"

/**
 * The component issues useLiveQuery calls in a fixed order:
 *   1 → adapterInstances, 2 → connectorAudit, 3 → connectorHeartbeats.
 * (The order repeats on re-render, hence the modulo.)
 */
function primeLiveQueries(fixtures: {
  adapters?: Partial<AdapterInstanceRow>[]
  audit?: Partial<AuditEntry>[]
  heartbeats?: Partial<ConnectorHeartbeatRow>[]
}) {
  let call = 0
  mockUseLiveQuery.mockImplementation(((factory: () => unknown) => {
    // Execute the real factory (result discarded) so its branches count
    // toward coverage; the returned value still comes from the fixtures.
    void factory()
    const slot = call % 3
    call++
    if (slot === 0) return (fixtures.adapters ?? []) as unknown
    if (slot === 1) return (fixtures.audit ?? []) as unknown
    return (fixtures.heartbeats ?? []) as unknown
  }) as typeof useLiveQuery)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(false)
  mockConnectorsHealth.mockResolvedValue({
    serverRunning: false,
    boundAddr: null,
    registeredAdapterCount: 0,
  })
  primeLiveQueries({})
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OverviewTab", () => {
  it("renders the inbound server card", () => {
    render(<OverviewTab />)
    expect(screen.getByText(/Inbound Server/i)).toBeInTheDocument()
    expect(screen.getByText("Tunnel controls")).toBeInTheDocument()
  })

  it("opens the operational Inbox from the overview", () => {
    render(<OverviewTab />)
    fireEvent.click(screen.getByTestId("connections-open-inbox"))
    expect(mockRouterPush).toHaveBeenCalledWith("/inbox")
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
    render(<OverviewTab />)
    expect(screen.getByText(/no adapters configured/i)).toBeInTheDocument()
  })

  it("shows adapter list when adapters exist", () => {
    primeLiveQueries({
      adapters: [{ id: "a1", displayName: "My Telegram Bot", type: "telegram", enabled: true }],
    })
    render(<OverviewTab />)
    expect(screen.getByText("My Telegram Bot")).toBeInTheDocument()
  })

  it("shows recent activity from audit entries", () => {
    primeLiveQueries({
      audit: [{ id: "e1", adapterId: "a1", kind: "delivery.success", at: Date.now() }],
    })
    render(<OverviewTab />)
    // Humanized via the shared audit-kind-label helper.
    expect(screen.getByText("Delivered")).toBeInTheDocument()
  })

  it("renders error, warning and success audit entries with matching badges", () => {
    primeLiveQueries({
      audit: [
        { id: "e1", adapterId: "a1", kind: "adapter.error", at: Date.now() },
        { id: "e2", adapterId: "a1", kind: "rate_limit.tripped", at: Date.now() },
        { id: "e3", adapterId: "a1", kind: "adapter.started", at: Date.now() },
      ],
    })
    render(<OverviewTab />)
    expect(screen.getByText("Adapter error")).toBeInTheDocument()
    expect(screen.getByText("Rate limit tripped")).toBeInTheDocument()
    expect(screen.getByText("Adapter started")).toBeInTheDocument()
  })

  it("survives a failing health poll", async () => {
    mockIsTauri.mockReturnValue(true)
    mockConnectorsHealth.mockRejectedValue(new Error("ipc down"))
    render(<OverviewTab />)
    // Health stays null → status renders as unknown, nothing throws.
    expect(await screen.findByText("Unknown")).toBeInTheDocument()
  })

  it("renders Recent Activity heading", () => {
    render(<OverviewTab />)
    expect(screen.getByText("Recent Activity")).toBeInTheDocument()
  })

  it("shows empty activity state when no audit entries", () => {
    render(<OverviewTab />)
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // Unified state: inbound server vs adapter runtime (gateway-only deploys)
  // -------------------------------------------------------------------------

  it("shows 'not needed' instead of 'stopped' when no enabled adapter uses the inbound server", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
    })
    render(<OverviewTab />)
    expect(
      await screen.findByText(/not needed — every enabled adapter dials out/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Stopped$/)).not.toBeInTheDocument()
    // The webhook registration count is meaningless here — hidden.
    expect(screen.queryByText(/adapters registered/i)).not.toBeInTheDocument()
  })

  it("still shows 'stopped' when a webhook adapter needs the inbound server", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        { id: "s1", displayName: "Slack", type: "slack", enabled: true, transportMode: "webhook" },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("Stopped")).toBeInTheDocument()
    expect(screen.getByText(/0 adapters registered/i)).toBeInTheDocument()
  })

  it("derives per-adapter running state from fresh heartbeats", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
      heartbeats: [
        {
          id: "hb1",
          adapterId: "lark1",
          kind: "adapter.heartbeat",
          at: Date.now(),
          fields: { state: "running" },
        },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("1 of 1 enabled adapters running")).toBeInTheDocument()
    expect(screen.getByLabelText("Adapter state: Running")).toBeInTheDocument()
    // A running adapter carries no extra state badge.
    expect(screen.queryByText("Not running")).not.toBeInTheDocument()
  })

  it("marks an enabled adapter without a fresh heartbeat as not running", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("0 of 1 enabled adapters running")).toBeInTheDocument()
    expect(screen.getByText("Not running")).toBeInTheDocument()
    expect(screen.getByLabelText("Adapter state: Not running")).toBeInTheDocument()
  })

  it("surfaces a degraded heartbeat state as a badge", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
      heartbeats: [
        {
          id: "hb1",
          adapterId: "lark1",
          kind: "adapter.heartbeat",
          at: Date.now(),
          fields: { state: "degraded" },
        },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("Degraded")).toBeInTheDocument()
    expect(screen.getByText("0 of 1 enabled adapters running")).toBeInTheDocument()
  })

  it("shows running server address and singular registered count", async () => {
    mockIsTauri.mockReturnValue(true)
    mockConnectorsHealth.mockResolvedValue({
      serverRunning: true,
      boundAddr: "127.0.0.1:7842",
      registeredAdapterCount: 1,
    })
    primeLiveQueries({
      adapters: [
        { id: "s1", displayName: "Slack", type: "slack", enabled: true, transportMode: "webhook" },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("Running — 127.0.0.1:7842")).toBeInTheDocument()
    expect(screen.getByText("1 adapter registered")).toBeInTheDocument()
  })

  it("uses the newest heartbeat when several exist and maps 'down' to a destructive badge", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
      heartbeats: [
        {
          id: "hb-old",
          adapterId: "lark1",
          kind: "adapter.heartbeat",
          at: Date.now() - 30_000,
          fields: { state: "running" },
        },
        {
          id: "hb-new",
          adapterId: "lark1",
          kind: "adapter.heartbeat",
          at: Date.now(),
          fields: { state: "down" },
        },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("Down")).toBeInTheDocument()
    expect(screen.getByText("0 of 1 enabled adapters running")).toBeInTheDocument()
  })

  it("treats a heartbeat without a state field as running", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "lark1",
          displayName: "Lark Bot",
          type: "lark",
          enabled: true,
          transportMode: "gateway",
        },
      ],
      heartbeats: [{ id: "hb1", adapterId: "lark1", kind: "adapter.heartbeat", at: Date.now() }],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("1 of 1 enabled adapters running")).toBeInTheDocument()
  })

  it("keeps the disabled badge for disabled adapters without a state badge", async () => {
    mockIsTauri.mockReturnValue(true)
    primeLiveQueries({
      adapters: [
        {
          id: "t1",
          displayName: "Old Bot",
          type: "telegram",
          enabled: false,
          transportMode: "longpoll",
        },
      ],
    })
    render(<OverviewTab />)
    expect(await screen.findByText("disabled")).toBeInTheDocument()
    expect(screen.getByLabelText("Adapter state: Disabled")).toBeInTheDocument()
    expect(screen.queryByText("Not running")).not.toBeInTheDocument()
    // Disabled rows are excluded from the running summary entirely.
    expect(screen.queryByText(/enabled adapters running/i)).not.toBeInTheDocument()
  })
})
