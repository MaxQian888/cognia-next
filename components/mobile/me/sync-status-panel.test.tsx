/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

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

  it("splits the protocol table name into words and never composes two sentences", () => {
    // Rendered raw, the rows read "ConversationOverrides" and
    // "AgentTaskAttempts". The subtitle template "Last synced {time}" was
    // also handed "Never synced yet" as its time, so an unsynced row read
    // "Last synced Never synced yet".
    const reader = () =>
      ({
        conversationOverrides: { lastSyncAt: null, since: 0, lastError: null },
      }) as unknown as ReturnType<typeof import("@/lib/sync/companion-sync").snapshotSyncStates>
    render(<SyncStatusPanel reader={reader} />)
    const row = screen.getByTestId("sync-row-conversationOverrides")
    expect(row).toHaveTextContent("Conversation overrides")
    expect(row).not.toHaveTextContent("ConversationOverrides")
    expect(row).toHaveTextContent("Never synced yet")
    expect(row).not.toHaveTextContent("Last synced Never")
  })

  it("groups the rows under the section heading rather than a card inside a card", () => {
    const { container } = render(<SyncStatusPanel />)
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    // One surface, not a bordered group nested inside a bordered card.
    expect(container.querySelectorAll('[data-slot="item-group"]')).toHaveLength(1)
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
