/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@cognia/agent-config-types"

import { MobileChannelList } from "./mobile-channel-list"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

const bulkSetSessionsPinnedMock: jest.Mock<Promise<void>, [readonly string[], boolean]> = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  bulkSetSessionsPinned: (ids: readonly string[], pinned: boolean) =>
    bulkSetSessionsPinnedMock(ids, pinned),
}))

const charactersRef: {
  value: Array<{ id: string; name: string; avatarColor?: string; avatarEmoji?: string }>
} = { value: [] }
jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => charactersRef.value,
}))

const sessionStatesRef: {
  value: Array<{ sessionId: string; lastReadAt: number; unreadCount: number }>
} = { value: [] }
jest.mock("@/lib/db/session-state", () => ({
  listSessionStates: () => sessionStatesRef.value,
}))

jest.mock("@/hooks/data", () => ({
  // Synchronous wrapper: just invoke the query and return its value as-is
  // (the lib mocks above return values directly, not promises).
  useClientLiveQuery: <T,>(query: () => T) => query(),
  // Wave 4 / ADR-0026 — same synchronous shortcut for the Dexie-first hook.
  // We deliberately skip kicking the orchestrator in unit tests.
  useDexieFirstQuery: <T,>(opts: { query: () => T }) => ({
    data: opts.query(),
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  }),
}))

const relativeTimeMock = jest.fn(() => "now")
jest.mock("next-intl", () => ({
  useFormatter: () => ({ relativeTime: relativeTimeMock }),
  useNow: () => new Date(),
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      search: "Search",
      searchAria: "Search aria",
      pinned: "Pinned",
      recent: "Recent",
      bucketToday: "Today",
      bucketYesterday: "Yesterday",
      bucketPrev7: "Previous 7 Days",
      bucketPrev30: "Previous 30 Days",
      bucketOlder: "Older",
      renameAria: "Rename",
      emptyChats: "Empty",
      emptyFiltered: `No "${vars?.query ?? ""}"`,
      emptyFilters: `No match for ${vars?.count ?? 0} filters`,
      // Shared `conversationFilters` namespace (the filter menu + chips).
      clearAll: "Clear filters",
      label: "Filter and sort",
      labelActive: `Filter and sort (${vars?.count ?? 0})`,
      count: `${vars?.shown ?? 0} / ${vars?.total ?? 0}`,
      swipePin: "Pin",
      swipeUnpin: "Unpin",
      swipeDelete: "Delete",
      swipeArchive: "Archive",
      swipeUnarchive: "Unarchive",
      viewActive: "Show active",
      viewArchived: "Show archived",
      emptyArchived: "No archived",
      searchTruncated: "Some results hidden",
      unreadCount: `${vars?.count ?? 0} unread`,
    }
    return map[key] ?? key
  },
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  impact: () => Promise.resolve({ kind: "ok" }),
  selectionFeedback: () => Promise.resolve({ kind: "ok" }),
}))

// Static UI-store mock: view/collapse are mirrored to local state in the
// component, so no-op setters are enough (spies let us assert persistence).
const setChannelListView = jest.fn()
// Folder collapse now lives in the store itself (no local mirror), so the mock
// has to be a real (if tiny) reactive store: the collapse assertions below
// drive it through the UI and expect the list to re-render.
let collapsedFolderIds: string[] = []
const uiListeners = new Set<() => void>()
const emitUiChange = () => uiListeners.forEach((listener) => listener())
const setCollapsedFolders = jest.fn((ids: string[]) => {
  collapsedFolderIds = ids
  emitUiChange()
})
const toggleCollapsedFolder = jest.fn((id: string) => {
  collapsedFolderIds = collapsedFolderIds.includes(id)
    ? collapsedFolderIds.filter((f) => f !== id)
    : [...collapsedFolderIds, id]
  emitUiChange()
})
const setGroupCollapsed = jest.fn()
// Quick filters are shared with the desktop sidebar; default to unfiltered so
// the existing assertions hold.
let conversationFilters: Record<string, unknown> = {
  unread: false,
  pinned: false,
  branched: false,
  kind: "all",
}
const setConversationFilters = jest.fn()
const resetConversationFilters = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: Record<string, unknown>) => T): T => {
    const react = jest.requireActual<typeof import("react")>("react")
    const [, force] = react.useReducer((n: number) => n + 1, 0)
    react.useEffect(() => {
      uiListeners.add(force)
      return () => {
        uiListeners.delete(force)
      }
    }, [force])
    return selector({
      channelListView: "active",
      setChannelListView,
      collapsedFolderIds,
      setCollapsedFolders,
      toggleCollapsedFolder,
      groupCollapseOverrides: {},
      setGroupCollapsed,
      conversationFilters,
      setConversationFilters,
      resetConversationFilters,
    })
  },
}))

// Behavior prefs default to today's behavior; tests override as needed.
let conversationSidebar: Record<string, unknown> | null = null
const saveSettings = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: typeof saveSettings }) => T): T =>
    selector({
      settings: conversationSidebar ? { conversationSidebar } : null,
      save: saveSettings,
    }),
}))

const useChatHistorySearch = jest.fn()
let historySearchState = {
  results: [] as Array<{ sessionId: string }>,
  moreOlderHistory: false,
  indexIncomplete: false,
  loading: false,
  error: null as Error | null,
}
jest.mock("@/hooks/chat/use-chat-history-search", () => ({
  useChatHistorySearch: (...args: unknown[]) => useChatHistorySearch(...args),
}))

const baseSession = (id: string, overrides: Partial<ChatSession> = {}): ChatSession => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  kind: "direct",
  ...overrides,
})

const sessions: ChatSession[] = [
  baseSession("s1", { title: "Daily standup", pinned: true, updatedAt: 100 }),
  baseSession("s2", { title: "Octopus Tutor", updatedAt: 200 }),
  baseSession("s3", { title: "Side note", updatedAt: 50 }),
]

describe("<MobileChannelList />", () => {
  beforeEach(() => {
    bulkSetSessionsPinnedMock.mockReset()
    bulkSetSessionsPinnedMock.mockResolvedValue(undefined)
    relativeTimeMock.mockClear()
    charactersRef.value = []
    sessionStatesRef.value = []
    setChannelListView.mockReset()
    collapsedFolderIds = []
    setCollapsedFolders.mockClear()
    toggleCollapsedFolder.mockClear()
    setGroupCollapsed.mockReset()
    setConversationFilters.mockReset()
    resetConversationFilters.mockReset()
    saveSettings.mockReset()
    conversationFilters = { unread: false, pinned: false, branched: false, kind: "all" }
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
    conversationSidebar = null
    historySearchState = {
      results: [],
      moreOlderHistory: false,
      indexIncomplete: false,
      loading: false,
      error: null,
    }
    useChatHistorySearch.mockReset()
    useChatHistorySearch.mockImplementation(() => historySearchState)
  })

  it("groups pinned sessions and buckets the rest by date", () => {
    // Date buckets are one option now; the default axis is the workspace.
    conversationSidebar = { groupBy: "date" }
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    const pinned = screen.getByTestId("mobile-channel-pinned")
    // updatedAt values are epoch-tiny → the non-pinned sessions land in "Older".
    const older = screen.getByTestId("mobile-channel-bucket-older")
    expect(within(pinned).getByText("Daily standup")).toBeInTheDocument()
    expect(within(older).getByText("Octopus Tutor")).toBeInTheDocument()
    expect(within(older).getByText("Side note")).toBeInTheDocument()
    // The pinned session is not duplicated into the date bucket.
    expect(within(older).queryByText("Daily standup")).toBeNull()
  })

  it("groups by workspace by default, folding every workspace but the active one", async () => {
    // Only `id`/`name` are read by the grouping path.
    useProjectStore.setState({
      projects: [
        { id: "w1", name: "Alpha" },
        { id: "w2", name: "Beta" },
      ] as unknown as Project[],
      activeProjectId: "w1",
      loaded: true,
    })
    render(
      <MobileChannelList
        sessions={[
          baseSession("here", { title: "Here", projectId: "w1" }),
          baseSession("there", { title: "There", projectId: "w2" }),
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    const alpha = screen.getByTestId("mobile-channel-group-workspace:w1")
    const beta = screen.getByTestId("mobile-channel-group-workspace:w2")
    expect(within(alpha).getByText("Here")).toBeInTheDocument()
    expect(within(beta).queryByText("There")).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Beta" }))
    expect(setGroupCollapsed).toHaveBeenCalledWith("workspace:w2", false)
  })

  it("labels the leftovers generically when grouping by agent", () => {
    conversationSidebar = { groupBy: "agent" }
    render(
      <MobileChannelList
        sessions={[baseSession("loose", { title: "Loose" })]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByRole("button", { name: "ungroupedAgent" })).toBeInTheDocument()
    expect(screen.getByText("Loose")).toBeInTheDocument()
  })

  it("does not expose embedded resource sessions in the mobile conversation list", () => {
    render(
      <MobileChannelList
        sessions={[
          ...sessions,
          {
            id: "embedded",
            title: "Canvas assistant",
            kind: "resource-workbench",
            visibility: "embedded",
            createdAt: 0,
            updatedAt: 20,
          } as ChatSession,
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )

    expect(screen.queryByText("Canvas assistant")).toBeNull()
  })

  it("renames a session via long-press inline edit", async () => {
    const onRename = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={onRename}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    // Long-press opens the inline rename input for that row.
    const row = screen.getByTestId("mobile-channel-row-s2")
    await user.pointer({ keys: "[TouchA>]", target: row })
    const input = await screen.findByTestId("mobile-channel-rename-s2")
    await user.clear(input)
    await user.type(input, "Renamed{Enter}")
    expect(onRename).toHaveBeenCalledWith("s2", "Renamed")
  })

  it("marks the active session", () => {
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-row-s2")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("mobile-channel-row-s1")).toHaveAttribute("data-active", "false")
  })

  it("filters via the search box", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "octopus")
    // The value fed to the grouping model is debounced (150ms), so the field
    // value updates immediately but the filtered result settles a tick later.
    await waitFor(() =>
      expect(screen.queryByTestId("mobile-channel-row-s1")).not.toBeInTheDocument()
    )
    expect(screen.queryByTestId("mobile-channel-row-s3")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-channel-row-s2")).toBeInTheDocument()
  })

  it("shows the filtered-empty copy when the query matches nothing", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
    // Debounced filter (150ms) before the empty-state copy appears.
    await waitFor(() =>
      expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
    )
  })

  it("invokes onSelect when a row is tapped", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("mobile-channel-row-s2"))
    expect(onSelect).toHaveBeenCalledWith("s2")
  })

  it("toggles pin via the swipe action", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-pin")[0])
    expect(bulkSetSessionsPinnedMock).toHaveBeenCalledWith(["s1"], false)
  })

  it("shows message activity time instead of a newer metadata-write time", () => {
    render(
      <MobileChannelList
        sessions={[baseSession("s1", { lastMessageAt: 100, updatedAt: 200 })]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )

    expect(relativeTimeMock).toHaveBeenCalledWith(new Date(100), expect.any(Date))
  })

  it("calls onNewDirect from the + button", async () => {
    const onNewDirect = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={onNewDirect}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("mobile-channel-new"))
    expect(onNewDirect).toHaveBeenCalled()
  })

  it("renders the global empty copy when no sessions exist", () => {
    render(
      <MobileChannelList
        sessions={[]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent("Empty")
  })

  it("renders an unread red dot when sessionState.unreadCount > 0", () => {
    sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 3 }]
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-unread-s2")).toHaveAttribute("aria-label", "3 unread")
    expect(screen.queryByTestId("mobile-channel-unread-s1")).not.toBeInTheDocument()
  })

  it("resolves the avatar via the bound character when characterId matches", () => {
    charactersRef.value = [{ id: "ch1", name: "Octopus", avatarEmoji: "🐙", avatarColor: "#abc" }]
    const sessionsWithChar: ChatSession[] = [
      baseSession("s1", { title: "Daily standup", characterId: "ch1", updatedAt: 100 }),
    ]
    render(
      <MobileChannelList
        sessions={sessionsWithChar}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByText("🐙")).toBeInTheDocument()
  })

  it("clears the search query via the X button", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "abc")
    await user.click(screen.getByTestId("mobile-channel-search-clear"))
    expect(screen.getByTestId("mobile-channel-search")).toHaveValue("")
  })

  it("invokes onDelete via the swipe action", async () => {
    const onDelete = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={onDelete}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-delete")[0])
    expect(onDelete).toHaveBeenCalled()
  })

  it("renders a collapsible folder section for foldered sessions", async () => {
    const folders = [
      { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
    ] as never
    const foldered: ChatSession[] = [
      baseSession("s1", { title: "Inside work", folderId: "f1", updatedAt: 100 }),
    ]
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={foldered}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        folders={folders}
      />
    )
    const folderSection = screen.getByTestId("mobile-channel-folder-f1")
    expect(within(folderSection).getByText("Inside work")).toBeInTheDocument()
    // Tapping the folder header collapses it, hiding its rows.
    await user.click(screen.getByRole("button", { name: "Work" }))
    expect(screen.queryByTestId("mobile-channel-row-s1")).not.toBeInTheDocument()
  })

  it("archives a session via the swipe action", async () => {
    const onArchive = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={onArchive}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-archive")[0])
    expect(onArchive).toHaveBeenCalled()
  })

  it("toggles to the archived view and unarchives via swipe", async () => {
    const onUnarchive = jest.fn()
    const archivedSessions: ChatSession[] = [
      baseSession("a1", { title: "Archived chat", archivedAt: 5, updatedAt: 10 }),
    ]
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={archivedSessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={onUnarchive}
      />
    )
    // Active view hides the archived session; the empty state shows.
    expect(screen.queryByTestId("mobile-channel-row-a1")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-channel-view-toggle"))
    // Archived view reveals it; swipe-archive now restores it.
    expect(screen.getByTestId("mobile-channel-row-a1")).toBeInTheDocument()
    await user.click(screen.getAllByTestId("swipe-action-archive")[0])
    expect(onUnarchive).toHaveBeenCalledWith("a1")
  })

  it("persists the archived-view choice to the shared UI store", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("mobile-channel-view-toggle"))
    expect(setChannelListView).toHaveBeenCalledWith("archived")
  })

  it("hides the unread dot when showUnreadBadges is off", () => {
    conversationSidebar = { showUnreadBadges: false }
    sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 3 }]
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.queryByTestId("mobile-channel-unread-s2")).not.toBeInTheDocument()
  })

  it("shows the message preview subtitle when showPreview is on", () => {
    conversationSidebar = { showPreview: true }
    const withPreview: ChatSession[] = [
      baseSession("s1", { title: "Daily standup", lastMessagePreview: "see you at 9", updatedAt: 100 }),
    ]
    render(
      <MobileChannelList
        sessions={withPreview}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-subtitle-s1")).toHaveTextContent("see you at 9")
  })

  it("surfaces content-only matches when searchScope is titleAndContent", async () => {
    conversationSidebar = { searchScope: "titleAndContent" }
    historySearchState = {
      ...historySearchState,
      results: [{ sessionId: "s3" }],
    }
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    // "zzz" matches no title; only the content set contains s3 (Side note).
    await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
    await waitFor(() =>
      expect(useChatHistorySearch).toHaveBeenLastCalledWith(
        "zzz",
        expect.objectContaining({ collapseBySession: true })
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId("mobile-channel-row-s3")).toBeInTheDocument()
    )
    expect(screen.queryByTestId("mobile-channel-row-s2")).not.toBeInTheDocument()
  })

  describe("filters and sorting", () => {
    const renderList = (list: ChatSession[] = sessions) =>
      render(
        <MobileChannelList
          sessions={list}
          activeSessionId={null}
          onSelect={jest.fn()}
          onNewDirect={jest.fn()}
          onDelete={jest.fn()}
          onRename={jest.fn()}
          onArchive={jest.fn()}
          onUnarchive={jest.fn()}
        />
      )

    it("hides the chip row while the list is in its default state", () => {
      renderList()
      expect(screen.queryByTestId("mobile-channel-filter-chips")).toBeNull()
    })

    it("applies the shared pinned filter", () => {
      // Same UI-store slice the desktop sidebar reads, so a phone and a desktop
      // never disagree about which conversations exist.
      conversationFilters = { unread: false, pinned: true, branched: false, kind: "all" }
      renderList()
      expect(screen.getByTestId("mobile-channel-row-s1")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-channel-row-s2")).toBeNull()
      expect(screen.getByTestId("mobile-channel-filter-chips-count")).toHaveTextContent("1 / 3")
    })

    it("applies the shared sort preference", () => {
      conversationSidebar = { groupBy: "none", sortBy: "title" }
      renderList([
        baseSession("s-z", { title: "Zulu", updatedAt: 300 }),
        baseSession("s-a", { title: "Alpha", updatedAt: 100 }),
      ])
      const rows = screen.getAllByTestId(/^mobile-channel-row-/)
      expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
        "mobile-channel-row-s-a",
        "mobile-channel-row-s-z",
      ])
    })

    it("persists a sort choice through the settings store", async () => {
      const user = userEvent.setup()
      renderList()
      await user.click(screen.getByTestId("mobile-channel-filter"))
      // jsdom reports the desktop breakpoint, so the menu is the dropdown with
      // hover submenus; items are activated with fireEvent (see
      // conversation-filter-controls.test.tsx for why not `user.click`).
      await user.hover(await screen.findByTestId("mobile-channel-filter-section-sort"))
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "sort.options.oldest" }))
      expect(saveSettings).toHaveBeenCalledWith({ conversationSidebar: { sortBy: "oldest" } })
    })

    it("clears filters from the empty state when they hide everything", async () => {
      conversationFilters = { unread: true, pinned: false, branched: false, kind: "all" }
      const user = userEvent.setup()
      renderList()
      expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent("No match for 1 filters")
      await user.click(screen.getByTestId("mobile-channel-clear-filters"))
      expect(resetConversationFilters).toHaveBeenCalled()
    })

    it("keeps the search empty state when a query is what emptied the list", async () => {
      conversationFilters = { unread: true, pinned: false, branched: false, kind: "all" }
      const user = userEvent.setup()
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
      // A query is the more specific cause — offering "clear filters" here would
      // point at the wrong lever.
      await waitFor(() =>
        expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
      )
      expect(screen.queryByTestId("mobile-channel-clear-filters")).toBeNull()
    })
  })
})
