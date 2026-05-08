/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"

import { OfflineBanner } from "./offline-banner"

const platformMock = jest.fn(() => "mobile")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformMock(),
}))

const useNetworkStatusMock = jest.fn(() => ({
  loading: false,
  status: { connected: true, connectionType: "wifi" },
}))
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => useNetworkStatusMock(),
}))

const getQueueSummaryMock = jest.fn(async () => ({ pending: 0, failed: 0, deadlettered: 0 }))
jest.mock("@/lib/queue/outbound-queue", () => ({
  getQueueSummary: () => getQueueSummaryMock(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      bannerOffline: "Offline mode",
      queuePending: `${(vars?.count as number) ?? 0} queued`,
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  platformMock.mockReset().mockReturnValue("mobile")
  useNetworkStatusMock
    .mockReset()
    .mockReturnValue({ loading: false, status: { connected: true, connectionType: "wifi" } })
  getQueueSummaryMock.mockReset().mockResolvedValue({ pending: 0, failed: 0, deadlettered: 0 })
})

describe("<OfflineBanner />", () => {
  it("renders nothing on web", () => {
    platformMock.mockReturnValue("web")
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
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
    getQueueSummaryMock.mockResolvedValue({ pending: 4, failed: 1, deadlettered: 0 })
    render(<OfflineBanner />)
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).toBeInTheDocument())
    const banner = screen.getByTestId("offline-banner")
    expect(banner).toHaveAttribute("data-offline", "false")
    expect(screen.getByText("5 queued")).toBeInTheDocument()
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
