/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

let mockParams = new URLSearchParams()
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/conversations",
}))

// The page's data and writes are the hook's suite; here only what the page
// draws from them and hands back.
const mockUseManager = jest.fn()
let mockData: Record<string, unknown> = {}
jest.mock("@/hooks/conversations/use-conversation-manager", () => ({
  useConversationManager: (options: { query: string }) => {
    mockUseManager(options)
    // The hook ranks rows whenever a query is set.
    return { ranked: options.query.trim() !== "", ...mockData }
  },
}))
const mockUsageIds = jest.fn()
jest.mock("@/hooks/usage/use-session-usage-summaries", () => ({
  useSessionUsageSummaries: (ids: string[]) => {
    mockUsageIds(ids)
    return { summaries: new Map(), loading: false }
  },
}))

const mockGoalIds = jest.fn()
let mockGoals: ReadonlyMap<string, unknown> = new Map()
jest.mock("@/hooks/conversations/use-session-goals", () => ({
  useSessionGoals: (ids: string[]) => {
    mockGoalIds(ids)
    return mockGoals
  },
}))
let mockCompact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => mockCompact,
}))

// Each row is marked on its container, as the real table row is, with a
// checkbox and a title button inside it.
const mockTableProps = jest.fn()
jest.mock("./conversation-manager-table", () => ({
  ConversationManagerTable: (props: { rows: ChatSession[] }) => {
    mockTableProps(props)
    return (
      <div data-testid="table">
        {props.rows.length}
        {props.rows.map((row) => (
          <div key={row.id} data-conversation-row={row.id}>
            <input type="checkbox" aria-label={`select ${row.id}`} />
            <button type="button">{row.id}</button>
          </div>
        ))}
      </div>
    )
  },
}))
const mockListProps = jest.fn()
jest.mock("./conversation-manager-list", () => ({
  ConversationManagerList: (props: { rows: ChatSession[] }) => {
    mockListProps(props)
    return <div data-testid="list">{props.rows.length}</div>
  },
}))
jest.mock("./auto-archive-control", () => ({
  AutoArchiveControl: ({ variant }: { variant: string }) => (
    <div data-testid={`auto-archive-${variant}`} />
  ),
}))
const mockBulkProps = jest.fn()
jest.mock("@/components/desktop/channel-list-bulk-actions", () => ({
  ChannelListBulkActions: (props: unknown) => {
    mockBulkProps(props)
    return null
  },
}))
jest.mock("@/components/chat/conversation-filter-controls", () => ({
  ConversationFilterMenu: () => <div data-testid="filter-menu" />,
  ConversationFilterChips: () => <div data-testid="filter-chips" />,
}))
const mockEmptyArchiveProps = jest.fn()
jest.mock("@/components/chat/empty-archive-dialog", () => ({
  EmptyArchiveDialog: (props: { open: boolean; sessions: ChatSession[]; scopeLabel: string }) => {
    mockEmptyArchiveProps(props)
    return props.open ? <div data-testid="empty-archive-dialog">{props.scopeLabel}</div> : null
  },
}))
jest.mock("@/components/chat/conversation-export-dialog", () => ({
  ConversationExportDialog: ({ session }: { session: ChatSession | null }) =>
    session ? <div data-testid="export-dialog">{session.id}</div> : null,
}))
const mockPalette = jest.fn()
jest.mock("@/lib/shell/command-palette-request", () => ({
  requestCommandPalette: (request: unknown) => mockPalette(request),
}))
const mockTrackView = jest.fn(async (_view: string) => true)
jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationViewChanged: (view: string) => mockTrackView(view),
}))

import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { CONVERSATION_MANAGER_PAGE_SIZE } from "@/lib/conversations/conversation-manager"
import { ConversationManager } from "./conversation-manager"

const session = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

function data(over: Record<string, unknown> = {}) {
  const rows = (over.rows as ChatSession[] | undefined) ?? [session("a"), session("b")]
  return {
    tab: "active",
    setTab: jest.fn(),
    loading: false,
    counts: { active: 2, archived: 1 },
    rows,
    orderedIds: rows.map((row) => row.id),
    archiveOrder: null,
    setArchiveOrder: jest.fn(),
    model: {
      sections: [{ key: "recent", sessions: rows }],
      orderedIds: rows.map((row) => row.id),
      total: rows.length,
      filteredCount: rows.length,
      activeFilterCount: 0,
      contentOnlyIds: new Set<string>(),
    },
    filterController: { filters: {}, actions: { reset: jest.fn() } },
    sortBy: "recent",
    setSortBy: jest.fn(),
    searchContent: false,
    setSearchContent: jest.fn(),
    content: { belowMinQuery: false, pending: false, failed: false, truncated: false },
    sessions: rows,
    archivedSessions: [session("z", { archivedAt: 9 })],
    folders: [],
    unreadIds: new Set<string>(),
    unreadCountById: new Map(),
    runStatusById: new Map(),
    decorations: {},
    workspaceNameById: new Map(),
    rowActions: {},
    extraActions: {},
    exportSession: null,
    closeExport: jest.fn(),
    openConversation: jest.fn(),
    startConversation: jest.fn(),
    ...over,
  }
}

// `TooltipProvider` is mounted in the root layout.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider })

beforeEach(() => {
  __resetAppRuntimeForTesting()
  jest.clearAllMocks()
  mockParams = new URLSearchParams()
  mockData = data()
  mockGoals = new Map()
  mockCompact = false
})

type SelectFn = (id: string, event: object) => void
const lastTable = () =>
  mockTableProps.mock.lastCall![0] as {
    onToggleSelect: SelectFn
    showWorkspace: boolean
    ranked: boolean
    goals: ReadonlyMap<string, unknown>
  }
const lastList = () =>
  mockListProps.mock.lastCall![0] as {
    selecting: boolean
    onStartSelecting: (id: string) => void
    onToggleSelect: SelectFn
    goals: ReadonlyMap<string, unknown>
  }
const lastBulk = () =>
  mockBulkProps.mock.lastCall![0] as {
    visible: boolean
    selected: Set<string>
    onClear: () => void
  }
const toggle = { ctrlKey: true, metaKey: false, shiftKey: false }

describe("ConversationManager", () => {
  it("names the page, and counts each tab", () => {
    render(<ConversationManager />)
    // A desktop keeps the tabs in the header, beside the search.
    expect(
      within(screen.getByTestId("conversation-manager-header")).getByTestId(
        "conversation-manager-tabs"
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Conversations" })).toBeInTheDocument()
    expect(screen.getByTestId("conversation-manager-tab-count-active")).toHaveTextContent("2")
    expect(screen.getByTestId("conversation-manager-tab-count-archived")).toHaveTextContent("1")
    // The tabs carry both counts; the header no longer repeats them.
    expect(screen.queryByText(/2 active/)).not.toBeInTheDocument()
  })

  it("opens the tab its address names, and the Active tab without one", () => {
    mockParams = new URLSearchParams("tab=archived")
    const { unmount } = render(<ConversationManager />)
    expect(mockData.setTab).toHaveBeenLastCalledWith("archived")
    unmount()
    mockParams = new URLSearchParams("tab=bogus")
    render(<ConversationManager />)
    expect(mockData.setTab).toHaveBeenLastCalledWith("active")
  })

  it("writes a picked tab back into the address and reports it", async () => {
    const user = userEvent.setup()
    render(<ConversationManager />)
    await user.click(screen.getByTestId("conversation-manager-tab-archived"))
    expect(mockData.setTab).toHaveBeenLastCalledWith("archived")
    expect(mockReplace).toHaveBeenCalledWith("/conversations?tab=archived")
    expect(mockTrackView).toHaveBeenCalledWith("archived")
  })

  it("starts a new chat from the Active tab", () => {
    render(<ConversationManager />)
    fireEvent.click(screen.getByTestId("conversation-manager-new-chat"))
    expect(mockData.startConversation).toHaveBeenCalled()
    expect(screen.queryByTestId("conversation-manager-archive-panel")).not.toBeInTheDocument()
  })

  it("empties the archive from the Archived tab, across every workspace", () => {
    mockData = data({ tab: "archived" })
    render(<ConversationManager />)
    expect(screen.queryByTestId("conversation-manager-new-chat")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("conversation-manager-empty-archive"))
    expect(screen.getByTestId("empty-archive-dialog")).toHaveTextContent("All workspaces")
    expect(mockEmptyArchiveProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, sessions: mockData.archivedSessions })
    )
  })

  it("cannot empty an empty archive", () => {
    mockData = data({ tab: "archived", archivedSessions: [] })
    render(<ConversationManager />)
    expect(screen.getByTestId("conversation-manager-empty-archive")).toBeDisabled()
  })

  it("shows the archive's rules and the auto-archive policy on the Archived tab", () => {
    mockData = data({ tab: "archived" })
    render(<ConversationManager />)
    const panel = screen.getByTestId("conversation-manager-archive-panel")
    expect(within(panel).getByText(/keep their pin and folder/)).toBeInTheDocument()
    expect(within(panel).getByTestId("auto-archive-inline")).toBeInTheDocument()
  })

  it("settles the search before the list reads it, and clears at once", () => {
    jest.useFakeTimers()
    try {
      render(<ConversationManager />)
      const field = screen.getByTestId("conversation-manager-search")
      fireEvent.change(field, { target: { value: "plan" } })
      expect(mockUseManager).toHaveBeenLastCalledWith({ query: "" })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(mockUseManager).toHaveBeenLastCalledWith({ query: "plan" })
      fireEvent.click(screen.getByTestId("conversation-manager-search-clear"))
      expect(mockUseManager).toHaveBeenLastCalledWith({ query: "" })
      expect(field).toHaveValue("")

      fireEvent.change(field, { target: { value: "again" } })
      fireEvent.keyDown(field, { key: "Escape" })
      expect(field).toHaveValue("")
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(mockUseManager).toHaveBeenLastCalledWith({ query: "" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("switches message-content search", () => {
    render(<ConversationManager />)
    fireEvent.click(screen.getByTestId("conversation-manager-search-content"))
    expect(mockData.setSearchContent).toHaveBeenCalledWith(true)
  })

  it("says what a content search is doing", () => {
    mockData = data({
      content: { belowMinQuery: false, pending: true, failed: false, truncated: false },
    })
    const { rerender } = render(<ConversationManager />)
    expect(screen.getByRole("status")).toHaveTextContent(/Searching messages/i)
    mockData = data({
      content: { belowMinQuery: true, pending: false, failed: false, truncated: false },
    })
    rerender(<ConversationManager />)
    expect(screen.getByRole("status")).toHaveTextContent(/2/)
  })

  it("draws a loading state while the conversations load", () => {
    mockData = data({ loading: true })
    render(<ConversationManager />)
    expect(screen.getByLabelText("Loading conversations")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("table")).not.toBeInTheDocument()
  })

  it("offers a new chat when there are none, and the way back from an empty archive", () => {
    mockData = data({ rows: [] })
    const { unmount } = render(<ConversationManager />)
    const empty = screen.getByTestId("channel-list-empty-state")
    // The header already says "New chat"; the body says why it is empty.
    expect(within(empty).getByText("No conversations yet")).toBeInTheDocument()
    fireEvent.click(within(empty).getByRole("button"))
    expect(mockData.startConversation).toHaveBeenCalled()
    unmount()

    mockData = data({ rows: [], tab: "archived" })
    render(<ConversationManager />)
    fireEvent.click(screen.getByTestId("channel-list-empty-show-active"))
    expect(mockData.setTab).toHaveBeenLastCalledWith("active")
    expect(mockReplace).toHaveBeenCalledWith("/conversations")
  })

  function narrowed(tab: "active" | "archived", activeFilterCount: number) {
    const base = data({ tab })
    return {
      ...base,
      model: { ...(base.model as object), filteredCount: 0, activeFilterCount },
    }
  }

  it("clears the filters that hid every row", () => {
    mockData = narrowed("active", 2)
    render(<ConversationManager />)
    expect(screen.getByTestId("channel-list-empty-narrowed")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("channel-list-empty-clear-filters"))
    expect(
      (mockData.filterController as { actions: { reset: jest.Mock } }).actions.reset
    ).toHaveBeenCalled()
    expect(screen.queryByTestId("channel-list-empty-widen-content")).not.toBeInTheDocument()
  })

  it("widens a search that found nothing, staying in the archive", () => {
    jest.useFakeTimers()
    try {
      mockData = narrowed("archived", 0)
      render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      fireEvent.click(screen.getByTestId("channel-list-empty-widen-content"))
      expect(mockData.setSearchContent).toHaveBeenCalledWith(true)
      fireEvent.click(screen.getByTestId("channel-list-empty-search-everywhere"))
      expect(mockPalette).toHaveBeenCalledWith({ query: "is:archived plan", scope: "chats" })
      fireEvent.click(screen.getByTestId("channel-list-empty-clear-search"))
      expect(screen.getByTestId("conversation-manager-search")).toHaveValue("")
    } finally {
      jest.useRealTimers()
    }
  })

  it("takes a search that found nothing to the other tab, keeping the query", () => {
    jest.useFakeTimers()
    try {
      mockData = narrowed("active", 0)
      const { unmount } = render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      const widen = screen.getByTestId("channel-list-empty-widen-archived")
      expect(widen).toHaveTextContent("Search archived conversations")
      fireEvent.click(widen)
      expect(mockData.setTab).toHaveBeenLastCalledWith("archived")
      expect(mockReplace).toHaveBeenLastCalledWith("/conversations?tab=archived")
      expect(screen.getByTestId("conversation-manager-search")).toHaveValue("plan")
      unmount()

      mockData = narrowed("archived", 0)
      render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      fireEvent.click(screen.getByTestId("channel-list-empty-widen-active"))
      expect(mockData.setTab).toHaveBeenLastCalledWith("active")
    } finally {
      jest.useRealTimers()
    }
  })

  it("offers no other tab that holds nothing", () => {
    jest.useFakeTimers()
    try {
      mockData = { ...narrowed("active", 0), counts: { active: 2, archived: 0 } }
      render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(screen.getByTestId("channel-list-empty-narrowed")).toBeInTheDocument()
      expect(screen.queryByTestId("channel-list-empty-widen-archived")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("offers no content widening once content search is on", () => {
    jest.useFakeTimers()
    try {
      mockData = { ...narrowed("active", 0), searchContent: true }
      render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(screen.getByTestId("channel-list-empty-narrowed")).toBeInTheDocument()
      expect(screen.queryByTestId("channel-list-empty-widen-content")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("draws a page of rows at a time and loads usage for that page only", () => {
    const rows = Array.from({ length: CONVERSATION_MANAGER_PAGE_SIZE + 30 }, (_, index) =>
      session(`s${index}`)
    )
    mockData = data({ rows })
    render(<ConversationManager />)
    expect(screen.getByTestId("table")).toHaveTextContent(String(CONVERSATION_MANAGER_PAGE_SIZE))
    expect(mockUsageIds).toHaveBeenLastCalledWith(
      rows.slice(0, CONVERSATION_MANAGER_PAGE_SIZE).map((row) => row.id)
    )
    expect(
      screen.getByText(`Showing ${CONVERSATION_MANAGER_PAGE_SIZE} of ${rows.length}`)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("conversation-manager-show-more"))
    expect(screen.getByTestId("table")).toHaveTextContent(String(rows.length))
    expect(screen.queryByTestId("conversation-manager-show-more")).not.toBeInTheDocument()
    // Select-all reaches the whole view, not the page drawn.
    expect(mockTableProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ totalInView: rows.length })
    )
  })

  it("selects rows into the bulk bar, and drops the selection with the tab", () => {
    const { rerender } = render(<ConversationManager />)
    expect(mockBulkProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: "bar", visible: false, archived: false })
    )
    const { onToggleSelect } = mockTableProps.mock.lastCall![0] as {
      onToggleSelect: (id: string, event: object) => void
    }
    act(() => onToggleSelect("a", { ctrlKey: true, metaKey: false, shiftKey: false }))
    expect(mockBulkProps).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    expect([...(mockBulkProps.mock.lastCall![0] as { selected: Set<string> }).selected]).toEqual([
      "a",
    ])

    mockData = { ...mockData, tab: "archived" }
    rerender(<ConversationManager />)
    expect(mockBulkProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false, archived: true })
    )
  })

  it("archives or unarchives the focused row with the archive chord", () => {
    const onArchive = jest.fn()
    const onUnarchive = jest.fn()
    mockData = data({
      rows: [session("a"), session("old", { archivedAt: 3 })],
      rowActions: { onArchive, onUnarchive },
    })
    render(<ConversationManager />)
    // The page registers the chord; the shortcut runtime dispatches to it.
    const fire = () =>
      act(() =>
        getAppRegistration("shell.conversation.toggleArchive")!.handler(
          new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, shiftKey: true })
        )
      )
    // Nothing focused: nothing to act on, and no open conversation to fall back to.
    fire()
    expect(onArchive).not.toHaveBeenCalled()

    screen.getByRole("button", { name: "a" }).focus()
    fire()
    expect(onArchive).toHaveBeenCalledWith("a")

    screen.getByRole("button", { name: "old" }).focus()
    fire()
    expect(onUnarchive).toHaveBeenCalledWith("old")
  })

  it("archives the row whose checkbox has focus, not only its title", () => {
    const onArchive = jest.fn()
    mockData = data({ rowActions: { onArchive } })
    render(<ConversationManager />)
    screen.getByRole("checkbox", { name: "select b" }).focus()
    act(() =>
      getAppRegistration("shell.conversation.toggleArchive")!.handler(
        new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, shiftKey: true })
      )
    )
    expect(onArchive).toHaveBeenCalledWith("b")
  })

  it("loads goals for the drawn page and hands them to the table", () => {
    const goal = { id: "g1", sessionId: "a" }
    mockGoals = new Map([["a", goal]])
    render(<ConversationManager />)
    expect(mockGoalIds).toHaveBeenLastCalledWith(["a", "b"])
    expect(lastTable().goals.get("a")).toBe(goal)
  })

  it("shows the workspace column only when the rows span several workspaces", () => {
    mockData = data({
      rows: [session("a", { projectId: "p1" }), session("b", { projectId: "p1" })],
    })
    const { unmount } = render(<ConversationManager />)
    expect(lastTable().showWorkspace).toBe(false)
    unmount()
    mockData = data({ rows: [session("a", { projectId: "p1" }), session("b")] })
    render(<ConversationManager />)
    expect(lastTable().showWorkspace).toBe(true)
  })

  it("gives the Archived tab its own column, ordered by the page's archive order", () => {
    const { unmount } = render(<ConversationManager />)
    expect((mockTableProps.mock.lastCall![0] as { archive?: unknown }).archive).toBeUndefined()
    unmount()

    mockData = data({ tab: "archived", archiveOrder: "archivedAsc" })
    render(<ConversationManager />)
    const archive = (
      mockTableProps.mock.lastCall![0] as {
        archive: { order: string | null; onOrder: (order: string) => void }
      }
    ).archive
    expect(archive.order).toBe("archivedAsc")
    archive.onOrder("archived")
    expect(mockData.setArchiveOrder).toHaveBeenCalledWith("archived")
  })

  it("selects across the order the rows draw in, not the list model's", () => {
    const rows = [session("a"), session("b"), session("c")]
    mockData = data({ rows, orderedIds: ["c", "b", "a"] })
    render(<ConversationManager />)
    expect((mockBulkProps.mock.lastCall![0] as { orderedIds: string[] }).orderedIds).toEqual([
      "c",
      "b",
      "a",
    ])
    act(() => lastTable().onToggleSelect("c", toggle))
    act(() => lastTable().onToggleSelect("b", { ...toggle, shiftKey: true }))
    expect([...lastBulk().selected].sort()).toEqual(["b", "c"])
  })

  it("says the unread order, which no column header can", () => {
    mockData = data({ sortBy: "unread" })
    const { unmount } = render(<ConversationManager />)
    expect(screen.getByTestId("conversation-manager-unread-sort")).toHaveTextContent(
      "Unread conversations first"
    )
    unmount()
    // The archive's own order replaces it.
    mockData = data({ sortBy: "unread", tab: "archived", archiveOrder: "archived" })
    render(<ConversationManager />)
    expect(screen.queryByTestId("conversation-manager-unread-sort")).not.toBeInTheDocument()
  })

  it("says the rows are ranked while a query orders them", () => {
    jest.useFakeTimers()
    try {
      render(<ConversationManager />)
      expect(lastTable().ranked).toBe(false)
      expect(screen.queryByTestId("conversation-manager-ranked")).not.toBeInTheDocument()
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(lastTable().ranked).toBe(true)
      expect(screen.getByTestId("conversation-manager-ranked")).toHaveTextContent(
        "Sorted by relevance while searching"
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("leaves the ranked hint out when one row or fewer matches", () => {
    jest.useFakeTimers()
    try {
      mockData = data({ rows: [session("a")] })
      render(<ConversationManager />)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "plan" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(lastTable().ranked).toBe(true)
      expect(screen.queryByTestId("conversation-manager-ranked")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("says it is still searching messages rather than drawing nothing", () => {
    const base = narrowed("active", 0)
    mockData = {
      ...base,
      content: { belowMinQuery: false, pending: true, failed: false, truncated: false },
    }
    render(<ConversationManager />)
    expect(screen.getByTestId("conversation-manager-searching")).toHaveTextContent(
      /Searching messages/i
    )
    expect(screen.queryByTestId("channel-list-empty-narrowed")).not.toBeInTheDocument()
    expect(screen.queryByTestId("table")).not.toBeInTheDocument()
  })

  it("drops the selection when the query changes", () => {
    jest.useFakeTimers()
    try {
      render(<ConversationManager />)
      act(() => lastTable().onToggleSelect("a", toggle))
      expect(lastBulk().visible).toBe(true)
      fireEvent.change(screen.getByTestId("conversation-manager-search"), {
        target: { value: "a" },
      })
      act(() => {
        jest.advanceTimersByTime(150)
      })
      expect(lastBulk().visible).toBe(false)
      expect(lastBulk().selected.size).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("drops the selection when the filters change, but keeps it across a sort", () => {
    const { rerender } = render(<ConversationManager />)
    act(() => lastTable().onToggleSelect("a", toggle))
    expect(lastBulk().visible).toBe(true)

    mockData = { ...mockData, sortBy: "title" }
    rerender(<ConversationManager />)
    expect([...lastBulk().selected]).toEqual(["a"])

    mockData = {
      ...mockData,
      filterController: { filters: { pinned: true }, actions: { reset: jest.fn() } },
    }
    rerender(<ConversationManager />)
    expect(lastBulk().visible).toBe(false)
    expect(lastBulk().selected.size).toBe(0)
  })

  describe("on a phone-width page", () => {
    beforeEach(() => {
      mockCompact = true
    })

    it("draws the list instead of the table, with the search on its own row", () => {
      const goal = { id: "g1", sessionId: "a" }
      mockGoals = new Map([["a", goal]])
      render(<ConversationManager />)
      expect(screen.getByTestId("list")).toHaveTextContent("2")
      expect(screen.queryByTestId("table")).not.toBeInTheDocument()
      const tools = screen.getByTestId("conversation-manager-compact-tools")
      expect(within(tools).getByTestId("conversation-manager-search")).toBeInTheDocument()
      expect(within(tools).getByTestId("conversation-manager-search-content")).toBeInTheDocument()
      expect(within(tools).getByTestId("filter-menu")).toBeInTheDocument()
      // Only once: not also in the header.
      expect(screen.getAllByTestId("conversation-manager-search")).toHaveLength(1)
      // The tabs take a full-width row of their own above the search.
      expect(within(tools).getByTestId("conversation-manager-tabs")).toHaveClass("w-full")
      expect(
        within(screen.getByTestId("conversation-manager-header")).queryByTestId(
          "conversation-manager-tabs"
        )
      ).not.toBeInTheDocument()
      expect(screen.getAllByTestId("conversation-manager-tabs")).toHaveLength(1)
      expect(lastList().goals.get("a")).toBe(goal)
      expect(lastList().selecting).toBe(false)
    })

    it("turns selection on and off from Select", () => {
      render(<ConversationManager />)
      const select = screen.getByTestId("conversation-manager-select-mode")
      // A glyph beside the search, named for what it does.
      expect(select).toHaveAccessibleName("Select")
      expect(select).toHaveAttribute("aria-pressed", "false")
      fireEvent.click(select)
      expect(lastList().selecting).toBe(true)
      expect(screen.getByTestId("conversation-manager-select-mode")).toHaveAccessibleName("Done")
      expect(screen.getByTestId("conversation-manager-select-mode")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      fireEvent.click(screen.getByTestId("conversation-manager-select-mode"))
      expect(lastList().selecting).toBe(false)
    })

    it("hides Select once something is selected, leaving Done to the bulk bar", () => {
      render(<ConversationManager />)
      act(() => lastList().onStartSelecting("a"))
      expect(lastList().selecting).toBe(true)
      expect([...lastBulk().selected]).toEqual(["a"])
      expect(screen.queryByTestId("conversation-manager-select-mode")).not.toBeInTheDocument()

      // The bar's Done leaves the mode and drops the selection.
      act(() => lastBulk().onClear())
      expect(lastList().selecting).toBe(false)
      expect(lastBulk().selected.size).toBe(0)
      expect(screen.getByTestId("conversation-manager-select-mode")).toHaveAccessibleName("Select")
    })

    it("selects a long-pressed row once, without toggling it back off", () => {
      render(<ConversationManager />)
      act(() => lastList().onToggleSelect("a", toggle))
      act(() => lastList().onStartSelecting("a"))
      expect([...lastBulk().selected]).toEqual(["a"])
      act(() => lastList().onStartSelecting("b"))
      expect([...lastBulk().selected].sort()).toEqual(["a", "b"])
    })

    it("does not show the ranked hint over the list", () => {
      jest.useFakeTimers()
      try {
        render(<ConversationManager />)
        fireEvent.change(screen.getByTestId("conversation-manager-search"), {
          target: { value: "plan" },
        })
        act(() => {
          jest.advanceTimersByTime(150)
        })
        expect(screen.queryByTestId("conversation-manager-ranked")).not.toBeInTheDocument()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  it("exports the conversation the row asked for", () => {
    mockData = data({ exportSession: session("a") })
    render(<ConversationManager />)
    expect(screen.getByTestId("export-dialog")).toHaveTextContent("a")
  })
})
