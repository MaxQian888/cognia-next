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
  InboxShell: ({ view, adapterId }: { view: string; adapterId?: string }) => (
    <div data-testid="inbox-shell" data-view={view} data-adapter-id={adapterId}>
      InboxShell
    </div>
  ),
}))
jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: ({ initialTab, adapterId }: { initialTab?: string; adapterId?: string }) => (
    <div data-testid="mobile-inbox" data-tab={initialTab} data-adapter-id={adapterId} />
  ),
}))
jest.mock("@/components/ui/loading-states", () => ({ PageLoading: () => null }))

import Page from "./page"
import MobileRouteBody from "./route-body.mobile"

beforeEach(() => {
  jest.clearAllMocks()
  compact = false
})

describe("AdapterInboxPage (/inbox/adapter?adapterId=)", () => {
  it("renders InboxShell with view=by-adapter on a wide viewport", () => {
    mockGet.mockReturnValue("a99")
    render(<Page />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-view", "by-adapter")
    expect(mockGet).toHaveBeenCalledWith("adapterId")
  })

  it("passes ?adapterId= as the scope", () => {
    mockGet.mockReturnValue("a99")
    render(<Page />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-adapter-id", "a99")
  })

  it("renders the scoped mobile inbox on a narrow viewport", () => {
    compact = true
    mockGet.mockReturnValue("a99")
    render(<Page />)
    expect(screen.queryByTestId("inbox-shell")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-tab", "messages")
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-adapter-id", "a99")
  })

  it("always renders the scoped mobile inbox in the native mobile build", () => {
    mockGet.mockReturnValue("a99")
    render(<MobileRouteBody />)
    expect(screen.getByTestId("mobile-inbox")).toHaveAttribute("data-adapter-id", "a99")
  })
})
