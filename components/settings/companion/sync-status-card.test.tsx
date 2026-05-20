/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

const runSyncDown = jest.fn()
const snapshotSyncStates = jest.fn()

jest.mock("@/lib/sync/companion-sync", () => ({
  SYNC_HANDLER_TABLES: [
    "characters",
    "skills",
    "sessions",
    "messages",
    "workflows",
    "twinProfile",
    "plugins",
    "adapterInstances",
    "settings",
  ],
  runSyncDown: (...args: unknown[]) => runSyncDown(...args),
  snapshotSyncStates: () => snapshotSyncStates(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { SyncStatusCard } from "./sync-status-card"
import { toast } from "sonner"

const messages = {
  mobile: {
    companion: {
      syncStatus: {
        title: "Sync Status",
        description: "Per-table sync state.",
        statusHealthy: "Healthy",
        statusErrors: "Errors",
        syncAll: "Sync all",
        syncAllAria: "Sync every table",
        colTable: "Table",
        colLastSync: "Last sync",
        colCursor: "Cursor",
        colActions: "Actions",
        never: "Never",
        syncNowAria: "Sync {table}",
        toastSyncOneOk: "{table} synced",
        toastSyncOneFail: "{table} failed: {reason}",
        toastSyncAllOk: "{count} tables synced",
        toastSyncAllPartial: "{failed}/{total} tables failed",
        tableLabels: {
          characters: "Characters",
          skills: "Skills",
          sessions: "Sessions",
          messages: "Messages",
          workflows: "Workflows",
          twinProfile: "Twin profile",
          plugins: "Plugins",
          adapterInstances: "Connectors",
          settings: "Settings",
        },
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

function emptyStates() {
  const states: Record<
    string,
    { lastSyncAt: number | null; since: number; lastError: string | null }
  > = {}
  for (const table of messages.mobile.companion.syncStatus.tableLabels
    ? Object.keys(messages.mobile.companion.syncStatus.tableLabels)
    : []) {
    states[table] = { lastSyncAt: null, since: 0, lastError: null }
  }
  return states
}

describe("SyncStatusCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    snapshotSyncStates.mockReturnValue(emptyStates())
  })

  it("renders a row for every registered handler", () => {
    render(withIntl(<SyncStatusCard />))
    expect(screen.getByTestId("sync-status-row-characters")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-skills")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-sessions")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-messages")).toBeInTheDocument()
    // The four "Wave 4" handlers that previously had no UI surface:
    expect(screen.getByTestId("sync-status-row-workflows")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-twinProfile")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-plugins")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-adapterInstances")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-settings")).toBeInTheDocument()
  })

  it("renders Never when a handler has not yet synced", () => {
    render(withIntl(<SyncStatusCard />))
    const row = screen.getByTestId("sync-status-row-characters")
    expect(row).toHaveTextContent("Never")
  })

  it("calls runSyncDown({ only: [table] }) when Sync now is clicked", async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([{ ok: true, result: { table: "characters", nextSince: 42 } }])
    render(withIntl(<SyncStatusCard />))
    const btn = screen.getByRole("button", { name: /Sync Characters/i })
    await user.click(btn)
    expect(runSyncDown).toHaveBeenCalledWith({ only: ["characters"] })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("toasts an error message when a per-table sync fails", async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([{ ok: false, failure: { message: "network down" } }])
    render(withIntl(<SyncStatusCard />))
    await user.click(screen.getByRole("button", { name: /Sync Skills/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("network down"))
    )
  })

  it('calls runSyncDown() with no args when "Sync all" is clicked', async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([
      { ok: true, result: { table: "characters", nextSince: 1 } },
      { ok: true, result: { table: "skills", nextSince: 1 } },
    ])
    render(withIntl(<SyncStatusCard />))
    await user.click(screen.getByRole("button", { name: /Sync every table/i }))
    expect(runSyncDown).toHaveBeenCalledWith()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("surfaces lastError under the table label when present", async () => {
    const states = emptyStates()
    states.workflows = { lastSyncAt: null, since: 0, lastError: "auth failure" }
    snapshotSyncStates.mockReturnValue(states)
    render(withIntl(<SyncStatusCard />))
    expect(screen.getByTestId("sync-status-row-workflows-error")).toHaveTextContent("auth failure")
    expect(screen.getByText("Errors")).toBeInTheDocument()
  })

  it("shows the healthy badge when no row has an error", () => {
    render(withIntl(<SyncStatusCard />))
    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })
})
