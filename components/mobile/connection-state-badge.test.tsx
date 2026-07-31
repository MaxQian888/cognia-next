/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConnectionStateBadge } from "./connection-state-badge"
import type { ConnectionState } from "@/lib/tauri/transport-companion"

jest.mock("@/hooks/companion/use-connection-state", () => ({
  useConnectionState: jest.fn(),
}))

// Wave 4 / ADR-0026 — minimal mocks for new dropdown dependencies.
const routerPushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: jest.fn() }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      live: "Live",
      reconnecting: "Reconnecting",
      offline: "Offline",
      repairNeeded: "Re-pair needed",
      "menu.title": "Connection",
      "actions.reconnect": "Reconnect now",
      "actions.scanLan": "Scan LAN",
      "actions.switchServer": "Switch paired server",
      "actions.goToPair": "Go to pair",
      "sync.heading": "Sync status",
      "sync.never": "never",
      "sync.justNow": "just now",
      "sync.minutesAgo": `${vars?.n ?? 0}m`,
      "sync.hoursAgo": `${vars?.n ?? 0}h`,
      "sync.daysAgo": `${vars?.n ?? 0}d`,
      "aria.menu": `${vars?.label ?? ""} — open menu`,
      "toasts.reconnectBusy": "Reconnect already in progress",
    }
    return map[key] ?? key
  },
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: jest.fn(async () => []),
  snapshotSyncStates: () => ({
    sessions: { since: 0, lastSyncAt: null, lastError: null },
    messages: { since: 0, lastSyncAt: null, lastError: null },
    characters: { since: 0, lastSyncAt: null, lastError: null },
    workflows: { since: 0, lastSyncAt: null, lastError: null },
  }),
}))

jest.mock("@/lib/tauri", () => ({
  transport: { reconnectRtc: jest.fn(() => "no-tier" as const) },
}))

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
    message: jest.fn(),
    success: jest.fn(),
  },
}))

// The two sheet components have their own deep dependencies; stub them so
// the badge test stays focused on the dropdown trigger + menu items.
jest.mock("./connection-state-sheets/mobile-server-scan-sheet", () => ({
  MobileServerScanSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="scan-sheet-open" /> : null,
}))
jest.mock("./connection-state-sheets/mobile-paired-servers-sheet", () => ({
  MobilePairedServersSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="paired-sheet-open" /> : null,
}))

import { useConnectionState } from "@/hooks/companion/use-connection-state"
const mockedUse = useConnectionState as jest.MockedFunction<typeof useConnectionState>

describe("ConnectionStateBadge", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it("renders nothing when the transport hasn't reported a state", () => {
    mockedUse.mockReturnValue(null)
    const { container } = render(<ConnectionStateBadge />)
    expect(container.firstChild).toBeNull()
  })

  it.each<[ConnectionState, string]>([
    ["connected", "Live"],
    ["reconnecting", "Reconnecting"],
    ["offline", "Offline"],
    ["unauthenticated", "Re-pair needed"],
  ])("renders the %s state with label %s", (state, label) => {
    mockedUse.mockReturnValue(state)
    render(<ConnectionStateBadge />)
    const badge = screen.getByTestId("connection-state-badge")
    expect(badge.dataset.state).toBe(state)
    expect(badge.textContent).toContain(label)
  })

  it("exposes the badge as a dropdown trigger (Wave 4)", () => {
    mockedUse.mockReturnValue("connected")
    render(<ConnectionStateBadge />)
    const trigger = screen.getByTestId("connection-state-badge")
    expect(trigger.tagName.toLowerCase()).toBe("button")
    expect(trigger).toHaveAttribute("aria-label")
  })

  it("reveals the sync-status section once the controlled menu is opened", async () => {
    // The menu is controlled (open/onOpenChange) so the relative-time clock
    // only runs while it's open; opening it must still render the sync rows.
    const user = userEvent.setup()
    mockedUse.mockReturnValue("connected")
    render(<ConnectionStateBadge />)
    await user.click(screen.getByTestId("connection-state-badge"))
    expect(await screen.findByText("Sync status")).toBeInTheDocument()
    expect(await screen.findByTestId("connection-sync-row-sessions")).toBeInTheDocument()
  })

  it("surfaces the busy outcome when a reconnect is already in progress", async () => {
    const user = userEvent.setup()
    const { transport } = jest.requireMock("@/lib/tauri") as {
      transport: { reconnectRtc: jest.Mock }
    }
    const { toast } = jest.requireMock("sonner") as { toast: { info: jest.Mock } }
    transport.reconnectRtc.mockReturnValueOnce("busy")
    mockedUse.mockReturnValue("connected")
    render(<ConnectionStateBadge />)

    await user.click(screen.getByTestId("connection-state-badge"))
    fireEvent.click(await screen.findByText("Reconnect now"))

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("Reconnect already in progress")
    )
  })
})
