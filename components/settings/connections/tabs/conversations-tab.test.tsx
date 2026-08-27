/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderWithTooltipProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
  redirect: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    conversationOverrides: {
      orderBy: jest.fn().mockReturnThis(),
      reverse: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    },
  })),
}))

// ADR-0131 moved every write on this tab behind the cross-shell facade: the
// component describes the mutation and `lib/connectors/inbox-writes` decides
// where it runs. The suite still asserted the pre-ADR by-id Dexie helpers
// (`setPinned("ov1", true)`, `conversationOverrides.delete("ov1")`), which the
// component had stopped calling — and the facade throws
// `InboxWriteUnavailableError` under jsdom, where the shell declares no
// `connector-runtime` capability, so the clicks failed before reaching them.
// Asserting the mutation envelope is what this component is actually
// responsible for; the routing has its own tests.
const mockMutateOverride = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (...args: unknown[]) => mockMutateOverride(...args),
}))

import type { ConversationOverrideRow } from "@/lib/db/connector-types"

let mockOverrides: ConversationOverrideRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockOverrides),
}))

// ---------------------------------------------------------------------------
// Subject + imported mocks
// ---------------------------------------------------------------------------

import { ConversationsTab } from "./conversations-tab"

function makeOverride(
  id: string,
  ck: string,
  opts: Partial<ConversationOverrideRow> = {}
): ConversationOverrideRow {
  return {
    id,
    conversationKey: ck,
    sessionId: "s1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationsTab", () => {
  beforeEach(() => {
    mockOverrides = []
    mockMutateOverride.mockReset().mockResolvedValue(undefined)
    mockPush.mockReset()
  })

  it("shows empty state when no overrides", () => {
    render(<ConversationsTab />)
    expect(screen.getByText(/no conversation overrides yet/i)).toBeInTheDocument()
  })

  it("renders a row for each override", () => {
    mockOverrides = [
      makeOverride("ov1", "conv:telegram:123"),
      makeOverride("ov2", "conv:discord:456"),
    ]
    render(<ConversationsTab />)
    expect(screen.getByTestId("conversation-row-ov1")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-ov2")).toBeInTheDocument()
  })

  it("clicking the conv link navigates to /inbox/c/<conversationKey>", () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123")]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("conv-link-ov1"))
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c?key=${encodeURIComponent("conv:telegram:123")}`)
  })

  it("clicking open button navigates to /inbox/c/<conversationKey>", () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123")]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("open-btn-ov1"))
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c?key=${encodeURIComponent("conv:telegram:123")}`)
  })

  // Addressed by conversation KEY, not row id: a thin client only ever knows
  // the key, and the key is the unique index the host resolves against.
  it("pin button toggles pinned state", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123", { pinned: false })]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("pin-btn-ov1"))
    await waitFor(() => {
      expect(mockMutateOverride).toHaveBeenCalledWith({
        kind: "setPinned",
        conversationKey: "conv:telegram:123",
        pinned: true,
        sessionId: "s1",
      })
    })
  })

  it("archive button toggles archived state", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123", { archived: false })]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("archive-btn-ov1"))
    await waitFor(() => {
      expect(mockMutateOverride).toHaveBeenCalledWith({
        kind: "setArchived",
        conversationKey: "conv:telegram:123",
        archived: true,
        sessionId: "s1",
      })
    })
  })

  it("pin and archive send the opposite of the row's current state", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123", { pinned: true, archived: true })]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("pin-btn-ov1"))
    fireEvent.click(screen.getByTestId("archive-btn-ov1"))
    await waitFor(() => expect(mockMutateOverride).toHaveBeenCalledTimes(2))
    expect(mockMutateOverride).toHaveBeenCalledWith(expect.objectContaining({ pinned: false }))
    expect(mockMutateOverride).toHaveBeenCalledWith(expect.objectContaining({ archived: false }))
  })

  it("delete button removes the override", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123")]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("delete-btn-ov1"))
    await waitFor(() => {
      expect(mockMutateOverride).toHaveBeenCalledWith({
        kind: "delete",
        conversationKey: "conv:telegram:123",
      })
    })
  })

  it("renders the CU badge when allowComputerUse is true (Task 4.2)", () => {
    mockOverrides = [makeOverride("ov-cu", "telegram:a1:888", { allowComputerUse: true })]
    renderWithTooltipProvider(<ConversationsTab />)
    expect(screen.getByTestId("cu-badge-ov-cu")).toBeInTheDocument()
  })

  it("does not render the CU badge when allowComputerUse is unset", () => {
    mockOverrides = [makeOverride("ov-no-cu", "telegram:a1:777")]
    renderWithTooltipProvider(<ConversationsTab />)
    expect(screen.queryByTestId("cu-badge-ov-no-cu")).not.toBeInTheDocument()
  })

  it("does not render the CU badge when allowComputerUse is explicitly false", () => {
    mockOverrides = [makeOverride("ov-cu-off", "telegram:a1:666", { allowComputerUse: false })]
    renderWithTooltipProvider(<ConversationsTab />)
    expect(screen.queryByTestId("cu-badge-ov-cu-off")).not.toBeInTheDocument()
  })

  describe("search input (Task P2.4)", () => {
    it("does not render search when there are 5 or fewer overrides", () => {
      mockOverrides = Array.from({ length: 5 }, (_, i) =>
        makeOverride(`ov-${i}`, `telegram:a1:${i}`)
      )
      renderWithTooltipProvider(<ConversationsTab />)
      expect(screen.queryByTestId("conversations-search")).not.toBeInTheDocument()
    })

    it("renders search input once over 5 overrides exist", () => {
      mockOverrides = Array.from({ length: 6 }, (_, i) =>
        makeOverride(`ov-${i}`, `telegram:a1:${i}`)
      )
      renderWithTooltipProvider(<ConversationsTab />)
      expect(screen.getByTestId("conversations-search")).toBeInTheDocument()
    })

    it("filters by conversationKey substring (case-insensitive)", async () => {
      mockOverrides = [
        makeOverride("ov-foo", "telegram:a1:1234"),
        makeOverride("ov-bar", "discord:a2:9999"),
        ...Array.from({ length: 5 }, (_, i) => makeOverride(`ov-filler-${i}`, `slack:a3:${i}`)),
      ]
      renderWithTooltipProvider(<ConversationsTab />)
      const input = screen.getByTestId("conversations-search") as HTMLInputElement
      fireEvent.change(input, { target: { value: "DISCORD" } })
      await waitFor(() => {
        expect(screen.queryByTestId("conversation-row-ov-foo")).not.toBeInTheDocument()
        expect(screen.getByTestId("conversation-row-ov-bar")).toBeInTheDocument()
      })
    })

    it("filters by characterId substring", async () => {
      mockOverrides = [
        makeOverride("ov-a", "telegram:a1:1", { characterId: "char-zeus-001" }),
        makeOverride("ov-b", "telegram:a1:2", { characterId: "char-athena-002" }),
        ...Array.from({ length: 5 }, (_, i) => makeOverride(`ov-filler-${i}`, `slack:a3:${i}`)),
      ]
      renderWithTooltipProvider(<ConversationsTab />)
      fireEvent.change(screen.getByTestId("conversations-search"), { target: { value: "athena" } })
      await waitFor(() => {
        expect(screen.getByTestId("conversation-row-ov-b")).toBeInTheDocument()
        expect(screen.queryByTestId("conversation-row-ov-a")).not.toBeInTheDocument()
      })
    })

    it("renders the no-results hint when nothing matches", async () => {
      mockOverrides = Array.from({ length: 6 }, (_, i) =>
        makeOverride(`ov-${i}`, `telegram:a1:${i}`)
      )
      renderWithTooltipProvider(<ConversationsTab />)
      fireEvent.change(screen.getByTestId("conversations-search"), {
        target: { value: "no-such-thing" },
      })
      await waitFor(() => {
        expect(screen.getByTestId("conversations-search-empty")).toBeInTheDocument()
      })
    })
  })
})
