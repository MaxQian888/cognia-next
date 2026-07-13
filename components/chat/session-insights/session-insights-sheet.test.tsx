/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

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

jest.mock("@/components/chat/session-insights/session-report-view", () => ({
  SessionReportView: () => <div data-testid="report-view" />,
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
  return { turns } as unknown as SessionReport
}

describe("SessionInsightsSheet", () => {
  beforeEach(() => useSessionReportMock.mockReset())

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
})
