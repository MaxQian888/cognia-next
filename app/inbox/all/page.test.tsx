/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import InboxAllPage from "./page"

// Layout, not runtime: a narrow browser gets the compact inbox too.
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))

jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="stub-mobile-inbox" data-tab={initialTab} />
  ),
}))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ view }: { view: string }) => (
    <div data-testid="stub-inbox-shell" data-view={view} />
  ),
}))
jest.mock("@/components/ui/loading-states", () => ({ PageLoading: () => null }))

describe("/inbox/all dispatch", () => {
  it("renders the mobile-native inbox on a narrow viewport", () => {
    compact = true
    render(<InboxAllPage />)
    expect(screen.getByTestId("stub-mobile-inbox")).toHaveAttribute("data-tab", "messages")
    expect(screen.queryByTestId("stub-inbox-shell")).not.toBeInTheDocument()
  })

  it("renders the desktop InboxShell on a wide viewport", () => {
    compact = false
    render(<InboxAllPage />)
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "all")
    expect(screen.queryByTestId("stub-mobile-inbox")).not.toBeInTheDocument()
  })
})
