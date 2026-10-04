/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))
jest.mock("next-intl", () => ({ useTimeZone: () => "UTC" }))

jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: () => makeLogger(),
  })
  return {
    loggers: new Proxy({}, { get: () => makeLogger() }),
    createLogger: () => makeLogger(),
  }
})

jest.mock("@/lib/ai/icons", () => ({
  getModelDisplayName: (id: string) => id,
  getProviderDisplayName: (id: string) => id,
}))
jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationFiltered: jest.fn(() => Promise.resolve(true)),
}))
jest.mock("@/lib/chat/branch-whole-conversation", () => ({
  branchWholeConversation: jest.fn(),
}))

// The rows and their writers: `useSessions` is its own suite.
let mockSessions: ChatSession[] = []
const mockUseSessions = jest.fn()
const writers = {
  remove: jest.fn(),
  rename: jest.fn(),
  bulkRemove: jest.fn(),
  bulkSetPinned: jest.fn(),
  archive: jest.fn(),
  unarchive: jest.fn(),
  bulkArchive: jest.fn(),
  bulkUnarchive: jest.fn(),
  assignToFolder: jest.fn(),
  bulkAssignToFolder: jest.fn(),
}
jest.mock("@/hooks/chat/use-sessions", () => ({
  useSessions: (options: unknown) => {
    mockUseSessions(options)
    return { sessions: mockSessions, folders: [], isLoadingSessions: false, ...writers }
  },
}))

// Live queries: the characters and the per-conversation unread state.
let mockUnread: { sessionId: string; unreadCount: number }[] = []
jest.mock("@/lib/db/characters", () => ({ listCharacters: () => ({ kind: "characters" }) }))
jest.mock("@/lib/db/session-state", () => ({ listSessionStates: () => ({ kind: "states" }) }))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => { kind: string }, _deps: unknown, fallback: unknown) =>
    query().kind === "states" ? mockUnread : fallback,
}))

jest.mock("@/hooks/shell/use-ordered-teams", () => ({ useOrderedTeams: () => ({ teams: [] }) }))
jest.mock("@/hooks/chat/use-session-run-status-map", () => ({
  useSessionRunStatusMap: () => new Map(),
}))
jest.mock("@/hooks/chat/use-session-model-lanes", () => ({
  useSessionModelLanes: () => ({
    sessionRuntimeRefs: new Map(),
    defaultRuntimeRef: undefined,
    agentNameOf: () => undefined,
  }),
  recordedRuntimeRef: () => undefined,
}))

let mockContentResults: { sessionId: string }[] = []
const mockHistorySearch = jest.fn()
jest.mock("@/hooks/chat/use-chat-history-search", () => ({
  useChatHistorySearch: (query: string, options: unknown) => {
    mockHistorySearch(query, options)
    return {
      results: mockContentResults,
      loading: false,
      error: null,
      moreOlderHistory: false,
      indexIncomplete: false,
    }
  },
}))

// The write boundary is its own suite; here only what the page hands it.
const mockRowActionOptions = jest.fn()
let mockExportId: string | null = null
jest.mock("@/hooks/chat/use-conversation-row-actions", () => ({
  useConversationRowActions: (options: unknown) => {
    mockRowActionOptions(options)
    return {
      rowActions: {},
      extraActions: {},
      exportSessionId: mockExportId,
      closeExport: jest.fn(),
    }
  },
}))

import { EMPTY_CONVERSATION_FILTERS } from "@/lib/chat/conversation-filters"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { useConversationManagerStore } from "@/stores/conversations"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui"
import { useConversationManager } from "./use-conversation-manager"

const session = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

const save = jest.fn(async () => undefined)
const initialManager = useConversationManagerStore.getState()

beforeEach(() => {
  jest.clearAllMocks()
  mockSessions = [
    session("alpha", { projectId: "p1", updatedAt: 30, createdAt: 3 }),
    session("beta", { projectId: "p2", updatedAt: 20, createdAt: 9 }),
    session("gamma", { updatedAt: 10, createdAt: 5, pinned: true }),
    session("old", { archivedAt: 40, updatedAt: 5 }),
    session("child", { kind: "subagent", archivedAt: 40 } as Partial<ChatSession>),
  ]
  mockUnread = []
  mockContentResults = []
  mockExportId = null
  useConversationManagerStore.setState(initialManager, true)
  useUIStore.getState().resetConversationFilters()
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "Cognia" },
      { id: "p2", name: "Docs" },
    ] as never,
  })
  useSettingsStore.setState({
    settings: { conversationSidebar: { sortBy: "title", groupBy: "workspace" } } as never,
    save,
  } as never)
})

const render = (query = "") =>
  renderHook((props: { query: string }) => useConversationManager(props), {
    initialProps: { query },
  })

describe("useConversationManager", () => {
  it("lists every workspace's conversations, one flat list per tab", () => {
    const { result } = render()
    expect(mockUseSessions).toHaveBeenCalledWith({ crossWorkspace: true })
    // The page's own sort (recent), not the sidebar's (title); pinned rows
    // take no section of their own.
    expect(result.current.rows.map((row) => row.id)).toEqual(["alpha", "beta", "gamma"])
    expect(result.current.model.sections).toHaveLength(1)
    expect(result.current.counts).toEqual({ active: 3, archived: 1 })

    act(() => result.current.setTab("archived"))
    expect(result.current.rows.map((row) => row.id)).toEqual(["old"])
  })

  it("keeps every archived conversation for Empty archive, but no subagent", () => {
    const { result } = render()
    expect(result.current.archivedSessions.map((row) => row.id)).toEqual(["old"])
  })

  it("sorts by the page's own preference", () => {
    const { result } = render()
    act(() => result.current.setSortBy("created"))
    expect(result.current.rows.map((row) => row.id)).toEqual(["beta", "gamma", "alpha"])
    expect(useConversationManagerStore.getState().sortBy).toBe("created")
  })

  it("narrows through its own filters and leaves the sidebar's alone", () => {
    const { result } = render()
    act(() => result.current.filterController.actions.toggle("pinned", true))
    expect(result.current.rows.map((row) => row.id)).toEqual(["gamma"])
    expect(useConversationManagerStore.getState().filters).toMatchObject({ pinned: true })
    expect(useUIStore.getState().conversationFilters).toEqual(EMPTY_CONVERSATION_FILTERS)
  })

  it("keeps sort, grouping and content reach on the page, and saves views to the profile", () => {
    const { result } = render()
    act(() => result.current.filterController.actions.setSortBy("oldest"))
    expect(useConversationManagerStore.getState().sortBy).toBe("oldest")
    act(() => result.current.filterController.actions.setGroupBy("date"))
    act(() => result.current.filterController.actions.setSearchOptions({ content: true }))
    expect(useConversationManagerStore.getState().searchContent).toBe(true)
    expect(save).not.toHaveBeenCalled()

    act(() => {
      result.current.filterController.actions.toggle("pinned", true)
    })
    act(() => {
      result.current.filterController.actions.saveView("Pinned", ["filters"])
    })
    expect(save).toHaveBeenCalledTimes(1)
    const saved = (
      save.mock.calls[0] as unknown as [{ conversationSidebar: Record<string, unknown> }]
    )[0].conversationSidebar
    // The profile's own sort and grouping survive; the view is added.
    expect(saved).toMatchObject({ sortBy: "title", groupBy: "workspace" })
    expect(saved.views).toHaveLength(1)
  })

  it("reaches every workspace and the open tab's side when searching titles", () => {
    const { result } = render()
    expect(result.current.filterController.search).toEqual({
      workspace: "all",
      includeArchived: false,
      content: false,
    })
  })

  it("adds conversations whose messages match when content search is on", () => {
    mockContentResults = [{ sessionId: "gamma" }]
    useConversationManagerStore.getState().setSearchContent(true)
    const { result } = render("alp")
    expect(mockHistorySearch).toHaveBeenLastCalledWith(
      "alp",
      expect.objectContaining({ enabled: true, includeArchived: false, collapseBySession: true })
    )
    expect(result.current.rows.map((row) => row.id)).toEqual(["alpha", "gamma"])
    expect([...result.current.model.contentOnlyIds]).toEqual(["gamma"])
  })

  it("says when a content query is too short to search", () => {
    useConversationManagerStore.getState().setSearchContent(true)
    const { result } = render("a")
    expect(result.current.content.belowMinQuery).toBe(true)
  })

  it("searches archived messages on the Archived tab", () => {
    useConversationManagerStore.getState().setSearchContent(true)
    useConversationManagerStore.getState().setTab("archived")
    render("plan")
    expect(mockHistorySearch).toHaveBeenLastCalledWith(
      "plan",
      expect.objectContaining({ includeArchived: true })
    )
  })

  it("reads unread counts from the conversation state", () => {
    mockUnread = [
      { sessionId: "alpha", unreadCount: 2 },
      { sessionId: "beta", unreadCount: 0 },
    ]
    const { result } = render()
    expect([...result.current.unreadCountById]).toEqual([["alpha", 2]])
    expect([...result.current.unreadIds]).toEqual(["alpha"])
  })

  it("opens a conversation through its session link, and starts a new one at home", () => {
    const requestChatHome = jest.spyOn(useUIStore.getState(), "requestChatHome")
    const { result } = render()
    act(() => result.current.openConversation("beta"))
    expect(mockPush).toHaveBeenLastCalledWith(`/${buildSessionHref("beta")}`)
    act(() => result.current.startConversation())
    expect(mockPush).toHaveBeenLastCalledWith("/")
    expect(requestChatHome).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("hands the write boundary the routed writers, no active row, and the opener", () => {
    const { result } = render()
    const options = mockRowActionOptions.mock.lastCall![0] as {
      onDelete: unknown
      onBulkArchive: unknown
      activeSessionId: string | null
      onSelect: (id: string) => void
      resolveSessions: (ids: string[]) => ChatSession[]
    }
    expect(options.onDelete).toBe(writers.remove)
    expect(options.onBulkArchive).toBe(writers.bulkArchive)
    expect(options.activeSessionId).toBeNull()
    expect(options.onSelect).toBe(result.current.openConversation)
    expect(options.resolveSessions(["beta", "missing", "old"]).map((row) => row.id)).toEqual([
      "beta",
      "old",
    ])
  })

  it("resolves the conversation being exported", () => {
    mockExportId = "beta"
    const { result } = render()
    expect(result.current.exportSession?.id).toBe("beta")
  })

  it("names each row's workspace", () => {
    const { result } = render()
    expect(result.current.workspaceNameById.get("p2")).toBe("Docs")
    expect(
      result.current.decorations
        .metadataFor(mockSessions[0]!)
        .find((item) => item.kind === "workspace")?.value
    ).toBe("Cognia")
  })
})
