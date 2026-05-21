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
