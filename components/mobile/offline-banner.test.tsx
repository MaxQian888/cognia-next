/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { claimConnectionNotice, claimQueueNotice } from "@/lib/runtime/connection-notice-claim"
import { OfflineBanner } from "./offline-banner"

const compactMock = jest.fn(() => true)
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compactMock(),
}))

const useNetworkStatusMock = jest.fn(() => ({
  loading: false,
  status: { connected: true, connectionType: "wifi" },
}))
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => useNetworkStatusMock(),
}))

type TestRuntime = {
  target: { kind: "companion" | "standalone" } | null
  connectionState: "online" | "connecting" | "offline"
}
const useRuntimeSnapshotMock = jest.fn<TestRuntime, []>(() => ({
  target: { kind: "companion" },
  connectionState: "online",
}))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => useRuntimeSnapshotMock(),
}))

interface TestQueueSummary {
  pending: number
  sending: number
  deadlettered: number
  rejected: number
  conflicted: number
}

const EMPTY_SUMMARY: TestQueueSummary = {
  pending: 0,
  sending: 0,
  deadlettered: 0,
  rejected: 0,
  conflicted: 0,
}

const getQueueSummaryMock = jest.fn(async (): Promise<TestQueueSummary> => EMPTY_SUMMARY)
// `inFlight` / `needsAttention` are pure classifiers over the summary, so the
// mock reproduces them rather than stubbing them out — a stub would let the
// banner's two branches pass while the real split was wrong.
jest.mock("@/lib/queue/outbound-queue", () => ({
  getQueueSummary: () => getQueueSummaryMock(),
  inFlight: (summary: TestQueueSummary) => summary.pending + summary.sending,
  needsAttention: (summary: TestQueueSummary) =>
    summary.deadlettered + summary.rejected + summary.conflicted,
}))

jest.mock("./outbound-queue-sheet", () => ({
  OutboundQueueSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="outbound-queue-sheet-stub" /> : null,
}))

let consentCode: string | null = null
jest.mock("@/lib/queue/outbound-approval", () => ({
  PENDING_NO_CODE: "pending",
  outboundConsentCode: () => consentCode,
  subscribeOutboundApproval: () => () => {},
  registerOutboundApprovalReporter: () => () => {},
}))

// Stand in for the Dexie live query: run the querier once on mount and on dep
// change, surfacing the resolved value like the real hook would after a write.
jest.mock("@/hooks/data", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory is hoisted above imports, so React must be required inside it.
  const React = require("react")
  return {
    useClientLiveQuery: <T,>(query: () => Promise<T> | T, deps: unknown[], initial: T): T => {
      const [value, setValue] = React.useState(initial)
      React.useEffect(() => {
        let cancelled = false
        void Promise.resolve(query()).then((r: T) => {
          if (!cancelled) setValue(r)
        })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

let pathname: string | null = "/me"
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}))

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => "mobile",
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      stateNetworkOffline: "Offline mode",
      stateHostOffline: "Host offline",
      stateReconnecting: "Reconnecting",
      detailCacheOnly: "cached only",
      detailHostOffline: "sends wait",
      detailNetworkOffline: "browse on",
      connectionSettings: "Connection",
      queuePending: `${(vars?.count as number) ?? 0} queued`,
      queuePendingWithSending: `${(vars?.count as number) ?? 0} queued · ${(vars?.sending as number) ?? 0} sending`,
      queueNeedsAttention: `${(vars?.count as number) ?? 0} need attention`,
      queueAwaitingApproval: `Waiting for approval on the host — code ${String(vars?.code ?? "")}`,
      queueAwaitingApprovalNoCode: "Waiting for approval on the host.",
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  compactMock.mockReset().mockReturnValue(true)
  useNetworkStatusMock
    .mockReset()
    .mockReturnValue({ loading: false, status: { connected: true, connectionType: "wifi" } })
  getQueueSummaryMock.mockReset().mockResolvedValue(EMPTY_SUMMARY)
  consentCode = null
  pathname = "/me"
  useRuntimeSnapshotMock
    .mockReset()
    .mockReturnValue({ target: { kind: "companion" }, connectionState: "online" })
})

describe("<OfflineBanner /> queue review", () => {
  it("opens the queue list from the banner when something is queued", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 1 })
    render(<OfflineBanner />)
    fireEvent.click(await screen.findByTestId("offline-banner-review"))
    expect(screen.getByTestId("outbound-queue-sheet-stub")).toBeInTheDocument()
  })

  it("offers the list for stuck rows too", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, rejected: 1 })
    render(<OfflineBanner />)
    expect(await screen.findByTestId("offline-banner-review")).toBeInTheDocument()
  })

  it("offers nothing to review when only the network is down", async () => {
    useRuntimeSnapshotMock.mockReturnValue({ target: { kind: "standalone" }, connectionState: "offline" })
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    render(<OfflineBanner />)
    await screen.findByTestId("offline-banner")
    expect(screen.queryByTestId("offline-banner-review")).not.toBeInTheDocument()
  })
})

describe("<OfflineBanner />", () => {
  /**
   * Behind the desktop frame there is no compact shell and no phone chrome to
   * attach a banner to. Narrowness rather than platform is the question: a
   * 375px browser tab draws the compact shell and had no offline indicator
   * anywhere in it because this asked `usePlatform()`.
   */
  it("renders nothing when the desktop frame owns the layout", () => {
    compactMock.mockReturnValue(false)
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
  })

  it("renders in a narrow browser, not only in a native shell", async () => {
    useRuntimeSnapshotMock.mockReturnValue({ target: { kind: "standalone" }, connectionState: "offline" })
    compactMock.mockReturnValue(true)
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    render(<OfflineBanner />)
    expect(await screen.findByTestId("offline-banner")).toBeInTheDocument()
  })

  it("renders nothing while network state is loading", () => {
    useNetworkStatusMock.mockReturnValue({
      loading: true,
      status: { connected: true, connectionType: "wifi" },
    })
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the offline copy when disconnected", async () => {
    useRuntimeSnapshotMock.mockReturnValue({ target: { kind: "standalone" }, connectionState: "offline" })
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    render(<OfflineBanner />)
    expect(await screen.findByTestId("offline-banner")).toHaveAttribute("data-offline", "true")
    expect(screen.getByText("Offline mode")).toBeInTheDocument()
  })

  it("shows pending-queue copy when network is up but queue has rows", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 5 })
    render(<OfflineBanner />)
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).toBeInTheDocument())
    const banner = screen.getByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "false")
    expect(banner).toHaveAttribute("data-stuck", "false")
    expect(screen.getByText("5 queued")).toBeInTheDocument()
  })

  /**
   * "2 queued" over a workflow card reading "Sending" looked like two accounts
   * of one action. The count still covers every row on its way; the rows on
   * the wire are named as such.
   */
  it("names the rows being sent right now inside the queued count", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 1, sending: 1 })
    render(<OfflineBanner />)
    expect(await screen.findByText("2 queued · 1 sending")).toBeInTheDocument()
    expect(screen.getByTestId("offline-banner-review")).toBeInTheDocument()
  })

  /**
   * The gap this closes. A `rejected` or `conflicted` receipt moved the row out
   * of `pending`, and no surface counted either — so an action the Host had
   * refused looked exactly like one that had gone through.
   */
  it("reports rows the Host refused, which nothing used to count", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, rejected: 1, conflicted: 2 })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-stuck", "true")
    expect(screen.getByText("3 need attention")).toBeInTheDocument()
  })

  /** Stuck rows win the message: nothing is retrying them. */
  it("prefers the needs-attention copy over the in-flight count", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 2, deadlettered: 1 })
    render(<OfflineBanner />)
    await screen.findByTestId("offline-banner")
    expect(screen.getByText("1 need attention")).toBeInTheDocument()
  })

  /**
   * The phone's Wi-Fi is up while the Host is asleep or redeploying. The
   * banner used to read only the device network, so this state — the one a
   * paired device hits most — showed nothing at all.
   */
  it("shows the host-unreachable copy when the network is up but the Host is offline", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "true")
    expect(banner).toHaveAttribute("data-host-offline", "true")
  })

  it("does not label an online LAN Host offline when Android has no validated Internet", async () => {
    useNetworkStatusMock.mockReturnValue({ loading: false, status: { connected: false, connectionType: "wifi" } })
    useRuntimeSnapshotMock.mockReturnValue({ target: { kind: "companion" }, connectionState: "online" })
    render(<OfflineBanner />)
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument())
  })

  it("shows the reconnecting copy while the transport is re-dialling the Host", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "connecting",
    })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "false")
    expect(banner).toHaveAttribute("data-reconnecting", "true")
    expect(banner).toHaveTextContent("Reconnecting")
  })

  // The chat's runtime strip reports the Host itself while mounted; this
  // banner must not stack a second "Reconnecting" over it, but the queue is not
  // a connection report and still shows.
  it("drops the Host connection line while the chat notice claims it", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "connecting",
    })
    const release = claimConnectionNotice()
    try {
      render(<OfflineBanner />)
      await waitFor(() => expect(getQueueSummaryMock).toHaveBeenCalled())
      expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument()
    } finally {
      release()
    }
  })

  // The composer strip carries the queue on its own line; the banner must not
  // repeat it at the top of the screen.
  it("drops the queue line too while the composer strip claims the queue", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 2 })
    const releaseConnection = claimConnectionNotice()
    const releaseQueue = claimQueueNotice()
    try {
      render(<OfflineBanner />)
      await waitFor(() => expect(getQueueSummaryMock).toHaveBeenCalled())
      expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument()
    } finally {
      releaseQueue()
      releaseConnection()
    }
  })

  it("keeps the queue line while the chat notice claims the connection", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 2 })
    const release = claimConnectionNotice()
    try {
      render(<OfflineBanner />)
      const banner = await screen.findByTestId("offline-banner")
      expect(banner).toHaveAttribute("data-offline", "false")
      expect(banner).toHaveAttribute("data-reconnecting", "false")
    } finally {
      release()
    }
  })

  /**
   * A standalone tab has no Host to be disconnected from, and the empty
   * runtime snapshot reports `offline` by construction — reading it there
   * would pin a permanent "unreachable" banner over every narrow browser.
   */
  it("ignores the Host connection state on a standalone target", () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "standalone" },
      connectionState: "offline",
    })
    render(<OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument()
  })

  it("prefers the device-offline copy when both the network and the Host are down", async () => {
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "true")
    expect(banner).toHaveAttribute("data-host-offline", "false")
  })

  it("says the Host is waiting on a human, rather than counting forever", async () => {
    // A row frozen on an interactive approval is not offline, not retrying and
    // not stuck. Reported as a plain pending count it read as a message that
    // had simply stopped, which is the silence the approval gate exists to end.
    consentCode = "A1B2C3D4"
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 1 })

    render(<OfflineBanner />)

    expect(await screen.findByText(/code A1B2C3D4/)).toBeInTheDocument()
  })

  it("still says an approval is pending against a Host that named no code", async () => {
    consentCode = "pending"
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 1 })

    render(<OfflineBanner />)

    expect(await screen.findByText("Waiting for approval on the host.")).toBeInTheDocument()
  })

  it("hides when network is up and queue is empty", async () => {
    render(<OfflineBanner />)
    // Wait one microtask for the initial summary to settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument()
  })

  /**
   * The route boundary used to stack its own "Read-only mode: …" band right
   * under this one. On the compact shell the banner now says what the state
   * means for the screen, on the same line.
   */
  it("says a read-only route shows cached data, on the same line as the state", async () => {
    pathname = "/workflows"
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "connecting",
    })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveTextContent("Reconnecting · cached only")
  })

  it("says nothing about a cache on a route that runs locally", async () => {
    pathname = "/me"
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "connecting",
    })
    render(<OfflineBanner />)
    const banner = await screen.findByTestId("offline-banner")
    expect(banner).toHaveTextContent(/^Reconnecting/)
    expect(banner).not.toHaveTextContent("cached only")
  })

  it("lets the queue outrank the cache note: it says more about what is waiting", async () => {
    pathname = "/workflows"
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 2 })
    render(<OfflineBanner />)
    expect(await screen.findByText(/2 queued/)).toBeInTheDocument()
    expect(screen.getByTestId("offline-banner")).toHaveTextContent("Host offline · 2 queued")
  })

  it("offers the connection settings while the Host is away", async () => {
    useRuntimeSnapshotMock.mockReturnValue({
      target: { kind: "companion" },
      connectionState: "offline",
    })
    render(<OfflineBanner />)
    const link = await screen.findByTestId("offline-banner-recovery")
    expect(link).toHaveTextContent("Connection")
    expect(link).toHaveAttribute("href", "/pair?mode=recover&state=offline")
  })

  it("offers no connection settings when only the device network is down", async () => {
    useRuntimeSnapshotMock.mockReturnValue({ target: { kind: "standalone" }, connectionState: "offline" })
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    render(<OfflineBanner />)
    await screen.findByTestId("offline-banner")
    expect(screen.queryByTestId("offline-banner-recovery")).not.toBeInTheDocument()
  })
})
