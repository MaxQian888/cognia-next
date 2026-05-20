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

const mockDbDelete = jest.fn().mockResolvedValue(undefined)
const mockDbUpdate = jest.fn().mockResolvedValue(1)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    conversationOverrides: {
      orderBy: jest.fn().mockReturnThis(),
      reverse: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
      delete: mockDbDelete,
      update: mockDbUpdate,
    },
  })),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  setPinned: jest.fn().mockResolvedValue(undefined),
  setArchived: jest.fn().mockResolvedValue(undefined),
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
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
import { setPinned, setArchived } from "@/lib/db/conversation-overrides"

const mockSetPinned = setPinned as jest.Mock
const mockSetArchived = setArchived as jest.Mock

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
    mockSetPinned.mockReset().mockResolvedValue(undefined)
    mockSetArchived.mockReset().mockResolvedValue(undefined)
    mockDbDelete.mockReset().mockResolvedValue(undefined)
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
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c/${encodeURIComponent("conv:telegram:123")}`)
  })

  it("clicking open button navigates to /inbox/c/<conversationKey>", () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123")]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("open-btn-ov1"))
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c/${encodeURIComponent("conv:telegram:123")}`)
  })

  it("pin button toggles pinned state", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123", { pinned: false })]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("pin-btn-ov1"))
    await waitFor(() => {
      expect(mockSetPinned).toHaveBeenCalledWith("ov1", true)
    })
  })

  it("archive button toggles archived state", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123", { archived: false })]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("archive-btn-ov1"))
    await waitFor(() => {
      expect(mockSetArchived).toHaveBeenCalledWith("ov1", true)
    })
  })

  it("delete button removes the override", async () => {
    mockOverrides = [makeOverride("ov1", "conv:telegram:123")]
    render(<ConversationsTab />)
    fireEvent.click(screen.getByTestId("delete-btn-ov1"))
    await waitFor(() => {
      expect(mockDbDelete).toHaveBeenCalledWith("ov1")
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
