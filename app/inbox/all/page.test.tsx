/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import InboxAllPage from "./page"

let platform: "mobile" | "tauri" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

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
  it("renders the mobile-native inbox on mobile", () => {
    platform = "mobile"
    render(<InboxAllPage />)
    expect(screen.getByTestId("stub-mobile-inbox")).toHaveAttribute("data-tab", "messages")
    expect(screen.queryByTestId("stub-inbox-shell")).not.toBeInTheDocument()
  })

  it("renders the desktop InboxShell on non-mobile", () => {
    platform = "web"
    render(<InboxAllPage />)
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "all")
    expect(screen.queryByTestId("stub-mobile-inbox")).not.toBeInTheDocument()
  })
})
