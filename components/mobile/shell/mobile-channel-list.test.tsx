/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

import { MobileChannelList, type MobileChannelListProps } from "./mobile-channel-list"
import { MobileChannelListSourceProvider } from "./mobile-channel-list-source"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

const listSessionBranches = jest.fn(async (_id: string) => [] as unknown[])
jest.mock("@/lib/db/sessions", () => ({
  listSessionBranches: (id: string) => listSessionBranches(id),
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
const markSessionRead = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/db/session-state", () => ({
  listSessionStates: () => sessionStatesRef.value,
  markSessionRead: (id: string) => markSessionRead(id),
}))

const teamsRef: { value: Array<{ id: string; name: string }> } = { value: [] }
jest.mock("@/lib/db/teams", () => ({
  listTeams: () => teamsRef.value,
}))

jest.mock("@/hooks/data", () => ({
  // Synchronous wrappers: invoke the query and return its value as-is (the lib
  // mocks above return values directly, not promises). The Dexie-first hook
  // deliberately skips kicking the orchestrator.
  useClientLiveQuery: <T,>(query: () => T) => {
    const value = query()
    return value instanceof Promise ? undefined : value
  },
  useDexieFirstQuery: <T,>(opts: { query: () => T }) => ({
    data: opts.query(),
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  }),
}))

// Rows format their timestamp once per render — the counter doubles as a row
// render probe for the memoization tests.
const dateTimeMock = jest.fn((date: Date) => `time:${date.getTime()}`)
jest.mock("next-intl", () => ({
  useFormatter: () => ({ dateTime: dateTimeMock }),
  useNow: () => new Date(2026, 8, 24, 12, 0, 0),
  // The runner's own zone: the fixtures are written in local time.
  useTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      search: "Search",
      searchAria: "Search aria",
      pinned: "Pinned",
      recent: "Recent",
      results: "Results",
      bucketToday: "Today",
      bucketYesterday: "Yesterday",
      bucketPrev7: "Previous 7 Days",
      bucketPrev30: "Previous 30 Days",
      bucketOlder: "Older",
      renameAria: "Rename",
      emptyChats: "Empty",
      emptyFiltered: `No "${vars?.query ?? ""}"`,
      emptyFilters: `No match for ${vars?.count ?? 0} filters`,
      folderEmpty: "Empty folder",
      sectionCount: `${vars?.count ?? 0} conversations`,
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
      viewTabActive: "Chats",
      viewTabArchived: "Archived",
      emptyArchived: "No archived",
      searchTruncated: "Some results hidden",
      unreadCount: `${vars?.count ?? 0} unread`,
      archiveSuccess: "Archived",
      unarchiveSuccess: "Restored",
      pinSuccess: "Pinned it",
      unpinSuccess: "Unpinned it",
      moveSuccess: "Moved",
      undo: "Undo",
    }
    return map[key] ?? key
  },
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  impact: () => Promise.resolve({ kind: "ok" }),
  selectionFeedback: () => Promise.resolve({ kind: "ok" }),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

jest.mock("@/components/thread-handoff/thread-handoff-source-dialog", () => ({
  ThreadHandoffSourceDialog: ({ session }: { session: { id: string } }) => (
    <div data-testid="handoff-dialog">{session.id}</div>
  ),
}))

// The archived view is read straight from the store, so the mock holds it and
// notifies — a fixed snapshot would make the view toggle a no-op.
let channelListView: "active" | "archived" = "active"
const setChannelListView = jest.fn((next: "active" | "archived") => {
  channelListView = next
  emitUiChange()
})
let pendingConversationReveal: string | null = null
// Folder collapse lives in the store itself (no local mirror), so the mock is
// a real (if tiny) reactive store.
let collapsedFolderIds: string[] = []
const uiListeners = new Set<() => void>()
const emitUiChange = () => uiListeners.forEach((listener) => listener())
const toggleCollapsedFolder = jest.fn((id: string) => {
  collapsedFolderIds = collapsedFolderIds.includes(id)
    ? collapsedFolderIds.filter((f) => f !== id)
    : [...collapsedFolderIds, id]
  emitUiChange()
})
const setGroupCollapsed = jest.fn()
// Quick filters are shared with the desktop sidebar; default to unfiltered.
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
      channelListView,
      setChannelListView,
      pendingConversationReveal,
      clearConversationReveal: () => {
        pendingConversationReveal = null
        emitUiChange()
      },
      collapsedFolderIds,
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

// jsdom has no layout. Give the scroll container a phone-sized viewport and
// each windowed item a row height, so the virtualizer windows the way it does
// on a device.
const VIEWPORT_HEIGHT = 800
const ITEM_HEIGHT = 56
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")
const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")
const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")
const originalScrollTo = HTMLElement.prototype.scrollTo
const scrollTo = jest.fn()
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute("data-mobile-channel-scroll")) return VIEWPORT_HEIGHT
      if (this.hasAttribute("data-index")) return ITEM_HEIGHT
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-mobile-channel-scroll") ? 262 : 0
    },
  })
  // The virtualizer clamps every scroll to scrollHeight - clientHeight.
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (!this.hasAttribute("data-mobile-channel-scroll")) return 0
      const sizer = this.firstElementChild as HTMLElement | null
      return Number.parseFloat(sizer?.style.height ?? "0") || 0
    },
  })
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return this.hasAttribute("data-mobile-channel-scroll") ? VIEWPORT_HEIGHT : 0
    },
  })
  HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo
})
afterAll(() => {
  if (originalOffsetHeight)
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight)
  if (originalOffsetWidth)
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth)
  if (originalScrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", originalScrollHeight)
  if (originalClientHeight) Object.defineProperty(Element.prototype, "clientHeight", originalClientHeight)
  HTMLElement.prototype.scrollTo = originalScrollTo
})

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

function listProps(overrides: Partial<MobileChannelListProps> = {}): MobileChannelListProps {
  return {
    sessions,
    activeSessionId: null,
    onSelect: jest.fn(),
    onNewDirect: jest.fn(),
    onDelete: jest.fn(),
    onRename: jest.fn(),
    onArchive: jest.fn(),
    onUnarchive: jest.fn(),
    onSetPinned: jest.fn(),
    onAssignToFolder: jest.fn(),
    ...overrides,
  }
}

function renderList(overrides: Partial<MobileChannelListProps> = {}) {
  const props = listProps(overrides)
  const utils = render(<MobileChannelList {...props} />)
  return { ...utils, props }
}

/** The section a rendered row was placed under. */
const sectionOf = (id: string) =>
  screen.getByTestId(`mobile-channel-row-${id}`).closest("[data-section]")?.getAttribute("data-section")

async function longPress(target: HTMLElement) {
  fireEvent.pointerDown(target, { clientX: 10, clientY: 10, pointerType: "touch" })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 520))
  })
  fireEvent.pointerUp(target, { clientX: 10, clientY: 10, pointerType: "touch" })
  fireEvent.click(target)
}

describe("<MobileChannelList />", () => {
  beforeEach(() => {
    listSessionBranches.mockClear()
    markSessionRead.mockClear()
    dateTimeMock.mockClear()
    toastSuccess.mockReset()
    toastError.mockReset()
    scrollTo.mockClear()
    charactersRef.value = []
    sessionStatesRef.value = []
    teamsRef.value = []
    setChannelListView.mockClear()
    channelListView = "active"
    pendingConversationReveal = null
    collapsedFolderIds = []
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

  describe("layout", () => {
    it("takes the width of its slot instead of its longest title's", () => {
      renderList({
        sessions: [baseSession("long", { title: "An extremely long conversation title ".repeat(8) })],
      })
      // jsdom has no layout, so this pins the classes that make the column
      // shrinkable: without `min-w-0` a nowrap title set the list's width.
      expect(screen.getByTestId("mobile-channel-list")).toHaveClass("min-w-0", "flex-1")
      expect(screen.getByText(/An extremely long/)).toHaveClass("truncate", "min-w-0")
    })

    it("gives search the whole first row and every header control the 44px floor", () => {
      renderList()
      const search = screen.getByTestId("mobile-channel-search")
      expect(search).toHaveAttribute("type", "search")
      expect(search.parentElement).toHaveClass("min-w-0", "flex-1")
      expect(screen.getByTestId("mobile-channel-new")).toHaveClass("size-11")
      expect(screen.getByTestId("mobile-channel-search-scope")).toHaveClass("size-11")
      expect(screen.getByTestId("mobile-channel-filter")).toHaveClass("size-11")
      expect(screen.getByTestId("mobile-channel-view-active")).toHaveClass("touch-hit")
    })
  })

  describe("sections", () => {
    it("groups pinned sessions and buckets the rest by date, with labelled, counted headers", () => {
      conversationSidebar = { groupBy: "date" }
      renderList({ activeSessionId: "s2" })
      expect(screen.getByTestId("mobile-channel-pinned")).toHaveTextContent("Pinned")
      expect(screen.getByTestId("mobile-channel-pinned")).toHaveTextContent("1 conversations")
      // updatedAt values are epoch-tiny → the non-pinned sessions land in "Older".
      expect(screen.getByTestId("mobile-channel-bucket-older")).toHaveTextContent("2 conversations")
      expect(sectionOf("s1")).toBe("pinned")
      expect(sectionOf("s2")).toBe("date:older")
      expect(sectionOf("s3")).toBe("date:older")
      // The pinned session is not duplicated into the date bucket.
      expect(screen.getAllByTestId("mobile-channel-row-s1")).toHaveLength(1)
    })

    it("labels the flat list when grouping is off", () => {
      conversationSidebar = { groupBy: "none" }
      renderList({ sessions: [baseSession("a", { title: "Alpha" })] })
      expect(screen.getByTestId("mobile-channel-recent")).toHaveTextContent("Recent")
    })

    it("groups by workspace by default, folding every workspace but the active one", async () => {
      useProjectStore.setState({
        projects: [
          { id: "w1", name: "Alpha" },
          { id: "w2", name: "Beta" },
        ] as unknown as Project[],
        activeProjectId: "w1",
        loaded: true,
      })
      renderList({
        sessions: [
          baseSession("here", { title: "Here", projectId: "w1" }),
          baseSession("there", { title: "There", projectId: "w2" }),
        ],
      })
      expect(sectionOf("here")).toBe("workspace:w1")
      expect(screen.queryByTestId("mobile-channel-row-there")).toBeNull()
      const beta = screen.getByTestId("mobile-channel-group-workspace:w2")
      expect(beta).toHaveAttribute("aria-expanded", "false")
      // Collapsed or not, the header says how many it holds.
      expect(beta).toHaveTextContent("1 conversations")
      expect(beta).toHaveClass("min-h-11")
      await userEvent.click(screen.getByRole("button", { name: /^Beta/ }))
      expect(setGroupCollapsed).toHaveBeenCalledWith("workspace:w2", false)
    })

    it("labels the leftovers generically when grouping by agent", () => {
      conversationSidebar = { groupBy: "agent" }
      renderList({ sessions: [baseSession("loose", { title: "Loose" })] })
      expect(screen.getByRole("button", { name: /^ungroupedAgent/ })).toBeInTheDocument()
      expect(screen.getByText("Loose")).toBeInTheDocument()
    })

    it("groups by team, so the axis means the same thing on both surfaces", () => {
      conversationSidebar = { groupBy: "team" }
      teamsRef.value = [{ id: "t1", name: "Squad" }]
      renderList({
        sessions: [
          baseSession("s1", { title: "Standup", kind: "team", teamId: "t1", updatedAt: 100 }),
          baseSession("s2", { title: "Solo", updatedAt: 50 }),
        ],
      })
      expect(screen.getByTestId("mobile-channel-group-team:t1")).toHaveTextContent("Squad")
      expect(screen.getByTestId("mobile-channel-group-team:__ungrouped__")).toBeInTheDocument()
    })

    it("does not expose embedded resource sessions in the mobile conversation list", () => {
      renderList({
        sessions: [
          ...sessions,
          {
            id: "embedded",
            title: "Canvas assistant",
            kind: "resource-workbench",
            visibility: "embedded",
            createdAt: 0,
            updatedAt: 20,
          } as ChatSession,
        ],
      })
      expect(screen.queryByText("Canvas assistant")).toBeNull()
    })
  })

  describe("folders", () => {
    const folders = [
      { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
    ] as SessionFolder[]

    it("collapses a folder from its header", async () => {
      const user = userEvent.setup()
      renderList({
        sessions: [baseSession("s1", { title: "Inside work", folderId: "f1", updatedAt: 100 })],
        folders,
      })
      expect(sectionOf("s1")).toBe("folder:f1")
      await user.click(screen.getByRole("button", { name: /^Work/ }))
      expect(toggleCollapsedFolder).toHaveBeenCalledWith("f1")
      expect(screen.queryByTestId("mobile-channel-row-s1")).toBeNull()
    })

    it("explains an empty folder instead of showing a bare heading", () => {
      renderList({ sessions: [baseSession("s1", { title: "Loose" })], folders })
      expect(screen.getByTestId("mobile-channel-folder-f1")).toBeInTheDocument()
      expect(screen.getByTestId("mobile-channel-folder-empty-f1")).toHaveTextContent("Empty folder")
    })

    it("hides empty folders while a filter narrows the list", () => {
      conversationFilters = { unread: false, pinned: true, branched: false, kind: "all" }
      renderList({ sessions: [baseSession("s1", { title: "Pinned one", pinned: true })], folders })
      expect(screen.queryByTestId("mobile-channel-folder-f1")).toBeNull()
      expect(screen.queryByTestId("mobile-channel-folder-empty-f1")).toBeNull()
    })
  })

  describe("rows", () => {
    it("marks the active session", () => {
      renderList({ activeSessionId: "s2" })
      expect(screen.getByTestId("mobile-channel-row-s2")).toHaveAttribute("data-active", "true")
      expect(screen.getByTestId("mobile-channel-row-s1")).toHaveAttribute("data-active", "false")
    })

    it("invokes onSelect when a row is tapped", async () => {
      const user = userEvent.setup()
      const { props } = renderList()
      await user.click(screen.getByTestId("mobile-channel-row-s2"))
      expect(props.onSelect).toHaveBeenCalledWith("s2")
    })

    it("shows message activity time instead of a newer metadata-write time", () => {
      renderList({ sessions: [baseSession("s1", { lastMessageAt: 100, updatedAt: 200 })] })
      expect(screen.getByTestId("mobile-channel-time-s1")).toHaveTextContent("time:100")
    })

    it("hides timestamps when the preference is off", () => {
      conversationSidebar = { showTimestamps: false }
      renderList()
      expect(screen.queryByTestId("mobile-channel-time-s1")).toBeNull()
    })

    it("renders an announced unread badge when sessionState.unreadCount > 0", () => {
      sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 3 }]
      renderList()
      const badge = screen.getByTestId("mobile-channel-unread-s2")
      expect(within(badge).getByText("3 unread")).toHaveClass("sr-only")
      expect(screen.queryByTestId("mobile-channel-unread-s1")).toBeNull()
    })

    it("hides the unread badge when showUnreadBadges is off", () => {
      conversationSidebar = { showUnreadBadges: false }
      sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 3 }]
      renderList()
      expect(screen.queryByTestId("mobile-channel-unread-s2")).toBeNull()
    })

    it("resolves the avatar via the bound character when characterId matches", () => {
      charactersRef.value = [{ id: "ch1", name: "Octopus", avatarEmoji: "🐙", avatarColor: "#abc" }]
      renderList({
        sessions: [baseSession("s1", { title: "Daily standup", characterId: "ch1", updatedAt: 100 })],
      })
      expect(screen.getByText("🐙")).toBeInTheDocument()
    })

    it("shows the message preview subtitle when showPreview is on", () => {
      conversationSidebar = { showPreview: true }
      renderList({
        sessions: [
          baseSession("s1", { title: "Daily standup", lastMessagePreview: "see you at 9", updatedAt: 100 }),
        ],
      })
      expect(screen.getByTestId("mobile-channel-subtitle-s1")).toHaveTextContent("see you at 9")
    })

    it("shows the metadata line the settings ask for", () => {
      conversationSidebar = { metadata: ["agent"] }
      charactersRef.value = [{ id: "ch1", name: "Octopus" }]
      renderList({ sessions: [baseSession("s1", { characterId: "ch1" })] })
      expect(screen.getByTestId("mobile-channel-metadata-s1")).toHaveTextContent("Octopus")
    })

    it("marks a handed-off conversation read-only", () => {
      renderList({
        sessions: [
          baseSession("s1", {
            handoffLock: { ticketId: "t", state: "frozen" } as ChatSession["handoffLock"],
          }),
        ],
      })
      expect(screen.getByTestId("mobile-channel-locked-s1")).toBeInTheDocument()
    })
  })

  describe("virtualization", () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      baseSession(`m${index}`, { title: `Conversation ${index}`, updatedAt: 10_000 - index })
    )

    it("mounts a screenful of rows, not the whole profile", () => {
      conversationSidebar = { groupBy: "none" }
      renderList({ sessions: many })
      const rendered = screen.getAllByTestId(/^mobile-channel-row-/)
      expect(rendered.length).toBeGreaterThan(5)
      expect(rendered.length).toBeLessThan(40)
    })

    it("brings the open conversation into view on open", () => {
      conversationSidebar = { groupBy: "none" }
      renderList({ sessions: many, activeSessionId: "m350" })
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: expect.any(Number) })
      )
      const tops = scrollTo.mock.calls.map(([options]) => (options as { top: number }).top)
      expect(Math.max(...tops)).toBeGreaterThan(ITEM_HEIGHT * 300)
    })

    it("returns to where it was left when the drawer reopens", () => {
      conversationSidebar = { groupBy: "none" }
      const props = listProps({ sessions: many })
      const { rerender } = render(
        <MobileChannelListSourceProvider characters={[]}>
          <MobileChannelList {...props} />
        </MobileChannelListSourceProvider>
      )
      const scroller = screen.getByTestId("mobile-channel-scroll")
      scroller.scrollTop = 1234
      fireEvent.scroll(scroller)
      // Radix unmounts the closed drawer's content; the provider stays.
      rerender(<MobileChannelListSourceProvider characters={[]}>{null}</MobileChannelListSourceProvider>)
      scrollTo.mockClear()
      rerender(
        <MobileChannelListSourceProvider characters={[]}>
          <MobileChannelList {...props} />
        </MobileChannelListSourceProvider>
      )
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1234 }))
    })

    it("does not re-render rows while typing in the search box", async () => {
      const user = userEvent.setup()
      conversationSidebar = { groupBy: "none" }
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "o")
      const settled = dateTimeMock.mock.calls.length
      await user.type(screen.getByTestId("mobile-channel-search"), "ct")
      // Keystrokes land in the field; the debounced query has not moved yet.
      expect(dateTimeMock.mock.calls.length).toBe(settled)
    })

    it("keeps rows that did not change when another row updates", () => {
      conversationSidebar = { groupBy: "none" }
      const props = listProps()
      const { rerender } = render(<MobileChannelList {...props} />)
      dateTimeMock.mockClear()
      // Structural sharing in `useSessions`: only the changed row is new.
      const next = [sessions[0]!, { ...sessions[1]!, title: "Octopus Tutor (renamed)" }, sessions[2]!]
      rerender(<MobileChannelList {...props} sessions={next} />)
      expect(dateTimeMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("search", () => {
    it("filters via the search box", async () => {
      const user = userEvent.setup()
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "octopus")
      // The value fed to the grouping model is debounced (150ms).
      await waitFor(() => expect(screen.queryByTestId("mobile-channel-row-s1")).toBeNull())
      expect(screen.queryByTestId("mobile-channel-row-s3")).toBeNull()
      expect(screen.getByTestId("mobile-channel-row-s2")).toBeInTheDocument()
      expect(screen.getByTestId("mobile-channel-results")).toHaveTextContent("Results")
    })

    it("shows the filtered-empty copy when the query matches nothing", async () => {
      const user = userEvent.setup()
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
      await waitFor(() =>
        expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
      )
    })

    it("clears the search query via the X button", async () => {
      const user = userEvent.setup()
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "abc")
      await user.click(screen.getByTestId("mobile-channel-search-clear"))
      expect(screen.getByTestId("mobile-channel-search")).toHaveValue("")
    })

    it("surfaces content-only matches, and says why they matched", async () => {
      conversationSidebar = { searchScope: "titleAndContent" }
      historySearchState = { ...historySearchState, results: [{ sessionId: "s3" }] }
      const user = userEvent.setup()
      renderList()
      // "zzz" matches no title; only the content set contains s3 (Side note).
      await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
      await waitFor(() =>
        expect(useChatHistorySearch).toHaveBeenLastCalledWith(
          "zzz",
          expect.objectContaining({ collapseBySession: true })
        )
      )
      await waitFor(() => expect(screen.getByTestId("mobile-channel-row-s3")).toBeInTheDocument())
      expect(screen.getByTestId("mobile-channel-content-match-s3")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-channel-row-s2")).toBeNull()
    })

    it("does not claim 'nothing matched' while the message index is still answering", async () => {
      conversationSidebar = { search: { content: true } }
      historySearchState = { ...historySearchState, loading: true }
      const user = userEvent.setup()
      renderList()
      await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
      await waitFor(() =>
        expect(screen.getByTestId("mobile-channel-search-pending")).toBeInTheDocument()
      )
      expect(screen.queryByTestId("mobile-channel-empty")).toBeNull()
    })

    it("lets a search reach archived conversations without switching the view", async () => {
      conversationSidebar = { search: { includeArchived: true } }
      const user = userEvent.setup()
      renderList({
        sessions: [...sessions, baseSession("s4", { title: "Standup archive", archivedAt: 5, updatedAt: 10 })],
      })
      expect(screen.queryByTestId("mobile-channel-row-s4")).toBeNull()
      await user.type(screen.getByTestId("mobile-channel-search"), "Standup")
      await waitFor(() => expect(screen.getByTestId("mobile-channel-row-s4")).toBeInTheDocument())
      expect(screen.getByTestId("mobile-channel-row-s1")).toBeInTheDocument()
      // The archived hit offers Unarchive, not Archive, from the active view.
      expect(
        within(screen.getByTestId("mobile-channel-row-s4").closest("[data-swipe-row]") as HTMLElement).getByTestId(
          "swipe-action-archive"
        )
      ).toHaveTextContent("Unarchive")
    })

    it("keeps a search inside the view when the archive reach is off", async () => {
      const user = userEvent.setup()
      renderList({
        sessions: [...sessions, baseSession("s4", { title: "Standup archive", archivedAt: 5, updatedAt: 10 })],
      })
      await user.type(screen.getByTestId("mobile-channel-search"), "Standup")
      await waitFor(() => expect(screen.getByTestId("mobile-channel-row-s1")).toBeInTheDocument())
      expect(screen.queryByTestId("mobile-channel-row-s4")).toBeNull()
    })
  })

  describe("views", () => {
    it("toggles to the archived view and unarchives via swipe", async () => {
      const onUnarchive = jest.fn()
      const user = userEvent.setup()
      renderList({
        sessions: [baseSession("a1", { title: "Archived chat", archivedAt: 5, updatedAt: 10 })],
        onUnarchive,
      })
      expect(screen.queryByTestId("mobile-channel-row-a1")).toBeNull()
      await user.click(screen.getByTestId("mobile-channel-view-archived"))
      expect(setChannelListView).toHaveBeenCalledWith("archived")
      expect(screen.getByTestId("mobile-channel-view-archived")).toHaveAttribute("aria-checked", "true")
      expect(screen.getByTestId("mobile-channel-row-a1")).toBeInTheDocument()
      await user.click(screen.getByTestId("swipe-action-archive"))
      await waitFor(() => expect(onUnarchive).toHaveBeenCalledWith("a1"))
      expect(toastSuccess).toHaveBeenCalledWith("Restored")
    })

    it("moves between views with the arrow keys, as a radio group", () => {
      renderList()
      fireEvent.keyDown(screen.getByTestId("mobile-channel-view-active"), { key: "ArrowRight" })
      expect(setChannelListView).toHaveBeenCalledWith("archived")
      expect(screen.getByTestId("mobile-channel-view-archived")).toHaveFocus()
    })

    it("comes out of the archived view to show a conversation that was just created", async () => {
      channelListView = "archived"
      pendingConversationReveal = "new"
      renderList({
        sessions: [
          baseSession("new", { title: "New chat", updatedAt: 20 }),
          baseSession("a1", { title: "Archived chat", archivedAt: 5, updatedAt: 10 }),
        ],
        activeSessionId: "new",
      })
      expect(await screen.findByTestId("mobile-channel-row-new")).toBeInTheDocument()
      expect(channelListView).toBe("active")
    })
  })

  describe("actions", () => {
    it("toggles pin through the shared pin writer, and confirms it", async () => {
      const user = userEvent.setup()
      const { props } = renderList()
      const row = screen.getByTestId("mobile-channel-row-s1").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-pin"))
      expect(props.onSetPinned).toHaveBeenCalledWith(["s1"], false)
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Unpinned it"))
    })

    it("archives via the swipe action and offers an undo", async () => {
      const onArchive = jest.fn()
      const onUnarchive = jest.fn()
      const user = userEvent.setup()
      renderList({ onArchive, onUnarchive })
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-archive"))
      expect(onArchive).toHaveBeenCalledWith("s2")
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
      const [message, options] = toastSuccess.mock.calls[0] as [
        string,
        { action: { label: string; onClick: () => void } },
      ]
      expect(message).toBe("Archived")
      expect(options.action.label).toBe("Undo")
      act(() => options.action.onClick())
      await waitFor(() => expect(onUnarchive).toHaveBeenCalledWith("s2"))
    })

    it("asks before deleting from the swipe action", async () => {
      const onDelete = jest.fn()
      const user = userEvent.setup()
      renderList({ onDelete })
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-delete"))
      // Nothing is deleted by the swipe itself.
      expect(onDelete).not.toHaveBeenCalled()
      await user.click(await screen.findByTestId("mobile-channel-delete-confirm-action"))
      await waitFor(() => expect(onDelete).toHaveBeenCalledWith("s2"))
      expect(listSessionBranches).toHaveBeenCalledWith("s2")
    })

    it("keeps the conversation when the delete is cancelled", async () => {
      const onDelete = jest.fn()
      const user = userEvent.setup()
      renderList({ onDelete })
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-delete"))
      await user.click(await screen.findByRole("button", { name: "cancel" }))
      await waitFor(() => expect(screen.queryByTestId("mobile-channel-delete-confirm")).toBeNull())
      expect(onDelete).not.toHaveBeenCalled()
    })

    it("says a refused write was refused because of the device handoff", async () => {
      const onArchive = jest.fn(async () => {
        throw new SessionHandoffLockedError("s2", "ticket", "metadata")
      })
      const user = userEvent.setup()
      renderList({ onArchive })
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-archive"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("actionLocked"))
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it("surfaces any other failure instead of dropping it", async () => {
      const onSetPinned = jest.fn(async () => {
        throw new Error("disk full")
      })
      const user = userEvent.setup()
      renderList({ onSetPinned })
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-pin"))
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("actionFailed.pin", { description: "disk full" })
      )
    })

    it("opens the action sheet on long-press and renames in place from it", async () => {
      const onRename = jest.fn()
      const user = userEvent.setup()
      renderList({ onRename })
      await longPress(screen.getByTestId("mobile-channel-row-s2"))
      // Clicks inside the vaul sheet go through fireEvent (jsdom has no
      // computed transform for vaul to read on pointerup).
      fireEvent.click(await screen.findByTestId("mobile-channel-action-rename"))
      const input = await screen.findByTestId("mobile-channel-rename-s2")
      await user.clear(input)
      await user.type(input, "Renamed{Enter}")
      await waitFor(() => expect(onRename).toHaveBeenCalledWith("s2", "Renamed"))
    })

    it("reports a failed rename", async () => {
      const onRename = jest.fn(async () => {
        throw new Error("nope")
      })
      const user = userEvent.setup()
      renderList({ onRename })
      fireEvent.contextMenu(screen.getByTestId("mobile-channel-row-s2"))
      fireEvent.click(await screen.findByTestId("mobile-channel-action-rename"))
      const input = await screen.findByTestId("mobile-channel-rename-s2")
      await user.type(input, "!{Enter}")
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("actionFailed.rename", { description: "nope" })
      )
    })

    it("marks an unread conversation read from the sheet", async () => {
      sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 2 }]
      renderList()
      fireEvent.contextMenu(screen.getByTestId("mobile-channel-row-s2"))
      fireEvent.click(await screen.findByTestId("mobile-channel-action-mark-read"))
      await waitFor(() => expect(markSessionRead).toHaveBeenCalledWith("s2"))
    })

    it("files a conversation into a folder from the sheet", async () => {
      const folders = [
        { id: "f1", name: "Work", order: 0, createdAt: 0, updatedAt: 0 },
      ] as SessionFolder[]
      const { props } = renderList({ folders })
      fireEvent.contextMenu(screen.getByTestId("mobile-channel-row-s2"))
      fireEvent.click(await screen.findByTestId("mobile-channel-action-move"))
      fireEvent.click(screen.getByTestId("mobile-channel-action-folder-f1"))
      await waitFor(() => expect(props.onAssignToFolder).toHaveBeenCalledWith("s2", "f1"))
      expect(toastSuccess).toHaveBeenCalledWith("Moved")
    })

    it("opens the device handoff from the sheet", async () => {
      renderList()
      fireEvent.contextMenu(screen.getByTestId("mobile-channel-row-s2"))
      fireEvent.click(await screen.findByTestId("mobile-channel-action-handoff"))
      expect(await screen.findByTestId("handoff-dialog")).toHaveTextContent("s2")
    })

    it("opens the sheet from the swipe strip's More", async () => {
      const user = userEvent.setup()
      renderList()
      const row = screen.getByTestId("mobile-channel-row-s2").closest("[data-swipe-row]") as HTMLElement
      await user.click(within(row).getByTestId("swipe-action-more"))
      expect(await screen.findByTestId("mobile-channel-actions")).toHaveTextContent("Octopus Tutor")
    })

    it("calls onNewDirect from the + button", async () => {
      const user = userEvent.setup()
      const { props } = renderList()
      await user.click(screen.getByTestId("mobile-channel-new"))
      expect(props.onNewDirect).toHaveBeenCalled()
    })
  })

  describe("empty and loading states", () => {
    it("renders the global empty copy when no sessions exist", () => {
      renderList({ sessions: [] })
      expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent("Empty")
    })

    it("does not flash the empty state while the session query is still loading", async () => {
      renderList({ sessions: [], isLoadingSessions: true })
      expect(screen.queryByTestId("mobile-channel-empty")).toBeNull()
      expect(await screen.findByTestId("mobile-channel-loading")).toBeInTheDocument()
    })
  })

  describe("filters and sorting", () => {
    it("hides the chip row while the list is in its default state", () => {
      renderList()
      expect(screen.queryByTestId("mobile-channel-filter-chips")).toBeNull()
    })

    it("applies the shared pinned filter", () => {
      conversationFilters = { unread: false, pinned: true, branched: false, kind: "all" }
      renderList()
      expect(screen.getByTestId("mobile-channel-row-s1")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-channel-row-s2")).toBeNull()
      expect(screen.getByTestId("mobile-channel-filter-chips-count")).toHaveTextContent("1 / 3")
    })

    it("applies the shared sort preference", () => {
      conversationSidebar = { groupBy: "none", sortBy: "title" }
      renderList({
        sessions: [
          baseSession("s-z", { title: "Zulu", updatedAt: 300 }),
          baseSession("s-a", { title: "Alpha", updatedAt: 100 }),
        ],
      })
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
      await waitFor(() =>
        expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
      )
      expect(screen.queryByTestId("mobile-channel-clear-filters")).toBeNull()
    })
  })
})
