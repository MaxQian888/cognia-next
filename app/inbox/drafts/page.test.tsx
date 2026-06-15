/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import InboxDraftsPage from "./page"

let platform: "mobile" | "tauri" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="stub-mobile-inbox" data-tab={initialTab} />
  ),
}))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="stub-inbox-shell">{children}</div>
  ),
}))
jest.mock("@/components/inbox/draft-center", () => ({
  DraftCenter: () => <div data-testid="stub-draft-center" />,
}))
jest.mock("@/components/ui/loading-states", () => ({ PageLoading: () => null }))

describe("/inbox/drafts dispatch", () => {
  it("opens the mobile inbox on the drafts tab on mobile", () => {
    platform = "mobile"
    render(<InboxDraftsPage />)
    expect(screen.getByTestId("stub-mobile-inbox")).toHaveAttribute("data-tab", "drafts")
    expect(screen.queryByTestId("stub-inbox-shell")).not.toBeInTheDocument()
  })

  it("renders the desktop InboxShell + DraftCenter on non-mobile", () => {
    platform = "web"
    render(<InboxDraftsPage />)
    expect(screen.getByTestId("stub-inbox-shell")).toBeInTheDocument()
    expect(screen.getByTestId("stub-draft-center")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-inbox")).not.toBeInTheDocument()
  })
})
