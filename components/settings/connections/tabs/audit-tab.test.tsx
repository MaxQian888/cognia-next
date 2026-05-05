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
    fields: { messageId: "123" },
  },
  {
    id: "e2",
    adapterId: "a2",
    kind: "delivery.error",
    at: Date.now() - 2000,
    reason: "Timeout",
  },
  {
    id: "e3",
    adapterId: "a1",
    kind: "adapter.started",
    at: Date.now() - 3000,
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

  it("renders kind filter chips for all audit kinds", () => {
    render(<AuditTab />)
    expect(screen.getByRole("button", { name: /filter by delivery\.success/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /filter by delivery\.error/i })).toBeInTheDocument()
  })

  it("renders time range options", () => {
    render(<AuditTab />)
    expect(screen.getByRole("button", { name: /last hour/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /last 24h/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /last 7d/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument()
  })

  it("renders all audit entries by default", () => {
    render(<AuditTab />)
    // These texts appear in both filter chips and in entry badges — use getAllByText
    expect(screen.getAllByText("delivery.success").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("delivery.error").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("adapter.started").length).toBeGreaterThanOrEqual(2)
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
})
