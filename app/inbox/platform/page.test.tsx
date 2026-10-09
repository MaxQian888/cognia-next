/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockGet = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}))
// Layout, not runtime: a narrow browser gets the compact inbox too.
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ view, platformKind }: { view: string; platformKind?: string }) => (
    <div data-testid="inbox-shell" data-view={view} data-platform-kind={platformKind}>
      InboxShell
    </div>
  ),
}))
jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: ({
    initialTab,
    platformKind,
  }: {
    initialTab?: string
    platformKind?: string
  }) => <div data-testid="mobile-inbox" data-tab={initialTab} data-platform-kind={platformKind} />,
}))
jest.mock("@/components/ui/loading-states", () => ({ PageLoading: () => null }))

import Page from "./page"
import MobileRouteBody from "./route-body.mobile"

beforeEach(() => {
  jest.clearAllMocks()
  compact = false
})

describe("PlatformInboxPage (/inbox/platform?kind=)", () => {
  it("renders InboxShell with view=by-platform on a wide viewport", () => {
    mockGet.mockReturnValue("telegram")
    render(<Page />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-view", "by-platform")
    expect(mockGet).toHaveBeenCalledWith("kind")
  })

  it("passes ?kind= as the scope", () => {
    mockGet.mockReturnValue("telegram")
    render(<Page />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-platform-kind", "telegram")
  })

  it("renders the scoped mobile inbox on a narrow viewport", () => {
    compact = true
    mockGet.mockReturnValue("telegram")
    render(<Page />)
    expect(screen.queryByTestId("inbox-shell")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-tab", "messages")
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-platform-kind", "telegram")
  })

  it("always renders the scoped mobile inbox in the native mobile build", () => {
    mockGet.mockReturnValue("telegram")
    render(<MobileRouteBody />)
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-platform-kind", "telegram")
  })
})
