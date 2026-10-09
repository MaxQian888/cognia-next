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
  useTranslations: () => {
    const t = (key: string, values?: Record<string, string>) => {
      const map: Record<string, string> = {
        title: "Inbox",
        tabsAria: "Inbox sections",
        "tabs.draftCountOverflow": "99+",
        "tabs.messages": "Messages",
        "tabs.drafts": "Drafts",
        adapter: "Adapter",
        platform: "Platform",
        clear: `Clear ${values?.name ?? ""}`,
        "names.lark": "Lark",
        "selection.select": "Select",
        "selection.done": "Done",
      }
      return map[key] ?? key
    }
    t.has = (key: string) => key === "names.lark"
    return t
  },
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: (id?: string) =>
    id === "a1" ? { id: "a1", displayName: "Support bot", type: "telegram" } : undefined,
}))
jest.mock("@/components/inbox/platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))

let mockBreakpoint: "mobile" | "tablet" | "desktop" = "mobile"
jest.mock("@/hooks/ui", () => ({
  useBreakpoint: () => mockBreakpoint,
}))

// What the stub shell reports through `onSelectableChange` (read lazily).
let mockSelectable = true
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: (props: {
    view: string
    adapterId?: string
    platformKind?: string
    embedded?: boolean
    touchSelecting?: boolean
    onTouchSelectingChange?: (selecting: boolean) => void
    onSelectableChange?: (selectable: boolean) => void
  }) => {
    const { useEffect } = jest.requireActual<typeof import("react")>("react")
    const { onSelectableChange } = props
    useEffect(() => onSelectableChange?.(mockSelectable), [onSelectableChange])
    return (
    <div
      data-testid="stub-inbox-shell"
      data-view={props.view}
      data-adapter-id={props.adapterId ?? ""}
      data-platform-kind={props.platformKind ?? ""}
      data-embedded={String(Boolean(props.embedded))}
      data-touch-selecting={String(Boolean(props.touchSelecting))}
    >
      <button type="button" onClick={() => props.onTouchSelectingChange?.(false)}>
        stub-finish-selection
      </button>
    </div>
    )
  },
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
  mockSelectable = true
  mockBreakpoint = "mobile"
  mockPush.mockReset()
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

  it("fills the shell's definite height with one top inset, and embeds the list", () => {
    // `/inbox` owns the viewport on the compact shell, which reserves the tab
    // bar; `h-[100dvh]` ignored that and the shell added a second top inset.
    render(<MobileInboxBody />)
    const body = screen.getByTestId("mobile-inbox-body")
    expect(body).toHaveClass("h-full")
    expect(body).not.toHaveClass("h-[100dvh]")
    expect(body).not.toHaveClass("safe-area-pt")
    expect(body.querySelector("header")).toHaveClass("safe-area-pt")
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-embedded", "true")
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "all")
    expect(screen.queryByTestId("mobile-inbox-scope")).not.toBeInTheDocument()
  })

  it("scopes the list to an adapter and shows a dismissible scope chip", async () => {
    const user = userEvent.setup()
    render(<MobileInboxBody adapterId="a1" />)
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "by-adapter")
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-adapter-id", "a1")
    expect(screen.getByTestId("mobile-inbox-scope")).toHaveTextContent("Adapter")
    expect(screen.getByTestId("mobile-inbox-scope-name")).toHaveTextContent("Support bot")
    await user.click(screen.getByRole("button", { name: "Clear Support bot" }))
    expect(mockPush).toHaveBeenCalledWith("/inbox/all")
  })

  it("scopes the list to a platform with its localized name", () => {
    render(<MobileInboxBody platformKind="lark" />)
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "by-platform")
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-platform-kind", "lark")
    expect(screen.getByTestId("mobile-inbox-scope-name")).toHaveTextContent("Lark")
    expect(screen.getByTestId("badge-lark")).toBeInTheDocument()
  })

  describe("selection mode", () => {
    it("toggles the list into selection mode from the header", async () => {
      const user = userEvent.setup()
      render(<MobileInboxBody />)
      const select = screen.getByTestId("mobile-inbox-select")
      expect(select).toHaveTextContent("Select")
      expect(select).toHaveAttribute("aria-pressed", "false")
      await user.click(select)
      expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-touch-selecting", "true")
      expect(select).toHaveTextContent("Done")
      await user.click(select)
      expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute(
        "data-touch-selecting",
        "false"
      )
    })

    it("leaves selection mode when the list finishes a bulk action", async () => {
      const user = userEvent.setup()
      render(<MobileInboxBody />)
      await user.click(screen.getByTestId("mobile-inbox-select"))
      await user.click(screen.getByText("stub-finish-selection"))
      expect(screen.getByTestId("mobile-inbox-select")).toHaveTextContent("Select")
    })

    it("is only offered on the Messages tab, and switching tabs ends it", async () => {
      const user = userEvent.setup()
      render(<MobileInboxBody />)
      await user.click(screen.getByTestId("mobile-inbox-select"))
      await user.click(screen.getByTestId("mobile-inbox-tab-drafts"))
      expect(screen.queryByTestId("mobile-inbox-select")).not.toBeInTheDocument()
      await user.click(screen.getByTestId("mobile-inbox-tab-messages"))
      expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute(
        "data-touch-selecting",
        "false"
      )
    })

    it("is not offered while the list has nothing to pick from", () => {
      // No host, still loading, or an empty scope: the shell says so.
      mockSelectable = false
      render(<MobileInboxBody />)
      expect(screen.queryByTestId("mobile-inbox-select")).not.toBeInTheDocument()
      expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute(
        "data-touch-selecting",
        "false"
      )
    })

    it("is not offered where the shell draws the tablet layout", () => {
      mockBreakpoint = "tablet"
      render(<MobileInboxBody />)
      expect(screen.queryByTestId("mobile-inbox-select")).not.toBeInTheDocument()
      expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute(
        "data-touch-selecting",
        "false"
      )
    })
  })
})
