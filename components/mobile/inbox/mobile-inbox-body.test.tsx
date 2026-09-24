/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { countPendingDraftsForBadge, MobileInboxBody } from "./mobile-inbox-body"
import { listAllPendingDrafts } from "@/lib/db/connector-drafts"

const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  },
}))

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

let mockDraftPanelError: Error | null = null
jest.mock("@/components/mobile/connector/draft-approval-panel", () => ({
  DraftApprovalPanel: () => {
    if (mockDraftPanelError) throw mockDraftPanelError
    return <div data-testid="stub-draft-panel" />
  },
}))

jest.mock("@/components/inbox/state/state-card", () => ({
  StateCard: {
    Error: ({ description, onRetry }: { description?: string; onRetry?: () => void }) => (
      <div data-testid="stub-state-card-error">
        <span>{description}</span>
        <button type="button" onClick={onRetry}>
          retry
        </button>
      </div>
    ),
  },
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
  mockDraftPanelError = null
  logWarn.mockReset()
  ;(listAllPendingDrafts as jest.Mock).mockReset().mockResolvedValue([])
})

describe("countPendingDraftsForBadge", () => {
  it("counts pending drafts", async () => {
    ;(listAllPendingDrafts as jest.Mock).mockResolvedValue([{ id: "d1" }, { id: "d2" }])
    await expect(countPendingDraftsForBadge()).resolves.toBe(2)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it("degrades a failed drafts read to no badge instead of throwing into the route boundary", async () => {
    ;(listAllPendingDrafts as jest.Mock).mockRejectedValue(
      new Error("TransactionInactiveError: transaction is not active")
    )
    await expect(countPendingDraftsForBadge()).resolves.toBe(0)
    expect(logWarn).toHaveBeenCalledWith("mobile inbox: pending-draft count unavailable", {
      error: "TransactionInactiveError: transaction is not active",
    })
  })
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

  it("contains a failed Drafts pane so the Messages tab keeps working, and retries it", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      mockDraftPanelError = new Error("drafts table unavailable")
      const user = userEvent.setup()
      render(<MobileInboxBody initialTab="drafts" />)

      // Pane-level fallback, not the route-wide boundary: the tab header is intact.
      expect(screen.getByTestId("stub-state-card-error")).toHaveTextContent(
        "drafts table unavailable"
      )
      expect(screen.getByTestId("mobile-inbox-body")).toBeInTheDocument()

      await user.click(screen.getByTestId("mobile-inbox-tab-messages"))
      expect(screen.getByTestId("stub-inbox-shell")).toBeInTheDocument()

      await user.click(screen.getByTestId("mobile-inbox-tab-drafts"))
      mockDraftPanelError = null
      await user.click(screen.getByRole("button", { name: "retry" }))
      expect(screen.getByTestId("stub-draft-panel")).toBeInTheDocument()
    } finally {
      consoleError.mockRestore()
    }
  })
})
