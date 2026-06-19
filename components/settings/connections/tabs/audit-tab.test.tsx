/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AuditEntry } from "@/types/connectors/audit"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const mockAdapters: Partial<AdapterInstanceRow>[] = [
  { id: "a1", displayName: "Telegram Bot", type: "telegram" },
  { id: "a2", displayName: "Discord Bot", type: "discord" },
]

const mockAuditEntries: Partial<AuditEntry>[] = [
  {
    id: "e1",
    adapterId: "a1",
    kind: "delivery.success",
    at: Date.now() - 1000,
    reason: "OK",
    conversationKey: "telegram:a1:12345",
    fields: { messageId: "123" },
  },
  {
    id: "e2",
    adapterId: "a2",
    kind: "delivery.error",
    at: Date.now() - 2000,
    reason: "Timeout",
    conversationKey: "discord:a2:99999",
  },
  {
    id: "e3",
    adapterId: "a1",
    kind: "adapter.started",
    at: Date.now() - 3000,
  },
  // Heartbeats — must be excluded by the default view (no selectedKinds)
  // per `types/connectors/audit.ts`'s "noisy by design" contract. Toggling
  // them on (impossible via the UI because the kind has no chip) would be
  // a separate scenario.
  {
    id: "h1",
    adapterId: "a1",
    kind: "adapter.heartbeat",
    at: Date.now() - 500,
  },
  {
    id: "h2",
    adapterId: "a2",
    kind: "adapter.heartbeat",
    at: Date.now() - 600,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { AuditTab } from "./audit-tab"

let callCount = 0

beforeEach(() => {
  jest.clearAllMocks()
  callCount = 0
  // First call = adapters, second call = audit entries
  mockUseLiveQuery.mockImplementation((() => {
    callCount++
    if (callCount === 1) return mockAdapters as unknown
    return mockAuditEntries as unknown
  }) as typeof useLiveQuery)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditTab", () => {
  it("renders the redaction reminder banner", () => {
    render(<AuditTab />)
    expect(screen.getByText(/allowlist-redacted/i)).toBeInTheDocument()
    expect(screen.getByText(/tokens and message bodies never appear/i)).toBeInTheDocument()
  })

  it("renders adapter filter chips from the adapter list", () => {
    render(<AuditTab />)
    expect(
      screen.getByRole("button", { name: /filter by adapter telegram bot/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /filter by adapter discord bot/i })
    ).toBeInTheDocument()
  })

  it("renders kind filter chips for all audit kinds (humanized labels)", () => {
    render(<AuditTab />)
    expect(screen.getByRole("button", { name: /filter by delivered/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /filter by delivery failed/i })).toBeInTheDocument()
  })

  it("renders time range options", () => {
    render(<AuditTab />)
    expect(screen.getByRole("button", { name: /last hour/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /last 24h/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /last 7d/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument()
  })

  it("renders all audit entries by default (humanized kind labels)", () => {
    render(<AuditTab />)
    // Humanized labels appear in both filter chips and entry badges — use getAllByText
    expect(screen.getAllByText("Delivered").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("Delivery failed").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("Adapter started").length).toBeGreaterThanOrEqual(2)
  })

  it("shows empty state when no entries match filters", () => {
    callCount = 0
    mockUseLiveQuery.mockImplementation((() => {
      callCount++
      if (callCount === 1) return [] as unknown
      return [] as unknown
    }) as typeof useLiveQuery)
    render(<AuditTab />)
    expect(screen.getByText(/no audit entries match/i)).toBeInTheDocument()
  })

  it("expands a row with fields when clicked", async () => {
    render(<AuditTab />)
    // e1 has fields: { messageId: "123" }
    // The row shows 'delivery.success'; clicking it should reveal the JSON
    const row = screen.getByRole("button", {
      name: /collapse|expand/i,
    })
    fireEvent.click(row)
    await waitFor(() => {
      expect(screen.getByText(/"messageId"/)).toBeInTheDocument()
    })
  })

  it("filters by conversationKey substring (case-insensitive)", async () => {
    render(<AuditTab />)
    const input = screen.getByTestId("audit-conv-key-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "TELEGRAM:A1" } })
    await waitFor(() => {
      // e1's conversationKey "telegram:a1:12345" matches; e2's "discord:a2:99999" and
      // e3 (no conversationKey) get filtered out. delivery.success still appears in
      // both the kind filter chip AND the e1 row badge.
      expect(screen.getAllByText("Delivered").length).toBeGreaterThanOrEqual(2)
      // delivery.error should now only appear in the kind filter chip (not as a row badge).
      expect(screen.getAllByText("Delivery failed").length).toBe(1)
    })
  })

  it("renders an Export trigger that disables when no entries are visible", async () => {
    render(<AuditTab />)
    const trigger = screen.getByTestId("audit-export-trigger")
    expect(trigger).toBeEnabled()
    // Drive an impossible filter to empty the list.
    const input = screen.getByTestId("audit-conv-key-input")
    fireEvent.change(input, { target: { value: "no-match-at-all-zzz" } })
    await waitFor(() => {
      expect(screen.getByTestId("audit-export-trigger")).toBeDisabled()
    })
  })

  it("renders the Export trigger with the visible-row count", () => {
    render(<AuditTab />)
    const trigger = screen.getByTestId("audit-export-trigger")
    // mockAuditEntries has 3 non-heartbeat rows + 2 heartbeats; the
    // default view hides heartbeats, so the visible count is 3.
    expect(trigger.textContent).toMatch(/3/)
  })

  it("hides adapter.heartbeat rows from the default view (noisy by design)", () => {
    render(<AuditTab />)
    // Heartbeats are present in the dataset (2 rows) but must not appear as
    // entry badges with the default (empty) `selectedKinds`. The kind filter
    // UI also intentionally has no `adapter.heartbeat` chip, so the only
    // occurrence we'd expect is in the badge for an actual entry row — and
    // that should be zero.
    expect(screen.queryByText("adapter.heartbeat")).toBeNull()
    expect(screen.queryByText("Heartbeat")).toBeNull()
    // Sanity check: non-heartbeat entries still render their badges.
    expect(screen.getAllByText("Delivered").length).toBeGreaterThanOrEqual(2)
  })
})
