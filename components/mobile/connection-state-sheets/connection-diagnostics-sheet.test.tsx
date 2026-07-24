/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConnectionDiagnosticsSheet } from "./connection-diagnostics-sheet"

const tierListeners = new Set<(t: string) => void>()
let currentTier: "rtc-direct" | "rtc-relay" | "ws-lan" | "ws-tunnel" | "offline" = "offline"

jest.mock("@/lib/tauri", () => ({
  transport: {
    getActiveTier: () => currentTier,
    onTierChange: (h: (t: string) => void) => {
      tierListeners.add(h)
      // Seed mirror: call once with current tier — same contract as the
      // real CompanionTransport.
      h(currentTier)
      return () => tierListeners.delete(h)
    },
    reconnectRtc: jest.fn(() => "no-tier" as const),
  },
}))

const runSyncDownMock: jest.Mock = jest.fn(async () => undefined)
const snapshotSyncStatesMock = jest.fn(() => ({
  sessions: { lastSyncAt: 1700000000000, since: 5, lastError: null },
  messages: { lastSyncAt: null, since: 0, lastError: "rate_limited" },
  characters: { lastSyncAt: 1700000100000, since: 12, lastError: null },
  skills: { lastSyncAt: null, since: 0, lastError: null },
  workflows: { lastSyncAt: null, since: 0, lastError: null },
  twinProfile: { lastSyncAt: null, since: 0, lastError: null },
  plugins: { lastSyncAt: null, since: 0, lastError: null },
  adapterInstances: { lastSyncAt: null, since: 0, lastError: null },
  settings: { lastSyncAt: null, since: 0, lastError: null },
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
  snapshotSyncStates: () => snapshotSyncStatesMock(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Connection diagnostics",
      tierLabel: "WebRTC tier",
      "tier.rtc-direct": "Direct",
      "tier.rtc-relay": "Relay",
      "tier.ws-lan": "LAN WS",
      "tier.ws-tunnel": "Tunnel WS",
      "tier.offline": "Offline",
      "tierHint.rtc-direct": "Peer connection direct.",
      "tierHint.rtc-relay": "Peer connection via TURN.",
      "tierHint.ws-lan": "Fallback over LAN.",
      "tierHint.ws-tunnel": "Fallback via tunnel.",
      "tierHint.offline": "Disconnected.",
      reconnectButton: "Reconnect",
      noTierToast: "No WebRTC tier active.",
      syncLabel: "Sync progress",
      syncAllButton: "Sync all",
      rowRetry: "Retry",
      rowSince: "since",
      rowNever: "never",
      "toasts.syncKicked": "Sync triggered",
      "toasts.syncFailed": `Sync failed: ${(vars?.message as string) ?? ""}`,
      "toasts.reconnectStarted": "Reconnect started",
      "toasts.reconnectThrottled": "Reconnect throttled",
      "toasts.reconnectBusy": "Reconnect already in progress",
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    info: jest.fn(),
    message: jest.fn(),
    error: jest.fn(),
  },
}))

beforeEach(() => {
  tierListeners.clear()
  currentTier = "offline"
  runSyncDownMock.mockClear()
  snapshotSyncStatesMock.mockClear()
  const { transport } = jest.requireMock("@/lib/tauri") as {
    transport: { reconnectRtc: jest.Mock }
  }
  transport.reconnectRtc.mockReset().mockReturnValue("no-tier")
})

describe("ConnectionDiagnosticsSheet", () => {
  it("renders nothing while closed", () => {
    render(<ConnectionDiagnosticsSheet open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId("connection-diagnostics-sheet")).toBeNull()
  })

  it("renders the tier row when open", async () => {
    currentTier = "rtc-direct"
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    expect(await screen.findByTestId("diagnostics-tier-row")).toBeInTheDocument()
    expect(screen.getByTestId("diagnostics-tier-rtc-direct")).toBeInTheDocument()
  })

  it("renders all 9 sync table rows", async () => {
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    await screen.findByTestId("diagnostics-sync-list")
    for (const t of [
      "sessions",
      "messages",
      "characters",
      "skills",
      "workflows",
      "twinProfile",
      "plugins",
      "adapterInstances",
      "settings",
    ]) {
      expect(screen.getByTestId(`diagnostics-sync-row-${t}`)).toBeInTheDocument()
    }
  })

  it("marks rows with errors and rows with success distinctly", async () => {
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    await screen.findByTestId("diagnostics-sync-list")
    // messages has lastError → row carries destructive border class through
    // its parent <li>. Smoke-check by text content.
    const messagesRow = screen.getByTestId("diagnostics-sync-row-messages")
    expect(messagesRow).toHaveTextContent("rate_limited")
    const sessionsRow = screen.getByTestId("diagnostics-sync-row-sessions")
    // sessions has no lastError and lastSyncAt set — no error text.
    expect(sessionsRow).not.toHaveTextContent("rate_limited")
  })

  it("kicks runSyncDown when 'Sync all' is clicked", async () => {
    const user = userEvent.setup()
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    await user.click(await screen.findByTestId("diagnostics-sync-all"))
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    // Sync all → runSyncDown() with no args.
    expect(runSyncDownMock.mock.calls[0]).toEqual([])
  })

  it("kicks a single-table sync when a row's retry is clicked", async () => {
    const user = userEvent.setup()
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    await user.click(await screen.findByTestId("diagnostics-sync-retry-messages"))
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    const args = runSyncDownMock.mock.calls[0][0] as { only: string[] }
    expect(args.only).toEqual(["messages"])
  })

  it("opens the reconnect path; surfaces 'no-tier' state with a neutral toast", async () => {
    const user = userEvent.setup()
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)
    await user.click(await screen.findByTestId("diagnostics-reconnect"))
    // reconnectRtc returns "no-tier" by default mock — Sheet calls toast.message
    const { toast } = await import("sonner")
    expect((toast.message as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it("surfaces the busy outcome when a reconnect is already in progress", async () => {
    const { transport } = jest.requireMock("@/lib/tauri") as {
      transport: { reconnectRtc: jest.Mock }
    }
    transport.reconnectRtc.mockReturnValueOnce("busy")
    const user = userEvent.setup()
    render(<ConnectionDiagnosticsSheet open onOpenChange={() => {}} />)

    await user.click(await screen.findByTestId("diagnostics-reconnect"))

    const { toast } = await import("sonner")
    expect(toast.info).toHaveBeenCalledWith("Reconnect already in progress")
  })
})
