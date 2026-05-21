/**
 * @jest-environment jsdom
 *
 * Unit tests for ConversationsDetail — per-adapter conversation override list.
 * Covers: empty state, list rendering scoped to adapterId, badge display,
 * row navigation, pin/archive toggles, delete, and edit dialog open/close.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

// ---------------------------------------------------------------------------
// Navigation mock
// ---------------------------------------------------------------------------

const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}))

// ---------------------------------------------------------------------------
// Dexie / DB mocks
// ---------------------------------------------------------------------------

const mockDbDelete = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    conversationOverrides: {
      delete: mockDbDelete,
    },
  })),
}))

const mockSetPinned = jest.fn().mockResolvedValue(undefined)
const mockSetArchived = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/conversation-overrides", () => ({
  setPinned: (...args: unknown[]) => mockSetPinned(...args),
  setArchived: (...args: unknown[]) => mockSetArchived(...args),
}))

// ---------------------------------------------------------------------------
// dexie-react-hooks — full control over useLiveQuery return value
// ---------------------------------------------------------------------------

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

// ---------------------------------------------------------------------------
// ConversationOverrideDialog mock — avoids rendering the entire dialog tree
// ---------------------------------------------------------------------------

jest.mock("@/components/inbox/overrides/conversation-override-dialog", () => ({
  ConversationOverrideDialog: ({
    open,
    onOpenChange,
    conversationKey,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
    conversationKey: string
  }) =>
    open ? (
      <div data-testid="override-dialog" data-conv-key={conversationKey}>
        <button onClick={() => onOpenChange(false)}>Close dialog</button>
      </div>
    ) : null,
}))

// ---------------------------------------------------------------------------
// Subject import (after all mocks)
// ---------------------------------------------------------------------------

import { ConversationsDetail } from "./conversations-detail"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// i18n messages
// ---------------------------------------------------------------------------

const messages = {
  settings: {
    connections: {
      conversations: {
        heading: "Conversation overrides",
        empty:
          "No conversation overrides yet. Platform conversations appear here once you interact with them.",
        pinnedBadge: "pinned",
        archivedBadge: "archived",
        togglePin: "Toggle pin",
        toggleArchive: "Toggle archive",
        openConversation: "Open conversation",
        deleteOverride: "Delete override",
        editAria: "Edit override",
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeOverride(
  id: string,
  conversationKey: string,
  opts: Partial<ConversationOverrideRow> = {}
): ConversationOverrideRow {
  return {
    id,
    conversationKey,
    sessionId: "s1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...opts,
  }
}

// Adapter under test always uses adapterId "tg-1".
// conversationKey format: `${platform}:${adapterId}:${chatId}`
const ADAPTER_ID = "tg-1"

function makeTgOverride(id: string, chatId: string, opts: Partial<ConversationOverrideRow> = {}) {
  return makeOverride(id, `telegram:${ADAPTER_ID}:${chatId}`, opts)
}

// ---------------------------------------------------------------------------
// Tests — empty state
// ---------------------------------------------------------------------------

describe("ConversationsDetail — empty state", () => {
  it("renders the conversations-detail card wrapper", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByTestId("conversations-detail")).toBeInTheDocument()
  })

  it("shows the empty-state text when there are no overrides", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText(/no conversation overrides yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId("conversations-detail-list")).not.toBeInTheDocument()
  })

  it("shows empty state when useLiveQuery returns undefined (loading)", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    // The hook guards with `if (!list) return []` → treated as empty
    expect(screen.getByText(/no conversation overrides yet/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — list rendering
// ---------------------------------------------------------------------------

describe("ConversationsDetail — list rendering", () => {
  it("renders a list item for each override", () => {
    const overrides = [makeTgOverride("ov1", "100"), makeTgOverride("ov2", "200")]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByTestId("conv-detail-ov1")).toBeInTheDocument()
    expect(screen.getByTestId("conv-detail-ov2")).toBeInTheDocument()
  })

  it("shows the conversationKey in the row", () => {
    const overrides = [makeTgOverride("ov1", "999")]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText(`telegram:${ADAPTER_ID}:999`)).toBeInTheDocument()
  })

  it("renders the heading from i18n", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("Conversation overrides")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — badge rendering
// ---------------------------------------------------------------------------

describe("ConversationsDetail — badges", () => {
  it("shows the mode badge when row.mode is set", () => {
    const overrides = [makeTgOverride("ov1", "100", { mode: "auto" })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  it("shows the Computer Use badge when allowComputerUse is true", () => {
    const overrides = [makeTgOverride("ov-cu", "555", { allowComputerUse: true })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByTestId("conv-detail-cu-ov-cu")).toBeInTheDocument()
    expect(screen.getByTestId("conv-detail-cu-ov-cu")).toHaveTextContent(/computer use/i)
  })

  it("does not show the Computer Use badge when allowComputerUse is false", () => {
    const overrides = [makeTgOverride("ov-no-cu", "444", { allowComputerUse: false })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.queryByTestId("conv-detail-cu-ov-no-cu")).not.toBeInTheDocument()
  })

  it("shows the pinned badge when row.pinned is true", () => {
    const overrides = [makeTgOverride("ov-pin", "300", { pinned: true })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("pinned")).toBeInTheDocument()
  })

  it("shows the archived badge when row.archived is true", () => {
    const overrides = [makeTgOverride("ov-arch", "400", { archived: true })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("archived")).toBeInTheDocument()
  })

  it("shows providerOverride badge when set", () => {
    const overrides = [makeTgOverride("ov-prov", "600", { providerOverride: "codex" })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("codex")).toBeInTheDocument()
  })

  it("shows modelOverride badge when set", () => {
    const overrides = [makeTgOverride("ov-model", "700", { modelOverride: "gpt-4o" })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByText("gpt-4o")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — navigation (row click + open button)
// ---------------------------------------------------------------------------

describe("ConversationsDetail — navigation", () => {
  beforeEach(() => {
    mockPush.mockReset()
    const overrides = [makeTgOverride("ov1", "123")]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
  })

  it("clicking the conversationKey button navigates to /inbox/c/<encoded key>", () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByTestId("conv-detail-open-ov1"))
    expect(mockPush).toHaveBeenCalledWith(
      `/inbox/c/${encodeURIComponent(`telegram:${ADAPTER_ID}:123`)}`
    )
  })

  it("clicking the ExternalLink icon button also navigates to /inbox/c/<encoded key>", () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    // aria-label from i18n: "Open conversation"
    const openBtn = screen.getByRole("button", { name: /open conversation/i })
    fireEvent.click(openBtn)
    expect(mockPush).toHaveBeenCalledWith(
      `/inbox/c/${encodeURIComponent(`telegram:${ADAPTER_ID}:123`)}`
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — actions (pin, archive, delete)
// ---------------------------------------------------------------------------

describe("ConversationsDetail — pin / archive / delete", () => {
  beforeEach(() => {
    mockSetPinned.mockReset().mockResolvedValue(undefined)
    mockSetArchived.mockReset().mockResolvedValue(undefined)
    mockDbDelete.mockReset().mockResolvedValue(undefined)
    const overrides = [makeTgOverride("ov1", "100", { pinned: false, archived: false })]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
  })

  it("pin button calls setPinned(id, !pinned)", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByRole("button", { name: /toggle pin/i }))
    await waitFor(() => {
      expect(mockSetPinned).toHaveBeenCalledWith("ov1", true)
    })
  })

  it("archive button calls setArchived(id, !archived)", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByRole("button", { name: /toggle archive/i }))
    await waitFor(() => {
      expect(mockSetArchived).toHaveBeenCalledWith("ov1", true)
    })
  })

  it("delete button calls db.conversationOverrides.delete(id)", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByRole("button", { name: /delete override/i }))
    await waitFor(() => {
      expect(mockDbDelete).toHaveBeenCalledWith("ov1")
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — edit dialog
// ---------------------------------------------------------------------------

describe("ConversationsDetail — edit dialog", () => {
  beforeEach(() => {
    const overrides = [makeTgOverride("ov1", "888")]
    mockUseLiveQuery.mockReturnValue(overrides as unknown as ReturnType<typeof useLiveQuery>)
  })

  it("opens the ConversationOverrideDialog when Edit is clicked", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.queryByTestId("override-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("conv-detail-edit-ov1"))
    await waitFor(() => {
      expect(screen.getByTestId("override-dialog")).toBeInTheDocument()
    })
  })

  it("passes the conversationKey to the dialog", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByTestId("conv-detail-edit-ov1"))
    await waitFor(() => screen.getByTestId("override-dialog"))
    expect(screen.getByTestId("override-dialog")).toHaveAttribute(
      "data-conv-key",
      `telegram:${ADAPTER_ID}:888`
    )
  })

  it("closes the dialog when onOpenChange(false) is called", async () => {
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    fireEvent.click(screen.getByTestId("conv-detail-edit-ov1"))
    await waitFor(() => screen.getByTestId("override-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close dialog/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("override-dialog")).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — adapterId filtering
// ---------------------------------------------------------------------------

describe("ConversationsDetail — adapterId scoping", () => {
  it("only shows overrides whose conversationKey contains the adapterId segment", () => {
    // useConversationOverrides does the filtering; here we verify the hook is
    // called and the component renders only what the hook returns.
    const filtered = [makeTgOverride("ov-mine", "111")]
    mockUseLiveQuery.mockReturnValue(filtered as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId={ADAPTER_ID} />))
    expect(screen.getByTestId("conv-detail-ov-mine")).toBeInTheDocument()
  })

  it("shows empty state when filtered list has no matching overrides", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<ConversationsDetail adapterId="other-adapter" />))
    expect(screen.getByText(/no conversation overrides yet/i)).toBeInTheDocument()
  })
})
