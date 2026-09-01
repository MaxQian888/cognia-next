/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"

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

interface TestQueueSummary {
  pending: number
  failed: number
  deadlettered: number
  rejected: number
  conflicted: number
}

const EMPTY_SUMMARY: TestQueueSummary = {
  pending: 0,
  failed: 0,
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
  inFlight: (summary: TestQueueSummary) => summary.pending + summary.failed,
  needsAttention: (summary: TestQueueSummary) =>
    summary.deadlettered + summary.rejected + summary.conflicted,
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

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      bannerOffline: "Offline mode",
      queuePending: `${(vars?.count as number) ?? 0} queued`,
      queueNeedsAttention: `${(vars?.count as number) ?? 0} need attention`,
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
    useNetworkStatusMock.mockReturnValue({
      loading: false,
      status: { connected: false, connectionType: "none" },
    })
    render(<OfflineBanner />)
    expect(await screen.findByTestId("offline-banner")).toHaveAttribute("data-offline", "true")
    expect(screen.getByText("Offline mode")).toBeInTheDocument()
  })

  it("shows pending-queue copy when network is up but queue has rows", async () => {
    getQueueSummaryMock.mockResolvedValue({ ...EMPTY_SUMMARY, pending: 4, failed: 1 })
    render(<OfflineBanner />)
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).toBeInTheDocument())
    const banner = screen.getByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "false")
    expect(banner).toHaveAttribute("data-stuck", "false")
    expect(screen.getByText("5 queued")).toBeInTheDocument()
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

  it("hides when network is up and queue is empty", async () => {
    render(<OfflineBanner />)
    // Wait one microtask for the initial summary to settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument()
  })
})
