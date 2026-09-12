/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/components/mobile/me/transport-tier-indicator", () => ({
  TransportTierIndicator: () => <div data-testid="tier-stub" />,
}))

type SyncCall = { only?: readonly string[] } | undefined
const runSyncMock = jest.fn(async (_opts: SyncCall): Promise<unknown[]> => [])
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (opts?: SyncCall) => runSyncMock(opts),
  snapshotSyncStates: () => ({
    sessions: { lastSyncAt: 1_700_000_000_000, since: 1, lastError: null },
    messages: { lastSyncAt: null, since: 0, lastError: null },
    characters: { lastSyncAt: 1_700_001_000_000, since: 1, lastError: "oops" },
  }),
}))

const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastMock.success(m),
    error: (m: string) => toastMock.error(m),
  },
}))

import { SyncStatusPanel } from "./sync-status-panel"

type Snapshot = ReturnType<typeof import("@/lib/sync/companion-sync").snapshotSyncStates>
const asSnapshot = (o: Record<string, { lastSyncAt: number | null; lastError: string | null }>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, { ...v, since: 0 }])
  ) as unknown as Snapshot

beforeEach(() => {
  runSyncMock.mockReset()
  runSyncMock.mockResolvedValue([])
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

describe("<SyncStatusPanel />", () => {
  it("renders one row per syncable table", () => {
    render(<SyncStatusPanel />)
    expect(screen.getByTestId("sync-status-panel")).toBeInTheDocument()
    expect(screen.getByTestId("sync-row-sessions")).toBeInTheDocument()
    expect(screen.getByTestId("sync-row-messages")).toBeInTheDocument()
    expect(screen.getByTestId("sync-row-characters")).toBeInTheDocument()
  })

  it("leads with a verdict and pulls failed tables into their own group", () => {
    render(<SyncStatusPanel />)
    const summary = screen.getByTestId("sync-status-summary")
    expect(summary).toHaveAttribute("data-sync-overall", "failing")
    expect(screen.getByTestId("sync-status-headline")).toHaveTextContent("1 table needs attention")
    expect(summary).toHaveTextContent("1 of 3 tables up to date")
    const attention = screen.getByTestId("sync-attention")
    expect(within(attention).getByTestId("sync-row-characters")).toBeInTheDocument()
    expect(within(attention).queryByTestId("sync-row-sessions")).toBeNull()
    // The failed row gets a labelled retry, the others an icon-only one.
    expect(screen.getByTestId("sync-row-retry-characters")).toHaveTextContent("Retry")
    expect(screen.getByTestId("sync-row-retry-sessions")).not.toHaveTextContent("Retry")
  })

  it("orders the remaining rows never-synced first, then newest sync first", () => {
    const reader = () =>
      asSnapshot({
        old: { lastSyncAt: 1_700_000_000_000, lastError: null },
        fresh: { lastSyncAt: 1_700_009_000_000, lastError: null },
        pending: { lastSyncAt: null, lastError: null },
      })
    render(<SyncStatusPanel reader={reader} />)
    expect(screen.queryByTestId("sync-attention")).toBeNull()
    const rows = within(screen.getByTestId("sync-tables")).getAllByTestId(/^sync-row-(?!retry)/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "sync-row-pending",
      "sync-row-fresh",
      "sync-row-old",
    ])
    expect(rows[0]).toHaveAttribute("data-sync-status", "never")
    expect(rows[1]).toHaveAttribute("data-sync-status", "synced")
  })

  it("reports a healthy verdict with the last synced stamp when every table is current", () => {
    const reader = () =>
      asSnapshot({
        a: { lastSyncAt: Date.now() - 60_000, lastError: null },
        b: { lastSyncAt: Date.now() - 5_000, lastError: null },
      })
    render(<SyncStatusPanel reader={reader} />)
    const summary = screen.getByTestId("sync-status-summary")
    expect(summary).toHaveAttribute("data-sync-overall", "healthy")
    expect(screen.getByTestId("sync-status-headline")).toHaveTextContent("Everything is in sync")
    expect(summary).toHaveTextContent("2 of 2 tables up to date")
    expect(summary).toHaveTextContent(/last synced/i)
  })

  it("explains a fresh device that has never pulled", () => {
    const reader = () => asSnapshot({ a: { lastSyncAt: null, lastError: null } })
    render(<SyncStatusPanel reader={reader} />)
    expect(screen.getByTestId("sync-status-summary")).toHaveAttribute("data-sync-overall", "never")
    expect(screen.getByTestId("sync-status-headline")).toHaveTextContent("Not synced yet")
  })

  it("disables 'Sync all' when there is nothing to sync", () => {
    render(<SyncStatusPanel reader={() => asSnapshot({})} />)
    expect(screen.getByTestId("sync-status-summary")).toHaveAttribute("data-sync-overall", "empty")
    expect(screen.getByTestId("sync-status-run-all")).toBeDisabled()
    expect(screen.queryByTestId("sync-tables")).toBeNull()
  })

  it("splits the protocol table name into words and never composes two sentences", () => {
    // Rendered raw, the rows read "ConversationOverrides" and
    // "AgentTaskAttempts". The subtitle template "Last synced {time}" was
    // also handed "Never synced yet" as its time, so an unsynced row read
    // "Last synced Never synced yet".
    const reader = () =>
      asSnapshot({ conversationOverrides: { lastSyncAt: null, lastError: null } })
    render(<SyncStatusPanel reader={reader} />)
    const row = screen.getByTestId("sync-row-conversationOverrides")
    expect(row).toHaveTextContent("Conversation overrides")
    expect(row).not.toHaveTextContent("ConversationOverrides")
    expect(row).toHaveTextContent("Never synced yet")
    expect(row).not.toHaveTextContent("Last synced Never")
  })

  it("groups rows under section headings rather than a card inside a card", () => {
    const { container } = render(<SyncStatusPanel />)
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    // One surface per group: the failed table and the rest.
    expect(container.querySelectorAll('[data-slot="item-group"]')).toHaveLength(2)
  })

  it("shows lastError when the snapshot carries one", () => {
    render(<SyncStatusPanel />)
    expect(screen.getByTestId("sync-row-characters")).toHaveTextContent("oops")
  })

  it("runs a global sync when 'Sync all' is pressed", async () => {
    render(<SyncStatusPanel />)
    fireEvent.click(screen.getByTestId("sync-status-run-all"))
    await waitFor(() => expect(runSyncMock).toHaveBeenCalled())
    expect(toastMock.success).toHaveBeenCalled()
  })

  it("targets a single table when its retry button is pressed", async () => {
    render(<SyncStatusPanel />)
    fireEvent.click(screen.getByTestId("sync-row-retry-messages"))
    await waitFor(() => expect(runSyncMock).toHaveBeenCalledWith({ only: ["messages"] }))
  })

  it("surfaces sync errors via toast.error", async () => {
    runSyncMock.mockRejectedValueOnce(new Error("server gone"))
    render(<SyncStatusPanel />)
    fireEvent.click(screen.getByTestId("sync-status-run-all"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })
})
