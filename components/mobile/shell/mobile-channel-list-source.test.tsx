/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen } from "@testing-library/react"
import type { ReactNode } from "react"

import type { Character } from "@cognia/agent-config-types"

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(query: () => T) => query(),
  useDexieFirstQuery: jest.fn(),
}))
// Stable arrays, as the live queries hand back between emissions.
jest.mock("@/lib/db/teams", () => {
  const teams = [{ id: "t1", name: "Squad" }]
  return { listTeams: () => teams }
})
jest.mock("@/lib/db/session-state", () => {
  const states = [{ sessionId: "s1", lastReadAt: 0, unreadCount: 2 }]
  return { listSessionStates: () => states }
})
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(() => []) }))
jest.mock("@/hooks/chat/use-chat-history-search", () => {
  // One object, like the real hook's state: a fresh one per call would read as
  // a new search result on every render.
  const outcome = {
    results: [],
    moreOlderHistory: false,
    indexIncomplete: false,
    loading: false,
    error: null,
  }
  return { useChatHistorySearch: jest.fn(() => outcome) }
})

let sidebar: Record<string, unknown> | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: sidebar ? { conversationSidebar: sidebar } : null }),
}))
let channelListView: "active" | "archived" = "active"
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { channelListView: string }) => T): T =>
    selector({ channelListView }),
}))

import { useDexieFirstQuery } from "@/hooks/data"
import { useChatHistorySearch } from "@/hooks/chat/use-chat-history-search"
import { useProjectStore } from "@/stores/project/project-store"

import {
  createMobileChannelScrollMemory,
  MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS,
  MobileChannelListSourceProvider,
  MobileChannelListStandaloneSource,
  useMobileChannelListSource,
  useMobileChannelSearchField,
  useOptionalMobileChannelListSource,
} from "./mobile-channel-list-source"

const useDexieFirstQueryMock = useDexieFirstQuery as jest.Mock
const useChatHistorySearchMock = useChatHistorySearch as jest.Mock

const characters = [{ id: "c1", name: "Octo" }] as unknown as Character[]

function wrapper({ children }: { children: ReactNode }) {
  return <MobileChannelListSourceProvider characters={characters}>{children}</MobileChannelListSourceProvider>
}

beforeEach(() => {
  jest.useFakeTimers()
  sidebar = undefined
  channelListView = "active"
  useProjectStore.setState({ projects: [], activeProjectId: "p1", loaded: true })
  useChatHistorySearchMock.mockClear()
  useDexieFirstQueryMock.mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("MobileChannelListSourceProvider", () => {
  it("hands the list the characters it was given plus its own live reads", () => {
    const { result } = renderHook(() => useMobileChannelListSource(), { wrapper })
    expect(result.current.characters).toBe(characters)
    expect(result.current.teams).toEqual([{ id: "t1", name: "Squad" }])
    expect(result.current.sessionStates).toEqual([
      { sessionId: "s1", lastReadAt: 0, unreadCount: 2 },
    ])
  })

  it("updates the field on every keystroke but the query only once the debounce settles", () => {
    const { result } = renderHook(
      () => ({ source: useMobileChannelListSource(), field: useMobileChannelSearchField() }),
      { wrapper }
    )
    act(() => result.current.field.onChange("oct"))
    expect(result.current.field.value).toBe("oct")
    expect(result.current.source.query).toBe("")
    expect(result.current.source.hasSearchText).toBe(true)
    act(() => {
      jest.advanceTimersByTime(MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS)
    })
    expect(result.current.source.query).toBe("oct")
  })

  it("does not re-render the list for a keystroke", () => {
    // The whole point of splitting the field out: typing re-renders the field,
    // the list waits for the debounced query.
    let listRenders = 0
    function List() {
      useMobileChannelListSource()
      listRenders++
      return null
    }
    let field: ReturnType<typeof useMobileChannelSearchField> | null = null
    function Field() {
      field = useMobileChannelSearchField()
      return null
    }
    render(
      <MobileChannelListSourceProvider characters={characters}>
        <List />
        <Field />
      </MobileChannelListSourceProvider>
    )
    act(() => field!.onChange("o"))
    const afterFirst = listRenders
    act(() => field!.onChange("oc"))
    act(() => field!.onChange("oct"))
    expect(listRenders).toBe(afterFirst)
    act(() => {
      jest.advanceTimersByTime(MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS)
    })
    expect(listRenders).toBe(afterFirst + 1)
  })

  it("clears the box and the query together and drops a pending debounce", () => {
    const { result } = renderHook(
      () => ({ source: useMobileChannelListSource(), field: useMobileChannelSearchField() }),
      { wrapper }
    )
    act(() => result.current.field.onChange("octo"))
    act(() => result.current.source.clearSearch())
    act(() => {
      jest.advanceTimersByTime(MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS)
    })
    expect(result.current.field.value).toBe("")
    expect(result.current.source.query).toBe("")
    expect(result.current.source.hasSearchText).toBe(false)
  })

  it("runs the message-content search with the list's reach", () => {
    // Date grouping keeps the search inside the active workspace.
    sidebar = { groupBy: "date", search: { content: true } }
    channelListView = "archived"
    const { result } = renderHook(() => useMobileChannelSearchField(), { wrapper })
    act(() => result.current.onChange("deploy"))
    act(() => {
      jest.advanceTimersByTime(MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS)
    })
    expect(useChatHistorySearchMock).toHaveBeenLastCalledWith(
      "deploy",
      expect.objectContaining({
        enabled: true,
        projectId: "p1",
        includeArchived: true,
        collapseBySession: true,
        limit: 200,
      })
    )
  })

  it("widens the message-content search across workspaces when the list groups by workspace", () => {
    // A workspace-grouped list shows every workspace's chats, so a content
    // match in another workspace has a row to land on — the search must not
    // stay inside the active one.
    sidebar = { groupBy: "workspace", search: { content: true } }
    const { result } = renderHook(() => useMobileChannelSearchField(), { wrapper })
    act(() => result.current.onChange("deploy"))
    act(() => {
      jest.advanceTimersByTime(MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS)
    })
    expect(useChatHistorySearchMock).toHaveBeenLastCalledWith(
      "deploy",
      expect.objectContaining({ enabled: true, projectId: undefined })
    )
  })

  it("keeps the scroll memory across a remount of the list", () => {
    function Probe({ save }: { save?: number }) {
      const { scrollMemory } = useMobileChannelListSource()
      if (save != null) scrollMemory.saveOffset(save)
      return <span data-testid="offset">{scrollMemory.read().offset}</span>
    }
    const { rerender } = render(
      <MobileChannelListSourceProvider characters={characters}>
        <Probe save={320} />
      </MobileChannelListSourceProvider>
    )
    // The drawer closes (the list unmounts) and opens again.
    rerender(<MobileChannelListSourceProvider characters={characters}>{null}</MobileChannelListSourceProvider>)
    rerender(
      <MobileChannelListSourceProvider characters={characters}>
        <Probe />
      </MobileChannelListSourceProvider>
    )
    expect(screen.getByTestId("offset")).toHaveTextContent("320")
  })
})

describe("MobileChannelListStandaloneSource", () => {
  it("reads characters Dexie-first, syncing the table, when no shell provides them", () => {
    useDexieFirstQueryMock.mockReturnValue({ data: characters })
    const { result } = renderHook(() => useMobileChannelListSource(), {
      wrapper: ({ children }) => (
        <MobileChannelListStandaloneSource>{children}</MobileChannelListStandaloneSource>
      ),
    })
    expect(useDexieFirstQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ table: "characters", initial: [] })
    )
    expect(result.current.characters).toBe(characters)
  })
})

describe("context access", () => {
  it("reports no source outside a provider, and the strict hooks say where they belong", () => {
    const { result } = renderHook(() => useOptionalMobileChannelListSource())
    expect(result.current).toBeNull()
    jest.spyOn(console, "error").mockImplementation(() => undefined)
    expect(() => renderHook(() => useMobileChannelListSource())).toThrow(
      /MobileChannelListSourceProvider/
    )
    expect(() => renderHook(() => useMobileChannelSearchField())).toThrow(
      /MobileChannelListSourceProvider/
    )
    ;(console.error as jest.Mock).mockRestore()
  })
})

describe("createMobileChannelScrollMemory", () => {
  it("starts at the top and never stores a negative offset", () => {
    const memory = createMobileChannelScrollMemory()
    expect(memory.read()).toEqual({ offset: 0, measurements: [] })
    memory.saveOffset(-12)
    expect(memory.read().offset).toBe(0)
    const measurements = [{ key: "row:a", index: 0, start: 0, end: 56, size: 56, lane: 0 }]
    memory.saveMeasurements(measurements)
    memory.saveOffset(40)
    expect(memory.read()).toEqual({ offset: 40, measurements })
  })
})
