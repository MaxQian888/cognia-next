/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MobileInboxBody } from "./mobile-inbox-body"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      title: "Inbox",
      tabsAria: "Inbox sections",
      "tabs.draftCountOverflow": "99+",
      "tabs.messages": "Messages",
      "tabs.drafts": "Drafts",
    }
    return map[key] ?? key
  },
}))

jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: () => <div data-testid="stub-inbox-shell" />,
}))

jest.mock("@/components/mobile/connector/draft-approval-panel", () => ({
  DraftApprovalPanel: () => <div data-testid="stub-draft-panel" />,
}))

let mockDraftCount = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockDraftCount,
}))

jest.mock("@/lib/db/connector-drafts", () => ({
  listAllPendingDrafts: jest.fn(async () => []),
}))

beforeEach(() => {
  mockDraftCount = 0
})

describe("<MobileInboxBody />", () => {
  it("defaults to the Messages tab (InboxShell list)", () => {
    render(<MobileInboxBody />)
    expect(screen.getByTestId("stub-inbox-shell")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-draft-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-inbox-tab-messages")).toHaveAttribute("aria-selected", "true")
  })

  it("opens on the Drafts tab when initialTab='drafts'", () => {
    render(<MobileInboxBody initialTab="drafts" />)
    expect(screen.getByTestId("stub-draft-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-inbox-shell")).not.toBeInTheDocument()
  })

  it("switches tabs on tap", async () => {
    const user = userEvent.setup()
    render(<MobileInboxBody />)
    await user.click(screen.getByTestId("mobile-inbox-tab-drafts"))
    expect(screen.getByTestId("stub-draft-panel")).toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-inbox-tab-messages"))
    expect(screen.getByTestId("stub-inbox-shell")).toBeInTheDocument()
  })

  it("switches tabs with the standard arrow-key interaction", async () => {
    const user = userEvent.setup()
    render(<MobileInboxBody />)
    const messagesTab = screen.getByTestId("mobile-inbox-tab-messages")
    await user.click(messagesTab)
    await user.keyboard("{ArrowRight}")
    expect(screen.getByTestId("stub-draft-panel")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-inbox-tab-drafts")).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("renders the pending-draft badge when there are drafts", () => {
    mockDraftCount = 3
    render(<MobileInboxBody />)
    expect(screen.getByTestId("mobile-inbox-tab-drafts-badge")).toHaveTextContent("3")
  })

  it("hides the badge when there are no pending drafts", () => {
    mockDraftCount = 0
    render(<MobileInboxBody />)
    expect(screen.queryByTestId("mobile-inbox-tab-drafts-badge")).not.toBeInTheDocument()
  })

  it("caps the badge at 99+", () => {
    mockDraftCount = 150
    render(<MobileInboxBody />)
    expect(screen.getByTestId("mobile-inbox-tab-drafts-badge")).toHaveTextContent("99+")
  })
})
