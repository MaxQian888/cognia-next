/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"

import { SessionInsightsSheet } from "./session-insights-sheet"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SessionReport } from "@/lib/analysis/session-report"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const useSessionReportMock = jest.fn()
jest.mock("@/hooks/analysis/use-session-report", () => ({
  useSessionReport: (...args: unknown[]) => useSessionReportMock(...args),
}))

const useSessionCostRankMock = jest.fn((..._args: unknown[]) => null as unknown)
jest.mock("@/hooks/usage/use-session-cost-rank", () => ({
  useSessionCostRank: (...args: unknown[]) => useSessionCostRankMock(...args),
}))

const jumpMock = jest.fn()
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...args: unknown[]) => jumpMock(...args),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

let viewProps: Record<string, unknown> = {}
jest.mock("@/components/chat/session-insights/session-report-view", () => ({
  SessionReportView: (props: Record<string, unknown>) => {
    viewProps = props
    return <div data-testid="report-view" />
  },
}))

// Passthrough the radix sheet so content renders inline in jsdom.
jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const session = { id: "s1", title: "My session" } as unknown as ChatSession

function reportStub(turns: number): SessionReport {
  return {
    turns,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 10,
    totalCostUsd: 1.5,
    unpricedTurns: 0,
  } as unknown as SessionReport
}

describe("SessionInsightsSheet", () => {
  beforeEach(() => {
    useSessionReportMock.mockReset()
    useSessionCostRankMock.mockClear()
    jumpMock.mockReset()
    toastError.mockReset()
    viewProps = {}
  })

  it("shows the loading state", () => {
    useSessionReportMock.mockReturnValue({ report: null, loading: true })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("insights-loading")).toBeInTheDocument()
  })

  it("shows the empty state when there are no turns", () => {
    useSessionReportMock.mockReturnValue({ report: reportStub(0), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("insights-empty")).toBeInTheDocument()
  })

  it("renders the report view when populated", () => {
    useSessionReportMock.mockReturnValue({ report: reportStub(3), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("report-view")).toBeInTheDocument()
  })

  it("passes null sessionId to the hook while closed", () => {
    useSessionReportMock.mockReturnValue({ report: null, loading: true })
    render(<SessionInsightsSheet session={session} open={false} onOpenChange={() => {}} />)
    expect(useSessionReportMock).toHaveBeenCalledWith(null, { title: "My session" })
  })

  it("ranks the session on its whole report and hands the rank to the view", () => {
    const rank = { percentile: 80, peers: 9, medianUsd: 0.4 }
    useSessionCostRankMock.mockReturnValue(rank)
    useSessionReportMock.mockReturnValue({ report: reportStub(3), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    expect(useSessionCostRankMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "s1", turns: 3, costUsd: 1.5, tokens: 160 }),
      expect.any(Number)
    )
    expect(viewProps.rank).toBe(rank)
  })

  it("keeps the rank query idle while closed or empty", () => {
    useSessionReportMock.mockReturnValue({ report: reportStub(0), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    expect(useSessionCostRankMock).toHaveBeenLastCalledWith(null, expect.any(Number))
  })

  it("closes the sheet and jumps to the turn, reporting a jump that did not land", async () => {
    const onOpenChange = jest.fn()
    jumpMock.mockResolvedValue(false)
    useSessionReportMock.mockReturnValue({ report: reportStub(3), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={onOpenChange} />)
    await act(async () => {
      ;(viewProps.onJumpToMessage as (id: string) => void)("msg-7")
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(jumpMock).toHaveBeenCalledWith("s1", "msg-7")
    expect(toastError).toHaveBeenCalledWith("costTimeline.jumpFailed")
  })

  it("stays quiet when the jump lands", async () => {
    jumpMock.mockResolvedValue(true)
    useSessionReportMock.mockReturnValue({ report: reportStub(3), loading: false })
    render(<SessionInsightsSheet session={session} open onOpenChange={() => {}} />)
    await act(async () => {
      ;(viewProps.onJumpToMessage as (id: string) => void)("msg-7")
    })
    expect(toastError).not.toHaveBeenCalled()
  })
})
