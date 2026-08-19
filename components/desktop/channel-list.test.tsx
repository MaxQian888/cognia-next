/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { EMPTY_CONVERSATION_FILTERS } from "@/lib/chat/conversation-filters"
import userEvent from "@testing-library/user-event"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import type { Character, ChatSession, Team } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"

const logInfo = jest.fn()
const logWarn = jest.fn()
let mockDragStart: ((event: unknown) => void) | undefined
let mockDragEnd: ((event: unknown) => void) | undefined
let mockDragOver: ((event: unknown) => void) | undefined
let mockDragCancel: (() => void) | undefined
const mockSensorOptions: unknown[] = []
const mockSortableItems: string[][] = []
const mockDroppableNodes = new Map<string, HTMLElement | null>()

jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
  return {
    ...actual,
    DndContext: ({
      children,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDragCancel,
    }: {
      children: React.ReactNode
      onDragStart?: (event: unknown) => void
      onDragEnd: (event: unknown) => void
      onDragOver?: (event: unknown) => void
      onDragCancel?: () => void
    }) => {
      mockDragStart = onDragStart
      mockDragEnd = onDragEnd
      mockDragOver = onDragOver
      mockDragCancel = onDragCancel
      return <>{children}</>
    },
    // The real overlay reads the active draggable from a real DndContext; the
    // stub renders whatever the component decided to put in it.
    DragOverlay: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useSensor: (sensor: unknown, options: unknown) => {
      mockSensorOptions.push(options)
      return actual.useSensor(sensor as never, options as never)
    },
    useDroppable: ({ id }: { id: string }) => ({
      setNodeRef: (node: HTMLElement | null) => mockDroppableNodes.set(id, node),
      isOver: false,
    }),
  }
})

jest.mock("@dnd-kit/sortable", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/sortable")>("@dnd-kit/sortable")
  return {
    ...actual,
    SortableContext: ({ items, ...props }: React.ComponentProps<typeof actual.SortableContext>) => {
      mockSortableItems.push(items.map((item) => String(typeof item === "object" ? item.id : item)))
      return <actual.SortableContext items={items} {...props} />
    },
  }
})

jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationCreated: jest.fn(() => Promise.resolve(true)),
  trackConversationFiltered: jest.fn(() => Promise.resolve(true)),
  trackConversationLayoutChanged: jest.fn(() => Promise.resolve([true])),
  trackConversationOpened: jest.fn(() => Promise.resolve(true)),
  trackConversationReordered: jest.fn(() => Promise.resolve(true)),
  trackConversationRowAction: jest.fn(() => Promise.resolve(true)),
  trackConversationSearched: jest.fn(() => Promise.resolve(true)),
  trackConversationSectionToggled: jest.fn(() => Promise.resolve(true)),
  trackConversationViewChanged: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  // Rows format their own activity timestamp; a fixed formatter keeps these
  // assertions locale- and clock-independent.
  useFormatter: () => ({
    dateTime: (value: Date) => `dt(${value.getTime()})`,
  }),
  useNow: () => new Date(0),
}))

// Complete logger mock: the import chain (plugin-view-container-panel →
// plugin-sdk → lsp-registry) reads `loggers.plugin.child(...)`, so the mock
// must answer any namespace with a logger that has a `.child` method. A Proxy
// keeps it exhaustive without enumerating every namespace.
jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => ({
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: () => makeLogger(),
  })
  return {
    loggers: new Proxy({}, { get: () => makeLogger() }),
    // The plugin-view import chain reaches lib/execution/broker, which calls
    // createLogger() at module load; provide it so the suite can import.
    createLogger: () => makeLogger(),
  }
})

const liveQueryUndefined = Symbol("live-query-undefined")
const callQueue: Array<unknown> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_q: () => Promise<T> | T, _d: unknown[], _i: T): T | undefined => {
    const value = callQueue.shift()
    return value === liveQueryUndefined ? undefined : ((value ?? _i) as T)
  },
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
let collapsedFolderIds: string[] = []
const uiListeners = new Set<() => void>()
const emitUiChange = () => uiListeners.forEach((listener) => listener())
let sidebarCollapsed = false
const setSidebarCollapsed = jest.fn()
const setSidebarWidth = jest.fn()
const setGroupCollapsed = jest.fn()
// Quick filters live in the UI store; default to unfiltered so the existing
// assertions hold, and let individual tests seed a narrowed list.
let conversationFilters: Record<string, unknown> = {
  unread: false,
  pinned: false,
  branched: false,
  kind: "all",
}
const setConversationFilters = jest.fn()
const resetConversationFilters = jest.fn()
jest.mock("@/stores/ui", () => ({
  // A tiny reactive store, not a plain snapshot: folder collapse is read
  // straight from the store now (no local mirror), so a toggle has to
  // re-render the list the way zustand would.
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
      selectedGuild,
      channelListView: "active",
      setChannelListView: () => {},
      collapsedFolderIds,
      setCollapsedFolders: (ids: string[]) => {
        collapsedFolderIds = ids
        emitUiChange()
      },
      toggleCollapsedFolder: (id: string) => {
        collapsedFolderIds = collapsedFolderIds.includes(id)
          ? collapsedFolderIds.filter((f) => f !== id)
          : [...collapsedFolderIds, id]
        emitUiChange()
      },
      groupCollapseOverrides: {},
      setGroupCollapsed,
      conversationFilters,
      setConversationFilters,
      resetConversationFilters,
      sidebarWidth: 256,
      setSidebarWidth,
      sidebarCollapsed,
      setSidebarCollapsed,
    })
  },
  SIDEBAR_WIDTH_DEFAULT: 256,
  SIDEBAR_WIDTH_MIN: 220,
  SIDEBAR_WIDTH_MAX: 420,
}))

// Behavior settings default to today's behavior (comfortable, date grouping on,
// unread badges on, title-only search) so existing assertions hold. Individual
// tests can override `conversationSidebar` to exercise the settings-driven paths.
let conversationSidebar: Record<string, unknown> | null = null
// Which window edge the sidebar takes (`settings.sidebarSide`). Default left,
// the shipped default; individual tests flip it.
let sidebarSide: "left" | "right" = "left"
const saveSettings = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: typeof saveSettings }) => T): T =>
    selector({
      settings:
        conversationSidebar || sidebarSide !== "left"
          ? { conversationSidebar: conversationSidebar ?? undefined, sidebarSide }
          : null,
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

let isNarrow = false
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui") as Record<string, unknown>
  return {
    ...actual,
    useIsNarrow: () => isNarrow,
  }
})

// The expanded rail hosts the shell navigation, the guild accordion headers,
// the footer and the workspace switcher; each has its own suite under
// `components/shell/`, so here they are stubs that record what they were given.
jest.mock("@/components/shell/sidebar-nav-section", () => ({
  SidebarNavSection: () => <nav data-testid="sidebar-nav" />,
}))
jest.mock("@/components/shell/sidebar-guild-sections", () => {
  const actual = jest.requireActual("@/components/shell/sidebar-guild-sections") as {
    splitGuildSections: unknown
  }
  return {
    splitGuildSections: actual.splitGuildSections,
    SidebarGuildSectionRows: ({
      rows,
      openKey,
      testId,
    }: {
      rows: Array<{ key: string }>
      openKey: string | null
      testId?: string
    }) =>
      rows.length === 0 ? null : (
        <div data-testid={testId} data-open={openKey ?? undefined}>
          {rows.map((row) => (
            <span key={row.key} data-testid={`guild-row-${row.key}`} />
          ))}
        </div>
      ),
    SidebarCreateTeamRow: () => <div data-testid="sidebar-guild-create-team" />,
  }
})
jest.mock("@/components/shell/sidebar-footer", () => ({
  SidebarFooter: () => <div data-testid="sidebar-footer" />,
}))
jest.mock("@/components/shell/workspace-switcher", () => ({
  WorkspaceSwitcher: ({ variant }: { variant?: string }) => (
    <div data-testid="workspace-switcher" data-variant={variant} />
  ),
}))

import { ChannelList } from "./channel-list"
import * as listTelemetry from "@/lib/telemetry/conversation-list-events"
import {
  TitleBarOutletsProvider,
  TitleBarProjectionScope,
  useTitleBarOutletRef,
} from "@/components/shell/title-bar-outlets"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"

const characters: Character[] = [
  { id: "c-1", name: "Alice", createdAt: 0, updatedAt: 0 } as unknown as Character,
]
const team: Team = {
  id: "t-1",
  name: "Squad",
  members: [],
  orchestration: "round_robin",
  createdAt: 0,
  updatedAt: 0,
} as unknown as Team

const dmSession: ChatSession = {
  id: "s-1",
  title: "Hi Alice",
  kind: "direct",
  characterId: "c-1",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession
const teamSession: ChatSession = {
  id: "s-2",
  title: "Squad meeting",
  kind: "team",
  teamId: "t-1",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession

function baseSession(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: id,
    kind: "direct",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as ChatSession
}

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  jest.mocked(listTelemetry.trackConversationCreated).mockClear()
  jest.mocked(listTelemetry.trackConversationLayoutChanged).mockClear()
  jest.mocked(listTelemetry.trackConversationOpened).mockClear()
  jest.mocked(listTelemetry.trackConversationReordered).mockClear()
  jest.mocked(listTelemetry.trackConversationRowAction).mockClear()
  jest.mocked(listTelemetry.trackConversationSearched).mockClear()
  jest.mocked(listTelemetry.trackConversationSectionToggled).mockClear()
  jest.mocked(listTelemetry.trackConversationViewChanged).mockClear()
  mockDragStart = undefined
  mockDragEnd = undefined
  mockDragOver = undefined
  mockDragCancel = undefined
  mockSensorOptions.length = 0
  mockSortableItems.length = 0
  mockDroppableNodes.clear()
  callQueue.length = 0
  selectedGuild = { kind: "dm" }
  collapsedFolderIds = []
  isNarrow = false
  sidebarCollapsed = false
  conversationSidebar = null
  sidebarSide = "left"
  conversationFilters = { unread: false, pinned: false, branched: false, kind: "all" }
  setSidebarCollapsed.mockReset()
  setSidebarWidth.mockReset()
  setGroupCollapsed.mockReset()
  __resetAppRuntimeForTesting()
  setConversationFilters.mockReset()
  resetConversationFilters.mockReset()
  saveSettings.mockReset()
  saveSettings.mockResolvedValue(undefined)
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

test("DM guild renders only direct sessions, grouped into date buckets", () => {
  // The rail's DM/Team split is the `"team"` grouping mode; the default
  // (`"workspace"`) deliberately stops filtering by guild.
  conversationSidebar = { groupBy: "team" }
  // queries: characters, sessionStates (none), teams (none)
  callQueue.push(characters, [], [])
  render(
    <ChannelList
      sessions={[dmSession, teamSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getByText("directMessages")).toBeInTheDocument()
  expect(screen.getByText("Hi Alice")).toBeInTheDocument()
  expect(screen.queryByText("Squad meeting")).toBeNull()
  // updatedAt: 0 (epoch) → "Older" date-bucket header (no character grouping).
  expect(screen.getByText("bucketOlder")).toBeInTheDocument()
})

test("renders while team data is loading", () => {
  callQueue.push(characters, [], liveQueryUndefined)

  expect(() =>
    render(
      <ChannelList
        sessions={[dmSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
  ).not.toThrow()
})

test("renders a bound character's custom conversation icon", () => {
  callQueue.push([{ ...characters[0], avatarEmoji: "🐙", avatarColor: "#123456" }], [], undefined)

  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  expect(screen.getByText("🐙")).toBeInTheDocument()
})

test("persists a drag-end reorder for the section that contains both conversations", () => {
  conversationSidebar = { groupBy: "date" }
  callQueue.push(characters, [], undefined)
  const onReorderSessions = jest.fn()
  const now = Date.now()

  render(
    <ChannelList
      sessions={[
        baseSession("first", { updatedAt: now }),
        baseSession("second", { updatedAt: now - 1 }),
      ]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      onReorderSessions={onReorderSessions}
    />
  )

  act(() => {
    mockDragEnd?.({
      active: { id: "second", data: { current: { type: "session", folderId: null } } },
      over: { id: "first", data: { current: { type: "session", folderId: null } } },
    })
  })

  expect(onReorderSessions).toHaveBeenCalledWith(["second", "first"], "date:today")
})

test("previews the pending insertion edge and clears it when the drag is cancelled", () => {
  conversationSidebar = { groupBy: "date" }
  callQueue.push(characters, [], undefined)
  const now = Date.now()

  const { container } = render(
    <ChannelList
      sessions={[
        baseSession("first", { updatedAt: now }),
        baseSession("second", { updatedAt: now - 1 }),
      ]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  act(() => {
    mockDragOver?.({
      active: { id: "second" },
      over: { id: "first" },
    })
  })
  expect(container.querySelector('[data-drop-position="before"]')).toBeInTheDocument()

  act(() => mockDragCancel?.())
  expect(container.querySelector("[data-drop-position]")).toBeNull()
})

test("registers each rendered conversation section as its own sortable list", () => {
  conversationSidebar = { groupBy: "date" }
  callQueue.push(characters, [], undefined)
  const now = Date.now()

  render(
    <ChannelList
      sessions={[
        baseSession("pinned", { pinned: true, updatedAt: now }),
        baseSession("first", { updatedAt: now - 1 }),
        baseSession("second", { updatedAt: now - 2 }),
      ]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  expect(mockSortableItems).toContainEqual(["pinned"])
  expect(mockSortableItems).toContainEqual(["first", "second"])
  expect(mockSortableItems).not.toContainEqual(["pinned", "first", "second"])
})

test("configures the keyboard sensor with sortable coordinates", () => {
  conversationSidebar = { groupBy: "date" }
  callQueue.push(characters, [], undefined)

  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  expect(mockSensorOptions).toContainEqual({
    coordinateGetter: sortableKeyboardCoordinates,
  })
})

test("constrains long session titles to the history rail width", () => {
  conversationSidebar = { groupBy: "team" }
  callQueue.push(characters, [], undefined)
  const longTitle =
    "lark:cai_mrkkmfi6_r07xcp:oc_5a1f_really_long_conversation_identifier_without_breaks"

  const { container } = render(
    <ChannelList
      sessions={[{ ...dmSession, title: longTitle }]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  expect(screen.getByText(longTitle)).toHaveClass("truncate")
  expect(container.querySelector('[data-slot="scroll-area"]')?.className).toContain(
    "[&_[data-slot=scroll-area-viewport]>div]:!block"
  )
  expect(container.querySelector('[data-slot="scroll-area"]')?.className).toContain(
    "[&_[data-slot=scroll-area-scrollbar]]:hidden"
  )
})

test("shows configured agent, model, and provider details using session precedence", () => {
  conversationSidebar = {
    groupBy: "team",
    metadata: ["agent", "model", "provider"],
    titleMotion: "off",
  }
  callQueue.push(characters, [], undefined)

  render(
    <ChannelList
      sessions={[
        {
          ...dmSession,
          model: "claude-sonnet-4-6",
          providerOverride: "anthropic",
        },
      ]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  const details = screen.getByTestId("session-row-metadata")
  expect(details).toHaveTextContent("Alice")
  expect(details).toHaveTextContent("Claude Sonnet 4.6")
  expect(details).toHaveTextContent("Anthropic")
  expect(screen.getByText("Hi Alice").closest('[data-slot="hover-scroll-text"]')).toHaveAttribute(
    "data-motion",
    "off"
  )
})

test("desktop history rail opts into the chat wallpaper with sidebar tonality", () => {
  callQueue.push(characters, [], undefined)
  const { container } = render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  const rail = container.querySelector("aside")
  expect(rail).toHaveAttribute("data-bg-target", "chat")
  // Exactly one tint owner. The rail used to ALSO carry
  // `data-slot="sidebar-inner"`, whose wallpaper rule stacks a second
  // `--sidebar`-based slab under this one, so the list read as opaque next to a
  // chat pane showing the wallpaper.
  expect(rail).not.toHaveAttribute("data-slot", "sidebar-inner")
  const surface = container.querySelector("[data-tonality='translucent']")
  expect(surface).toBeInTheDocument()
  // A `background-image` gradient would win over the tonality rules, which only
  // swap `background-color`.
  expect(surface?.className).not.toContain("bg-gradient-to-b")
  expect(surface).toHaveClass("bg-background/70")
})

test("narrow history sheet uses the same chat wallpaper surface", async () => {
  isNarrow = true
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  await user.click(screen.getByLabelText("openSessions"))
  const dialog = await screen.findByRole("dialog", { name: "conversationsTitle" })
  expect(dialog).toHaveClass("bg-transparent")
  const surface = dialog.querySelector('[data-slot="sidebar-inner"]')
  expect(surface).toHaveAttribute("data-bg-target", "chat")
})

test("embedded resource workbench sessions stay out of the ordinary conversation list", () => {
  const embedded = baseSession("embedded", {
    title: "Canvas assistant",
    kind: "resource-workbench",
    visibility: "embedded",
  })
  callQueue.push(characters, [], undefined)

  render(
    <ChannelList
      sessions={[dmSession, embedded]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  expect(screen.getByText("Hi Alice")).toBeInTheDocument()
  expect(screen.queryByText("Canvas assistant")).toBeNull()
})

describe("collapse (width animation)", () => {
  const rail = () => (
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  test("expanded rail keeps the resize handle and is not inert", () => {
    callQueue.push(characters, [], undefined)
    const { container } = render(rail())
    const aside = container.querySelector("aside")
    expect(aside).not.toHaveAttribute("data-collapsed")
    expect(aside).not.toHaveAttribute("inert")
    expect(screen.getByLabelText("resizeHandle")).toBeInTheDocument()
  })

  test("collapsed rail goes inert and drops the resize handle (no leftover column)", () => {
    sidebarCollapsed = true
    callQueue.push(characters, [], undefined)
    const { container } = render(rail())
    const aside = container.querySelector("aside")
    // Fully collapsed: marked, inert (not focusable), aria-hidden, and the
    // resize handle is gone — the column reclaims its space, no leftover strip.
    expect(aside).toHaveAttribute("data-collapsed")
    expect(aside).toHaveAttribute("inert")
    expect(aside).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByLabelText("resizeHandle")).toBeNull()
  })

  test("toggling collapse turns on the width transition, then clears it", async () => {
    callQueue.push(characters, [], undefined)
    const { container, rerender } = render(rail())
    // Idle (no collapse change yet) → no transition, so drag-resize stays snappy.
    expect(container.querySelector("aside")).not.toHaveClass("transition-[width]")
    // Flip collapsed + re-render: the mount-vs-now diff enables the transition
    // for the collapse/expand animation.
    sidebarCollapsed = true
    callQueue.push(characters, [], undefined)
    rerender(rail())
    expect(container.querySelector("aside")).toHaveClass("transition-[width]")
    // The transition is transient — it clears after the animation window so a
    // subsequent drag-resize isn't animated.
    await waitFor(() =>
      expect(container.querySelector("aside")).not.toHaveClass("transition-[width]")
    )
  })

  test("commits the width transition before collapsed or expanded widths can paint", () => {
    callQueue.push(characters, [], undefined)
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    flushSync(() => root.render(rail()))

    sidebarCollapsed = true
    callQueue.push(characters, [], undefined)
    flushSync(() => root.render(rail()))

    const aside = host.querySelector("aside")
    expect(aside).toHaveStyle({ width: "0px" })
    expect(aside).toHaveClass("transition-[width]", "overflow-hidden")

    sidebarCollapsed = false
    callQueue.push(characters, [], undefined)
    flushSync(() => root.render(rail()))

    expect(aside).toHaveStyle({ width: "256px" })
    expect(aside).toHaveClass("transition-[width]", "overflow-hidden")

    act(() => root.unmount())
    host.remove()
  })
})

test("typing in the search box filters to a flat result list", async () => {
  const dmMatch = {
    ...dmSession,
    id: "s-match",
    title: "Trip budget",
  } as ChatSession
  const dmMiss = {
    ...dmSession,
    id: "s-miss",
    title: "Grocery list",
  } as ChatSession
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmMatch, dmMiss]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.type(screen.getByLabelText("searchAria"), "trip")
  // Matching row stays, non-matching row drops (after the 150ms debounce), and
  // the date-bucket header is replaced by the flat search list.
  await waitFor(() => expect(screen.queryByText("Grocery list")).toBeNull())
  // The title is split across a <mark> and its siblings now that the matched
  // run is emphasized, so match on the row's accumulated text instead.
  expect(
    screen.getByText((_, element) => element?.textContent === "Trip budget", {
      selector: "[data-slot='hover-scroll-text'] > span",
    })
  ).toBeInTheDocument()
  expect(screen.queryByText("bucketOlder")).toBeNull()
})

test("emphasizes the matched run inside a result title", async () => {
  const dmMatch = { ...dmSession, id: "s-match", title: "Trip budget" } as ChatSession
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmMatch]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.type(screen.getByLabelText("searchAria"), "budg")
  // Highlighting is what tells the user WHY a row survived the filter.
  await waitFor(() => {
    const mark = document.querySelector("mark")
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toBe("budg")
  })
})

test("a search that matches nothing shows the empty-search state", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.type(screen.getByLabelText("searchAria"), "zzz")
  // The mocked translator echoes `key:{vars}` for parameterized messages.
  expect(await screen.findByText(/emptySearch/)).toBeInTheDocument()
  expect(screen.queryByText("Hi Alice")).toBeNull()
})

test("the clear button resets the search and restores the list", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.type(screen.getByLabelText("searchAria"), "zzz")
  expect(await screen.findByText(/emptySearch/)).toBeInTheDocument()
  await user.click(screen.getByLabelText("clearSearch"))
  expect(await screen.findByText("Hi Alice")).toBeInTheDocument()
})

test("composes search as one input group with one clear action", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  const search = screen.getByLabelText("searchAria")
  expect(search.closest('[data-slot="input-group"]')).not.toBeNull()
  expect(search.className).toContain("[&::-webkit-search-cancel-button]:hidden")

  await user.type(search, "max")
  expect(screen.getAllByLabelText("clearSearch")).toHaveLength(1)
})

test("Escape clears an active search and restores the grouped list", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  const search = screen.getByLabelText("searchAria")
  expect(screen.getByText("/")).toBeInTheDocument()
  await user.type(search, "zzz")
  expect(screen.queryByText("/")).toBeNull()
  expect(await screen.findByText(/emptySearch/)).toBeInTheDocument()
  await user.keyboard("{Escape}")

  expect(search).toHaveValue("")
  // Still focused after Escape, so the `/` hint stays out of the way; it
  // returns once focus leaves the field.
  expect(search).toHaveFocus()
  expect(screen.queryByText("/")).toBeNull()
  expect(await screen.findByText("Hi Alice")).toBeInTheDocument()
  await user.tab()
  expect(search).not.toHaveFocus()
  expect(screen.getByText("/")).toBeInTheDocument()
})

test("the `/` shortcut hint is decorative: hidden from AT, explained on hover, and yields to focus", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  const search = screen.getByLabelText("searchAria")
  // The real shortcut lives on the input for AT; the keycap is only a picture.
  expect(search).toHaveAttribute("aria-keyshortcuts", "/")
  const hint = screen.getByText("/")
  expect(hint).toHaveAttribute("aria-hidden", "true")
  expect(hint.closest("[title]")).toHaveAttribute("title", "searchShortcutHint")

  await user.click(search)
  expect(screen.queryByText("/")).toBeNull()
  await user.tab()
  expect(screen.getByText("/")).toBeInTheDocument()
})

test.each([
  {
    label: "compactDensity",
    initial: { showPreview: true, density: "comfortable" },
    expected: { showPreview: true, density: "compact" },
  },
  {
    label: "compactDensity",
    initial: { density: "compact" },
    expected: { density: "comfortable" },
  },
  {
    label: "showPreview",
    initial: { showPreview: false },
    expected: { showPreview: true },
  },
  {
    label: "showCustomIcons",
    initial: { showCustomIcons: true },
    expected: { showCustomIcons: false },
  },
  {
    label: "showUnreadBadges",
    initial: { showUnreadBadges: true },
    expected: { showUnreadBadges: false },
  },
  {
    label: "searchMessageContent",
    initial: { searchScope: "title" },
    expected: { searchScope: "titleAndContent" },
  },
  {
    label: "searchMessageContent",
    initial: { searchScope: "titleAndContent" },
    expected: { searchScope: "title" },
  },
  {
    label: "metadata.provider",
    initial: { metadata: ["agent", "model"] },
    expected: { metadata: ["agent", "model", "provider"] },
  },
  {
    label: "titleMotion",
    initial: { titleMotion: "hover" },
    expected: { titleMotion: "off" },
  },
])("display option $label persists its preference without dropping siblings", async (testCase) => {
  conversationSidebar = testCase.initial
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: testCase.label }))

  expect(saveSettings).toHaveBeenCalledWith({ conversationSidebar: testCase.expected })
})

test("rapid display-option changes merge against the latest optimistic settings", async () => {
  conversationSidebar = { density: "comfortable", showPreview: false }
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "compactDensity" }))
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "showPreview" }))

  expect(saveSettings).toHaveBeenLastCalledWith({
    conversationSidebar: { density: "compact", showPreview: true },
  })
})

test("an intermediate store write cannot roll back later optimistic display changes", async () => {
  conversationSidebar = { density: "comfortable", showPreview: false, groupBy: "date" }
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  saveSettings
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve
        })
    )
    .mockResolvedValueOnce(undefined)
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  const renderList = () => (
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  const { rerender } = render(renderList())

  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "compactDensity" }))
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "showPreview" }))

  // Simulate save A reaching the store while save B is still pending.
  conversationSidebar = { density: "compact", showPreview: false, groupBy: "date" }
  callQueue.push(characters, [], undefined)
  rerender(renderList())
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemradio", { name: "groupBy.options.none" }))

  resolveFirst()
  await waitFor(() => expect(saveSettings.mock.calls.length).toBeGreaterThanOrEqual(2))
  resolveSecond()
  await waitFor(() => expect(saveSettings.mock.calls.length).toBeGreaterThanOrEqual(3))
  expect(saveSettings).toHaveBeenLastCalledWith({
    conversationSidebar: { density: "compact", showPreview: true, groupBy: "none" },
  })
})

test("a failed display-option save does not block the next queued change", async () => {
  conversationSidebar = { density: "comfortable", showPreview: false }
  saveSettings.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined)
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[dmSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )

  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "compactDensity" }))
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "showPreview" }))

  await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))
  expect(logWarn).toHaveBeenCalledWith(
    "channel-list display settings save failed",
    expect.objectContaining({ error: "Error: disk full" })
  )
  expect(saveSettings).toHaveBeenLastCalledWith({
    conversationSidebar: { density: "compact", showPreview: true },
  })
})

test("Team guild renders only that team's sessions", () => {
  conversationSidebar = { groupBy: "team" }
  selectedGuild = { kind: "team", teamId: "t-1" }
  callQueue.push(characters, [], [team])
  render(
    <ChannelList
      sessions={[dmSession, teamSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getAllByText("Squad")).toHaveLength(2)
  expect(screen.getByText("Squad meeting")).toBeInTheDocument()
  expect(screen.queryByText("Hi Alice")).toBeNull()
})

describe("workspace grouping (the default axis)", () => {
  // Only `id` and `name` are read by the grouping path.
  const projects = [
    { id: "w1", name: "Alpha" },
    { id: "w2", name: "Beta" },
  ] as unknown as Project[]

  const workspaceSessions = [
    baseSession("here", { projectId: "w1", title: "Here" }),
    baseSession("there", { projectId: "w2", title: "There" }),
    baseSession("nowhere", { title: "Nowhere" }),
  ]

  beforeEach(() => {
    useProjectStore.setState({ projects, activeProjectId: "w1", loaded: true })
  })

  afterEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })

  it("shows the active workspace expanded and the others folded", () => {
    callQueue.push(characters, [], undefined)
    render(
      <ChannelList
        sessions={workspaceSessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    // Headers for both workspaces plus the ungrouped bucket.
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "ungroupedWorkspace" })).toBeInTheDocument()
    // Only the expanded sections render rows.
    expect(screen.getByText("Here")).toBeInTheDocument()
    expect(screen.queryByText("There")).toBeNull()
    expect(screen.getByText("Nowhere")).toBeInTheDocument()
    expect(screen.getByText("Here").closest('[data-slot="collapsible-content"]')).toHaveClass(
      "data-[state=open]:animate-collapsible-down",
      "motion-reduce:animate-none"
    )
    // One chevron that rotates in place (not an icon swap): open → rotated,
    // folded → upright. The whole header button is the hit target and carries
    // its own hover wash + a count pill.
    const alpha = screen.getByRole("button", { name: "Alpha" })
    const beta = screen.getByRole("button", { name: "Beta" })
    expect(within(alpha).getByTestId("section-chevron")).toHaveClass("rotate-90")
    expect(within(beta).getByTestId("section-chevron")).not.toHaveClass("rotate-90")
    expect(within(beta).getByTestId("section-chevron")).toHaveAttribute("data-collapsed")
    expect(alpha).toHaveClass("flex-1", "hover:bg-accent/60")
    expect(within(alpha).getByText("1")).toHaveClass("rounded-full", "tabular-nums")
  })

  it("shows agent metadata for team conversations outside the selected guild", () => {
    const otherTeam = { ...team, id: "t-2", name: "Platform" }
    callQueue.push(characters, [], [team, otherTeam])

    render(
      <ChannelList
        sessions={[
          baseSession("squad", {
            kind: "team",
            teamId: team.id,
            projectId: "w1",
            title: "Squad planning",
          }),
          baseSession("platform", {
            kind: "team",
            teamId: otherTeam.id,
            projectId: "w1",
            title: "Platform planning",
          }),
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )

    expect(
      within(screen.getByText("Squad planning").closest("li")!).getByTestId("session-row-metadata")
    ).toHaveTextContent("Squad")
    expect(
      within(screen.getByText("Platform planning").closest("li")!).getByTestId(
        "session-row-metadata"
      )
    ).toHaveTextContent("Platform")
  })

  it("toggling a workspace header records an explicit collapse choice", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={workspaceSessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "Beta" }))
    expect(setGroupCollapsed).toHaveBeenCalledWith("workspace:w2", false)
    await user.click(screen.getByRole("button", { name: "Alpha" }))
    expect(setGroupCollapsed).toHaveBeenCalledWith("workspace:w1", true)
  })

  it("labels an agent group by its character and the leftovers generically", () => {
    conversationSidebar = { groupBy: "agent" }
    callQueue.push(characters, [], undefined)
    render(
      <ChannelList
        sessions={[
          baseSession("bound", { characterId: "c-1", title: "Bound" }),
          baseSession("loose", { title: "Loose" }),
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    expect(screen.getByRole("button", { name: "Alice" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ungroupedAgent" })).toBeInTheDocument()
    // Agent groups have no auto-collapse rule — both render their rows.
    expect(screen.getByText("Bound")).toBeInTheDocument()
    expect(screen.getByText("Loose")).toBeInTheDocument()
  })
})

test("Empty DM bucket shows the DM empty state", () => {
  callQueue.push(characters, [], undefined)
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getByText("emptyDm")).toBeInTheDocument()
  expect(screen.getAllByRole("button", { name: "newChat" })).toHaveLength(2)
})

test("shows the session-list skeleton while the first Dexie read is loading", () => {
  callQueue.push(characters, [], undefined)
  const { container } = render(
    <ChannelList
      sessions={[]}
      loading
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  // Skeleton placeholders render; the empty state must not flash during load.
  expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0)
  expect(screen.queryByText("emptyDm")).toBeNull()
})

test("Empty DM state CTA calls onNewDirect", async () => {
  callQueue.push(characters, [], undefined)
  const onNewDirect = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={onNewDirect}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.click(screen.getAllByRole("button", { name: "newChat" })[1])
  expect(onNewDirect).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("channel-list new-direct")
})

test("Empty team state CTA routes to onNewTeamConversation with teamId", async () => {
  selectedGuild = { kind: "team", teamId: "t-1" }
  callQueue.push(characters, [], [team])
  const onNew = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={onNew}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.click(screen.getAllByRole("button", { name: "newConversation" })[1])
  expect(onNew).toHaveBeenCalledWith("t-1")
})

describe("multi-select gestures", () => {
  const dmA: ChatSession = {
    id: "s-a",
    title: "Alpha",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 30,
  } as unknown as ChatSession
  const dmB: ChatSession = {
    id: "s-b",
    title: "Bravo",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 20,
  } as unknown as ChatSession
  const dmC: ChatSession = {
    id: "s-c",
    title: "Charlie",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 10,
  } as unknown as ChatSession

  test("plain click activates the session via onSelect (current behavior preserved)", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(onSelect).toHaveBeenCalledWith("s-a")
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  test("Ctrl-click toggles selection without activating the session", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Charlie/ }))
    await user.keyboard("{/Control}")
    expect(onSelect).not.toHaveBeenCalled()
    const toolbar = await screen.findByRole("toolbar")
    expect(toolbar.textContent).toContain(`{"count":2}`)
  })

  test("Shift-click after a plain anchor selects the range and skips activation", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(onSelect).toHaveBeenCalledWith("s-a")
    await user.keyboard("{Shift>}")
    await user.click(screen.getByRole("button", { name: /Charlie/ }))
    await user.keyboard("{/Shift}")
    // The plain click counted once; Shift must NOT have added a second call.
    expect(onSelect).toHaveBeenCalledTimes(1)
    const toolbar = await screen.findByRole("toolbar")
    expect(toolbar.textContent).toContain(`{"count":3}`)
  })

  test("bulk Delete fires onBulkDelete with every selected id and dismisses the toolbar", async () => {
    callQueue.push(characters, [], undefined)
    const onBulkDelete = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onBulkDelete={onBulkDelete}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    await user.click(screen.getByRole("button", { name: "delete" }))
    const dialog = await screen.findByRole("alertdialog")
    const dialogDelete = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "delete"
    )
    if (!dialogDelete) throw new Error("expected destructive button")
    await user.click(dialogDelete)
    expect(onBulkDelete).toHaveBeenCalledTimes(1)
    expect(onBulkDelete.mock.calls[0][0].sort()).toEqual(["s-a", "s-b"])
  })

  test("bulk Pin fires onBulkSetPinned(true, ids)", async () => {
    callQueue.push(characters, [], undefined)
    const onBulkSetPinned = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onBulkSetPinned={onBulkSetPinned}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    await user.click(screen.getByRole("button", { name: "pin" }))
    expect(onBulkSetPinned).toHaveBeenCalledTimes(1)
    expect(onBulkSetPinned.mock.calls[0][0].sort()).toEqual(["s-a", "s-b"])
    expect(onBulkSetPinned.mock.calls[0][1]).toBe(true)
  })

  test("bulk Share opens the selected conversations in visible order", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")

    await user.click(screen.getByRole("button", { name: "share" }))

    const dialog = await screen.findByRole("dialog")
    const summary = within(dialog).getByLabelText('summary:{"count":2}')
    expect(
      within(summary)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["Alpha", "Bravo"])

    await user.click(within(dialog).getByRole("button", { name: /close/i }))
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  test("row action menu starts selection without a keyboard modifier", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )

    await user.click(screen.getAllByRole("button", { name: "actionsMenu" })[0])
    await user.click(await screen.findByText("select"))

    expect(await screen.findByRole("toolbar")).toHaveTextContent('selectedCount:{"count":1}')
  })

  test("Escape clears the active multi-selection", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    expect(await screen.findByRole("toolbar")).toBeInTheDocument()
    // Press Escape on the container that mounted the keydown listener.
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  test("pinned-on-top sort places pinned sessions before unpinned in the DM group", () => {
    callQueue.push(characters, [], undefined)
    render(
      <ChannelList
        sessions={[
          { ...dmA, pinned: false } as ChatSession,
          { ...dmB, pinned: true } as ChatSession,
          { ...dmC, pinned: false } as ChatSession,
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => /Alpha|Bravo|Charlie/.test(b.textContent ?? ""))
    // Bravo is pinned → must be first; the other two stay newest-first by updatedAt.
    expect(buttons[0].textContent).toMatch(/Bravo/)
    expect(buttons[1].textContent).toMatch(/Alpha/)
    expect(buttons[2].textContent).toMatch(/Charlie/)
  })
})

test("archive view toggle switches between active and archived sessions", async () => {
  const activeS = baseSession("act", { title: "Active one", updatedAt: 100 })
  const archivedS = baseSession("arc", { title: "Archived one", archivedAt: 50, updatedAt: 90 })
  // characters, sessionStates, team — consumed twice (toggle re-renders reuse memo).
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[activeS, archivedS]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      onArchive={jest.fn()}
      onUnarchive={jest.fn()}
    />
  )
  // Active view: only the non-archived session shows.
  expect(screen.getByText("Active one")).toBeInTheDocument()
  expect(screen.queryByText("Archived one")).toBeNull()
  // Toggle into the archived view.
  await user.click(screen.getByRole("button", { name: "viewArchived" }))
  expect(await screen.findByText("Archived one")).toBeInTheDocument()
  expect(screen.queryByText("Active one")).toBeNull()
})

test("an empty archived view shows the archived empty state", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("act", { title: "Active one" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      onArchive={jest.fn()}
      onUnarchive={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "viewArchived" }))
  expect(await screen.findByText("emptyArchived")).toBeInTheDocument()
})

test("per-row Archive action fires onArchive", async () => {
  callQueue.push(characters, [], undefined)
  const onArchive = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("act", { title: "Active one" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      onArchive={onArchive}
      onUnarchive={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("archive"))
  expect(onArchive).toHaveBeenCalledWith("act")
})

const workFolder = {
  id: "f1",
  name: "Work",
  projectId: "p",
  order: 0,
  createdAt: 0,
  updatedAt: 0,
} as never

test("renders a collapsible folder section for foldered sessions", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("in-folder", { title: "Inside work", folderId: "f1" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={[workFolder]}
      onAssignToFolder={jest.fn()}
    />
  )
  // The folder header renders and its member shows under it.
  expect(screen.getAllByText("Work").length).toBeGreaterThan(0)
  expect(screen.getByText("Inside work")).toBeInTheDocument()
  // Collapsing the folder hides its rows.
  const folderTrigger = screen.getByRole("button", { name: "Work" })
  // Radix owns data-slot on an asChild trigger; the shadcn Button variant
  // metadata remains available and proves the primitive is composed here.
  expect(folderTrigger).toHaveAttribute("data-variant", "ghost")
  await user.click(folderTrigger)
  expect(screen.queryByText("Inside work")).toBeNull()
})

test("limits a folder drop target to its header so child rows remain sortable targets", () => {
  callQueue.push(characters, [], undefined)
  render(
    <ChannelList
      sessions={[baseSession("in-folder", { title: "Inside work", folderId: "f1" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={[workFolder]}
      onAssignToFolder={jest.fn()}
    />
  )

  const folderDropTarget = mockDroppableNodes.get("folder:f1")
  expect(folderDropTarget).toBeInstanceOf(HTMLElement)
  expect(folderDropTarget).not.toContainElement(screen.getByText("Inside work"))
})

test("New folder stays in the display menu and invokes onCreateFolder", async () => {
  callQueue.push(characters, [], undefined)
  const onCreateFolder = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("a", { title: "A" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={[]}
      onCreateFolder={onCreateFolder}
    />
  )
  expect(screen.queryByRole("button", { name: "newFolder" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(screen.getByRole("menuitem", { name: "newFolder" }))
  expect(onCreateFolder).toHaveBeenCalledWith("newFolderName")
})

test("the display menu carries the sort axis beside grouping", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("a", { title: "A" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  // Grouping and sorting are siblings; the menu that offers one offers both.
  expect(screen.getByText("groupBy.label")).toBeInTheDocument()
  expect(screen.getByText("sortBy.label")).toBeInTheDocument()
  expect(screen.getByTestId("channel-list-sort-recent")).toHaveAttribute("aria-checked", "true")
  await user.click(screen.getByTestId("channel-list-sort-title"))
  expect(saveSettings).toHaveBeenCalledWith({ conversationSidebar: { sortBy: "title" } })
})

test("a folder created from the list opens its name for editing straight away", async () => {
  const folder = {
    id: "f-new",
    projectId: "p1",
    name: "newFolderName",
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  // First render: no folders yet. After the create resolves the live query
  // re-emits with the new folder, the way Dexie does.
  callQueue.push(characters, [], [])
  const onCreateFolder = jest.fn(async () => folder)
  const onRenameFolder = jest.fn()
  const user = userEvent.setup()
  const props = {
    sessions: [baseSession("a", { title: "A", folderId: "f-new" })],
    activeSessionId: null,
    onSelect: jest.fn(),
    onNewDirect: jest.fn(),
    onNewTeamConversation: jest.fn(),
    onDelete: jest.fn(),
    onRename: jest.fn(),
    onCreateFolder,
    onRenameFolder,
  }
  const { rerender } = render(<ChannelList {...props} folders={[]} />)
  await user.click(screen.getByRole("button", { name: "displayOptions" }))
  await user.click(screen.getByRole("menuitem", { name: "newFolder" }))
  expect(onCreateFolder).toHaveBeenCalledWith("newFolderName")
  await act(async () => {})
  rerender(<ChannelList {...props} folders={[folder]} />)

  // The editor is already open, with the placeholder there to be replaced.
  const input = screen.getByLabelText("renameFolder")
  expect(input).toHaveValue("newFolderName")
  await user.clear(input)
  await user.type(input, "Research{Enter}")
  expect(onRenameFolder).toHaveBeenCalledWith("f-new", "Research")
  // Settled: the editor closes and does not reopen on the next render.
  expect(screen.queryByLabelText("renameFolder")).toBeNull()
})

test("folder header menu moves a folder through the manual order", async () => {
  const folders = [
    { id: "f1", projectId: "p", name: "First", order: 0, createdAt: 0, updatedAt: 0 },
    { id: "f2", projectId: "p", name: "Second", order: 1, createdAt: 0, updatedAt: 0 },
    { id: "f3", projectId: "p", name: "Third", order: 2, createdAt: 0, updatedAt: 0 },
  ]
  callQueue.push(characters, [], undefined)
  const onReorderFolders = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[
        baseSession("a", { title: "A", folderId: "f1" }),
        baseSession("b", { title: "B", folderId: "f2" }),
        baseSession("c", { title: "C", folderId: "f3" }),
      ]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={folders}
      onReorderFolders={onReorderFolders}
    />
  )
  const menus = screen.getAllByRole("button", { name: "folderActions" })
  await user.click(menus[1])
  await user.click(screen.getByTestId("folder-move-up-f2"))
  expect(onReorderFolders).toHaveBeenCalledWith(["f2", "f1", "f3"])

  // The ends are inert rather than silently doing nothing.
  await user.click(screen.getAllByRole("button", { name: "folderActions" })[0])
  expect(screen.getByTestId("folder-move-up-f1")).toHaveAttribute("aria-disabled", "true")
  expect(screen.getByTestId("folder-move-down-f1")).not.toHaveAttribute("aria-disabled", "true")
})

test("folder move items stay hidden without a reorder handler", async () => {
  callQueue.push(characters, [], undefined)
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("a", { title: "A", folderId: "f1" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      onRenameFolder={jest.fn()}
      folders={[
        { id: "f1", projectId: "p", name: "First", order: 0, createdAt: 0, updatedAt: 0 },
        { id: "f2", projectId: "p", name: "Second", order: 1, createdAt: 0, updatedAt: 0 },
      ]}
    />
  )
  await user.click(screen.getAllByRole("button", { name: "folderActions" })[0])
  expect(screen.queryByTestId("folder-move-up-f1")).toBeNull()
})

test("folder header menu deletes the folder after confirmation", async () => {
  callQueue.push(characters, [], undefined)
  const onDeleteFolder = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("in-folder", { title: "Inside", folderId: "f1" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={[workFolder]}
      onAssignToFolder={jest.fn()}
      onDeleteFolder={onDeleteFolder}
    />
  )
  await user.click(screen.getByRole("button", { name: "folderActions" }))
  await user.click(await screen.findByText("deleteFolder"))
  const dialog = await screen.findByRole("alertdialog")
  const confirm = Array.from(dialog.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "deleteFolder"
  )
  if (!confirm) throw new Error("expected destructive confirm button")
  await user.click(confirm)
  expect(onDeleteFolder).toHaveBeenCalledWith("f1")
})

test("folder rename uses an input outside the collapsible button", async () => {
  callQueue.push(characters, [], undefined)
  const onRenameFolder = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[baseSession("in-folder", { title: "Inside", folderId: "f1" })]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
      folders={[workFolder]}
      onAssignToFolder={jest.fn()}
      onRenameFolder={onRenameFolder}
    />
  )

  await user.click(screen.getByRole("button", { name: "folderActions" }))
  await user.click(await screen.findByRole("menuitem", { name: "renameFolder" }))
  const input = screen.getByRole("textbox", { name: "renameFolder" })
  expect(input.closest("button")).toBeNull()
  await user.clear(input)
  await user.type(input, "Renamed{Enter}")
  expect(onRenameFolder).toHaveBeenCalledWith("f1", "Renamed")
})

describe("interaction upgrades", () => {
  const dmA = baseSession("s-a", { title: "Alpha", updatedAt: 30 })
  const dmB = baseSession("s-b", { title: "Bravo", updatedAt: 20 })

  test("renders a keyboard-accessible resize separator with width bounds", () => {
    callQueue.push(characters, [], undefined)
    render(
      <ChannelList
        sessions={[dmA]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const handle = screen.getByRole("separator", { name: "resizeHandle" })
    expect(handle).toHaveAttribute("aria-valuenow", "256")
    expect(handle).toHaveAttribute("aria-valuemin", "220")
    expect(handle).toHaveAttribute("aria-valuemax", "420")
  })

  test("arrow-down focuses a row and Enter opens it", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    const { container } = render(
      <ChannelList
        sessions={[dmA, dmB]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const list = container.querySelector('[tabindex="0"]') as HTMLElement
    list.focus()
    await user.keyboard("{ArrowDown}")
    expect(container.querySelector("li[data-focused]")).toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledWith("s-a")
  })

  test("the slash key focuses the search box", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    const { container } = render(
      <ChannelList
        sessions={[dmA]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const list = container.querySelector('[tabindex="0"]') as HTMLElement
    list.focus()
    await user.keyboard("/")
    expect(screen.getByLabelText("searchAria")).toHaveFocus()
  })

  test("the app-wide focus-search shortcut expands a collapsed rail, then focuses the field", () => {
    sidebarCollapsed = true
    callQueue.push(characters, [], undefined)
    const { rerender } = render(
      <ChannelList
        sessions={[dmA]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const registration = getAppRegistration("app.search.focus")
    expect(registration).toBeDefined()
    act(() => registration!.handler(new KeyboardEvent("keydown", { key: "/" })))
    // Collapsed: the field is inert, so the shortcut asks the store to expand
    // and defers the focus to the frame that renders the rail back.
    expect(setSidebarCollapsed).toHaveBeenCalledWith(false)
    expect(screen.getByLabelText("searchAria")).not.toHaveFocus()
    sidebarCollapsed = false
    rerender(
      <ChannelList
        sessions={[dmA]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    expect(screen.getByLabelText("searchAria")).toHaveFocus()
    // Expanded: no store write, straight to the field.
    setSidebarCollapsed.mockClear()
    act(() => registration!.handler(new KeyboardEvent("keydown", { key: "/" })))
    expect(setSidebarCollapsed).not.toHaveBeenCalled()
    expect(screen.getByLabelText("searchAria")).toHaveFocus()
  })

  test("⌘⌥] / ⌘⌥[ step the active conversation through the visible order", () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const props = {
      sessions: [dmA, dmB],
      onSelect,
      onNewDirect: jest.fn(),
      onNewTeamConversation: jest.fn(),
      onDelete: jest.fn(),
      onRename: jest.fn(),
    }
    const { rerender } = render(<ChannelList {...props} activeSessionId={null} />)
    const next = getAppRegistration("shell.conversation.next")
    const previous = getAppRegistration("shell.conversation.previous")
    expect(next).toBeDefined()
    expect(previous).toBeDefined()
    // Both fire from inside the composer — that is the point of the chords.
    expect(next?.allowInEditable).toBe(true)
    expect(previous?.allowInEditable).toBe(true)
    const press = (r: typeof next) =>
      act(() => r!.handler(new KeyboardEvent("keydown", { key: "]", ctrlKey: true, altKey: true })))

    // Nothing active: "next" starts at the top, "previous" at the bottom.
    press(next)
    expect(onSelect).toHaveBeenLastCalledWith("s-a")
    press(previous)
    expect(onSelect).toHaveBeenLastCalledWith("s-b")

    rerender(<ChannelList {...props} activeSessionId="s-a" />)
    press(next)
    expect(onSelect).toHaveBeenLastCalledWith("s-b")
    onSelect.mockClear()
    // Clamped at the ends: no wrap, no redundant re-select.
    press(previous)
    expect(onSelect).toHaveBeenCalledTimes(0)

    rerender(<ChannelList {...props} activeSessionId="s-b" />)
    press(next)
    expect(onSelect).toHaveBeenCalledTimes(0)
    press(previous)
    expect(onSelect).toHaveBeenLastCalledWith("s-a")
  })

  test("content-scope search surfaces sessions matched only by message body", async () => {
    conversationSidebar = { searchScope: "titleAndContent" }
    historySearchState = {
      ...historySearchState,
      results: [{ sessionId: "s-b" }],
    }
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    // "zzz" matches no title; only the content-search set contains s-b (Bravo).
    await user.type(screen.getByLabelText("searchAria"), "zzz")
    await waitFor(() =>
      expect(useChatHistorySearch).toHaveBeenLastCalledWith(
        "zzz",
        expect.objectContaining({ collapseBySession: true })
      )
    )
    expect(await screen.findByText("Bravo")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).toBeNull()
  })
})

test("Canvas guild renders nothing (canvas has its own rail)", () => {
  selectedGuild = { kind: "canvas" }
  // No queries are consumed because the body returns null early.
  callQueue.push(characters, [], undefined)
  const { container } = render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  // The aside renders but its body short-circuits to null.
  expect(container.querySelector("aside")?.textContent).toBe("")
})

describe("filters and sorting", () => {
  const renderList = (sessions: ChatSession[]) => {
    callQueue.push(characters, [], undefined)
    return render(
      <ChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
  }

  it("hides the chip row while the list is in its default state", () => {
    renderList([dmSession])
    expect(screen.queryByTestId("channel-list-filter-chips")).toBeNull()
  })

  it("badges the trigger and shows a removable chip once a filter is active", async () => {
    conversationFilters = { unread: false, pinned: true, branched: false, kind: "all" }
    const user = userEvent.setup()
    renderList([dmSession, { ...dmSession, id: "s-pin", pinned: true } as ChatSession])

    const trigger = screen.getByTestId("channel-list-filter-trigger")
    expect(trigger).toHaveAttribute("data-active-filters", "1")
    expect(screen.getByTestId("channel-list-filter-chips")).toBeInTheDocument()
    // 1 of the 2 conversations survives the filter — the count has to say so,
    // or a narrowed list reads as lost data.
    expect(screen.getByTestId("channel-list-filter-chips-count")).toHaveTextContent(
      'count:{"shown":1,"total":2}'
    )

    await user.click(screen.getByLabelText('remove:{"name":"filters.options.pinned"}'))
    expect(setConversationFilters).toHaveBeenCalledWith(EMPTY_CONVERSATION_FILTERS)
  })

  it("applies the unread filter even when unread badges are switched off", async () => {
    // Hiding a badge is a display choice, not a claim that nothing is unread.
    conversationSidebar = { showUnreadBadges: false }
    conversationFilters = { unread: true, pinned: false, branched: false, kind: "all" }
    callQueue.push(characters, [{ sessionId: "s-unread", unreadCount: 3 }], undefined)
    render(
      <ChannelList
        sessions={[
          { ...dmSession, id: "s-unread", title: "Has unread" } as ChatSession,
          { ...dmSession, id: "s-read", title: "All read" } as ChatSession,
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    expect(await screen.findByText("Has unread")).toBeInTheDocument()
    expect(screen.queryByText("All read")).toBeNull()
  })

  it("offers a reset when filters hide everything, and says so distinctly", async () => {
    conversationFilters = { unread: false, pinned: true, branched: false, kind: "all" }
    const user = userEvent.setup()
    renderList([dmSession])
    // Not the search empty state — the exit here is dropping the filter.
    expect(screen.getByText('emptyFiltered:{"count":1}')).toBeInTheDocument()
    await user.click(screen.getByTestId("channel-list-empty-clear-filters"))
    expect(resetConversationFilters).toHaveBeenCalled()
  })

  it("persists a sort choice to the sidebar settings", async () => {
    const user = userEvent.setup()
    renderList([dmSession])
    await user.click(screen.getByTestId("channel-list-filter-trigger"))
    // Facets live in hover submenus that open beside the sidebar; items are
    // activated with fireEvent (see conversation-filter-controls.test.tsx).
    await user.hover(await screen.findByTestId("channel-list-filter-trigger-section-sort"))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "sort.options.title" }))
    // The sidebar routes settings writes through its async save queue.
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({ conversationSidebar: { sortBy: "title" } })
    )
  })

  it("reorders rows under a title sort", async () => {
    conversationSidebar = { sortBy: "title", groupBy: "none" }
    renderList([
      { ...dmSession, id: "s-z", title: "Zulu", updatedAt: 3 } as ChatSession,
      { ...dmSession, id: "s-a", title: "Alpha", updatedAt: 1 } as ChatSession,
    ])
    const titles = await screen.findAllByText(/Zulu|Alpha/)
    expect(titles.map((n) => n.textContent)).toEqual(["Alpha", "Zulu"])
  })

  it("pins a sort chip so a non-default order is never a mystery", () => {
    conversationSidebar = { sortBy: "title" }
    renderList([dmSession])
    expect(screen.getByTestId("channel-list-filter-chips")).toHaveTextContent("sort.options.title")
  })

  it("drops the drag handles under a sort that cannot keep a manual order", async () => {
    conversationSidebar = { sortBy: "title" }
    renderList([dmSession])
    // The grip would otherwise promise an order the list discards on the next
    // render — see `sortSupportsManualOrder`.
    expect(await screen.findByText("Hi Alice")).toBeInTheDocument()
    expect(screen.queryByLabelText("dragHandle")).toBeNull()
  })

  it("keeps the drag handles under the default recency sort", async () => {
    renderList([dmSession])
    expect(await screen.findByText("Hi Alice")).toBeInTheDocument()
    expect(screen.getAllByLabelText("dragHandle").length).toBeGreaterThan(0)
  })
})

describe("channel-list branch coverage top-ups", () => {
  const renderList = (
    sessions: ChatSession[],
    extra: Partial<React.ComponentProps<typeof ChannelList>> = {}
  ) => {
    callQueue.push(characters, [], undefined)
    return render(
      <ChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        {...extra}
      />
    )
  }

  it("narrows to team conversations from the kind facet", async () => {
    const user = userEvent.setup()
    renderList([dmSession, teamSession])
    await user.click(screen.getByTestId("channel-list-filter-trigger"))
    await user.hover(await screen.findByTestId("channel-list-filter-trigger-section-status"))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "kind.options.team" }))
    expect(setConversationFilters).toHaveBeenCalledWith({
      ...EMPTY_CONVERSATION_FILTERS,
      kind: "team",
    })
  })

  it("renders the kind filter as applied when the store already holds it", async () => {
    conversationFilters = { unread: false, pinned: false, branched: false, kind: "team" }
    renderList([dmSession, teamSession])
    expect(await screen.findByText("Squad meeting")).toBeInTheDocument()
    expect(screen.queryByText("Hi Alice")).toBeNull()
  })

  it("Escape drops the keyboard focus ring once nothing is selected", async () => {
    const user = userEvent.setup()
    const { container } = renderList([dmSession])
    const list = container.querySelector('[tabindex="0"]') as HTMLElement
    list.focus()
    await user.keyboard("{ArrowDown}")
    await waitFor(() => expect(container.querySelector("li[data-focused]")).not.toBeNull())
    await user.keyboard("{Escape}")
    expect(container.querySelector("li[data-focused]")).toBeNull()
  })

  it("warns that content-search results were clipped", async () => {
    conversationSidebar = { searchScope: "titleAndContent" }
    historySearchState = { ...historySearchState, moreOlderHistory: true }
    const user = userEvent.setup()
    renderList([dmSession])
    await user.type(screen.getByLabelText("searchAria"), "alice")
    // Silently truncated results read as "that conversation is gone".
    expect(await screen.findByText("searchTruncated")).toBeInTheDocument()
  })

  it("starts a team conversation from the header CTA inside a team guild", async () => {
    selectedGuild = { kind: "team", teamId: "t-1" }
    const onNewTeamConversation = jest.fn()
    const user = userEvent.setup()
    callQueue.push(characters, [], [team])
    render(
      <ChannelList
        sessions={[teamSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={onNewTeamConversation}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(await screen.findByRole("button", { name: "newConversation" }))
    expect(onNewTeamConversation).toHaveBeenCalledWith("t-1")
  })

  it("invites the user to fill an empty folder instead of showing a bare header", async () => {
    renderList([dmSession], {
      folders: [{ id: "f-1", name: "Reading", order: 0, createdAt: 0, updatedAt: 0 }],
    })
    expect(await screen.findByText("emptyFolder")).toBeInTheDocument()
  })

  it("abandons a folder rename on Escape without persisting the draft", async () => {
    const onRenameFolder = jest.fn()
    const user = userEvent.setup()
    renderList([dmSession], {
      folders: [{ id: "f-1", name: "Reading", order: 0, createdAt: 0, updatedAt: 0 }],
      onRenameFolder,
    })
    await user.click(await screen.findByRole("button", { name: "folderActions" }))
    await user.click(await screen.findByText("renameFolder"))
    const input = await screen.findByLabelText("renameFolder")
    await user.clear(input)
    await user.type(input, "Archive{Escape}")
    expect(onRenameFolder).not.toHaveBeenCalled()
  })
})

describe("unread badges and identity rendering", () => {
  it("shows the per-row unread count when badges are enabled", async () => {
    callQueue.push(characters, [{ sessionId: "s-1", unreadCount: 4 }], undefined)
    render(
      <ChannelList
        sessions={[dmSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    expect(await screen.findByText("4")).toBeInTheDocument()
  })

  it("renders a team's own identity and name on its rows", async () => {
    selectedGuild = { kind: "team", teamId: "t-1" }
    conversationSidebar = { metadata: ["agent"] }
    callQueue.push(characters, [], [team])
    render(
      <ChannelList
        sessions={[teamSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    // The team supplies both the row avatar subject and the `agent` detail —
    // a team conversation must not fall back to a character it has no binding to.
    expect(await screen.findByTestId("session-row-metadata")).toHaveTextContent("Squad")
  })

  it("selects the whole visible list with Ctrl+A", async () => {
    const user = userEvent.setup()
    callQueue.push(characters, [], undefined)
    const { container } = render(
      <ChannelList
        sessions={[dmSession, { ...dmSession, id: "s-9", title: "Second" } as ChatSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const list = container.querySelector('[tabindex="0"]') as HTMLElement
    list.focus()
    await user.keyboard("{Control>}a{/Control}")
    await waitFor(() => expect(container.querySelectorAll("li[data-selected]")).toHaveLength(2))
  })

  it("hands the middle column to a plugin view container instead of the session list", () => {
    selectedGuild = { kind: "plugin-view", containerId: "pv-1" } as SelectedGuild
    const { container } = render(
      <ChannelList
        sessions={[dmSession]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    // The plugin container owns the column; the session list must not also
    // render into it.
    expect(container.querySelector("aside")?.textContent).not.toContain("Hi Alice")
    expect(screen.queryByLabelText("searchAria")).toBeNull()
  })
})

describe("title-bar projection", () => {
  function StartOutlet() {
    const ref = useTitleBarOutletRef("start")
    return <div ref={ref} data-testid="start-outlet" />
  }

  function renderProjected() {
    callQueue.push(characters, [], [])
    return render(
      <TitleBarOutletsProvider>
        <StartOutlet />
        <TitleBarProjectionScope enabled>
          <ChannelList
            sessions={[dmSession]}
            activeSessionId={null}
            onSelect={jest.fn()}
            onNewDirect={jest.fn()}
            onNewTeamConversation={jest.fn()}
            onDelete={jest.fn()}
            onRename={jest.fn()}
          />
        </TitleBarProjectionScope>
      </TitleBarOutletsProvider>
    )
  }

  it("keeps the sidebar unprojected and unmerged on the right edge", () => {
    sidebarSide = "right"
    renderProjected()
    // The bar's start zone is the *leading* column's; a right-docked sidebar
    // has none to take, so it heads itself and the icon column stays beside
    // it rather than folding in.
    expect(screen.getByTestId("start-outlet")).toBeEmptyDOMElement()
    expect(screen.queryByTestId("sidebar-nav")).toBeNull()
    expect(screen.queryByTestId("sidebar-footer")).toBeNull()
    expect(useShellColumnsStore.getState().sidebarHostsNav).toBe(false)
    // Its own 40px header carries the guild title and the list's actions.
    const header = screen.getByTestId("channel-list-header")
    expect(header).toHaveTextContent("directMessages")
    expect(within(header).getByLabelText("newChat")).toBeInTheDocument()
  })

  it("flips the seam and the resize handle to the inboard edge on the right", () => {
    sidebarSide = "right"
    renderProjected()
    const rail = document.getElementById("conversation-sidebar")!
    expect(rail.className).toContain("border-l")
    expect(rail.className).not.toContain("border-r")
    const handle = screen.getByRole("separator", { name: "resizeHandle" })
    expect(handle.className).toContain("left-0")
    expect(handle.className).not.toContain("right-0")
  })

  it("resizes the right-docked sidebar in the inverted direction", () => {
    sidebarSide = "right"
    renderProjected()
    const handle = screen.getByRole("separator", { name: "resizeHandle" })
    // A right-docked sidebar grows toward the window centre, so ArrowLeft
    // widens it (`useEdgeResize({ edge: "left" })`) — the mirror of the
    // left-docked handle, which the default-side test below pins.
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(setSidebarWidth).toHaveBeenLastCalledWith(272)
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(setSidebarWidth).toHaveBeenLastCalledWith(240)
  })

  it("resizes the left-docked sidebar the other way", () => {
    renderProjected()
    const handle = screen.getByRole("separator", { name: "resizeHandle" })
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(setSidebarWidth).toHaveBeenLastCalledWith(272)
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(setSidebarWidth).toHaveBeenLastCalledWith(240)
  })

  it("heads the bar's start outlet with the workspace switcher and hosts the shell navigation", () => {
    renderProjected()
    const outlet = screen.getByTestId("start-outlet")
    const rail = document.getElementById("conversation-sidebar")!
    // The sidebar's identity — the workspace — is what goes in the bar; the
    // guild title is the open accordion row inside the sidebar now.
    expect(outlet).toContainElement(screen.getByTestId("channel-list-header"))
    expect(outlet).toContainElement(screen.getByTestId("workspace-switcher"))
    expect(screen.getByTestId("workspace-switcher")).toHaveAttribute("data-variant", "wide")
    expect(outlet).not.toHaveTextContent("directMessages")
    // New conversation heads the rail, then the nav rows. With Chats open and
    // no teams the accordion has nothing to draw at all — the list is it.
    expect(rail).toContainElement(screen.getByTestId("sidebar-new-conversation"))
    expect(rail).toContainElement(screen.getByTestId("sidebar-nav"))
    expect(screen.queryByTestId("sidebar-guild-rows-before")).toBeNull()
    expect(screen.queryByTestId("sidebar-guild-rows-after")).toBeNull()
    expect(rail).toContainElement(screen.getByTestId("sidebar-guild-create-team"))
    expect(rail).toContainElement(screen.getByTestId("sidebar-footer"))
    // The list itself stays in the rail.
    expect(rail).toContainElement(screen.getByText("Hi Alice"))
    expect(rail).not.toContainElement(screen.getByTestId("channel-list-header"))
    // …and it claims the navigation, so the shell can drop the icon column.
    expect(useShellColumnsStore.getState().sidebarHostsNav).toBe(true)
  })

  it("orders the accordion around the list: open team's row above, the rest below", () => {
    selectedGuild = { kind: "team", teamId: "t-2" }
    const teams = [
      { id: "t-1", name: "Alpha" },
      { id: "t-2", name: "Beta" },
      { id: "t-3", name: "Gamma" },
    ]
    callQueue.length = 0
    // The projection scope re-renders the rail as the outlet registers; the
    // live-query stub is drained per call, so seed every pass.
    for (let i = 0; i < 6; i++) callQueue.push(characters, [], teams)
    render(
      <TitleBarOutletsProvider>
        <StartOutlet />
        <TitleBarProjectionScope enabled>
          <ChannelList
            sessions={[dmSession]}
            activeSessionId={null}
            onSelect={jest.fn()}
            onNewDirect={jest.fn()}
            onNewTeamConversation={jest.fn()}
            onDelete={jest.fn()}
            onRename={jest.fn()}
          />
        </TitleBarProjectionScope>
      </TitleBarOutletsProvider>
    )
    const before = screen.getByTestId("sidebar-guild-rows-before")
    const after = screen.getByTestId("sidebar-guild-rows-after")
    expect(before).toHaveAttribute("data-open", "t-2")
    expect(before).toContainElement(screen.getByTestId("guild-row-dm"))
    expect(before).toContainElement(screen.getByTestId("guild-row-t-1"))
    expect(before).toContainElement(screen.getByTestId("guild-row-t-2"))
    expect(after).toContainElement(screen.getByTestId("guild-row-t-3"))
    // The search row (the open section's content) sits between the two runs.
    const search = screen.getByTestId("channel-list-search")
    expect(before.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(search.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("stands down while collapsed — an invisible rail leaves nothing in the bar and hands the navigation back", () => {
    sidebarCollapsed = true
    renderProjected()
    expect(screen.getByTestId("start-outlet")).toBeEmptyDOMElement()
    expect(document.getElementById("conversation-sidebar")).toContainElement(
      screen.getByTestId("channel-list-header")
    )
    expect(screen.queryByTestId("sidebar-nav")).toBeNull()
    expect(useShellColumnsStore.getState().sidebarHostsNav).toBe(false)
  })

  it("keeps the mobile Sheet's header inline, without the shell navigation", () => {
    isNarrow = true
    renderProjected()
    expect(screen.getByTestId("start-outlet")).toBeEmptyDOMElement()
    expect(screen.queryByTestId("sidebar-nav")).toBeNull()
    expect(useShellColumnsStore.getState().sidebarHostsNav).toBe(false)
  })

  it("leaves the icon column in charge while a plugin view replaces the list", () => {
    selectedGuild = { kind: "plugin-view", containerId: "p:v" }
    const { unmount } = renderProjected()
    expect(useShellColumnsStore.getState().sidebarHostsNav).toBe(false)
    unmount()
  })

  it("heads the rail with new-conversation and puts the rest behind ⋯ on the search row", async () => {
    renderProjected()
    const rail = document.getElementById("conversation-sidebar")!
    // Nothing but the workspace switcher in the bar.
    const newButton = screen.getByTestId("sidebar-new-conversation")
    expect(screen.getByTestId("start-outlet")).not.toContainElement(newButton)
    // New conversation is the rail's first control, above the navigation, and
    // it names what it creates in the section that is open.
    expect(rail).toContainElement(newButton)
    expect(newButton).toHaveTextContent("newChat")
    const search = screen.getByTestId("channel-list-search")
    expect(
      newButton.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      newButton.compareDocumentPosition(screen.getByTestId("sidebar-nav")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // The search row carries the field, the filter and ⋯ — and nothing else.
    const menu = screen.getByTestId("channel-list-actions-menu")
    expect(rail).toContainElement(screen.getByLabelText("searchAria"))
    expect(search.parentElement).toContainElement(menu)
    expect(search.parentElement).toContainElement(screen.getByTestId("channel-list-filter-trigger"))
    expect(search.parentElement).not.toContainElement(newButton)
    expect(menu).toHaveAccessibleName("listActions")
    expect(screen.queryByLabelText("viewArchived")).toBeNull()

    const user = userEvent.setup()
    await user.click(menu)
    // Archived toggle first, then the display options that were already a menu.
    expect(await screen.findByTestId("channel-list-toggle-view")).toHaveTextContent("viewArchived")
    expect(screen.getByText("displayOptions")).toBeInTheDocument()
  })

  it("creates in the open team when a team section is the one showing", () => {
    selectedGuild = { kind: "team", teamId: "t-1" }
    const teams = [{ id: "t-1", name: "Alpha" }]
    callQueue.length = 0
    for (let i = 0; i < 6; i++) callQueue.push(characters, [], teams)
    const onNewTeamConversation = jest.fn()
    render(
      <TitleBarOutletsProvider>
        <StartOutlet />
        <TitleBarProjectionScope enabled>
          <ChannelList
            sessions={[dmSession]}
            activeSessionId={null}
            onSelect={jest.fn()}
            onNewDirect={jest.fn()}
            onNewTeamConversation={onNewTeamConversation}
            onDelete={jest.fn()}
            onRename={jest.fn()}
          />
        </TitleBarProjectionScope>
      </TitleBarOutletsProvider>
    )
    const newButton = screen.getByTestId("sidebar-new-conversation")
    expect(newButton).toHaveTextContent("newConversation")
    fireEvent.click(newButton)
    expect(onNewTeamConversation).toHaveBeenCalledWith("t-1")
  })

  it("takes the whole row while in use, and offers to take the words global", () => {
    const requests: unknown[] = []
    const onRequest = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener("cognia:command-palette:request", onRequest)
    try {
      renderProjected()
      const search = screen.getByTestId("channel-list-search")
      const input = screen.getByLabelText("searchAria")
      expect(search).not.toHaveAttribute("data-expanded")
      expect(screen.getByTestId("sidebar-new-conversation")).toBeInTheDocument()

      // Focus (what `/` gives it) expands the field; the filter and ⋯ beside
      // it yield. New conversation heads the rail and never moves.
      act(() => input.focus())
      expect(search).toHaveAttribute("data-expanded", "true")
      expect(screen.queryByTestId("channel-list-filter-trigger")).toBeNull()
      expect(screen.queryByTestId("channel-list-actions-menu")).toBeNull()
      expect(screen.getByTestId("sidebar-new-conversation")).toBeInTheDocument()

      // The global-search hatch sits inside the field, and carries the query.
      fireEvent.change(input, { target: { value: "budget" } })
      fireEvent.click(screen.getByTestId("channel-list-global-search"))
      // …and lands on the Chats scope, where those words belong (ADR-0129).
      expect(requests).toEqual([{ query: "budget", scope: "chats" }])
      // ⌘Enter is the keyboard route to the same place.
      fireEvent.keyDown(input, { key: "Enter", metaKey: true })
      expect(requests).toHaveLength(2)

      // Text keeps it expanded even unfocused; Escape clears, a second Escape
      // on the empty field hands the row back.
      act(() => input.blur())
      expect(search).toHaveAttribute("data-expanded", "true")
      act(() => input.focus())
      fireEvent.keyDown(input, { key: "Escape" })
      expect(input).toHaveValue("")
      fireEvent.keyDown(input, { key: "Escape" })
      act(() => input.blur())
      expect(search).not.toHaveAttribute("data-expanded")
      expect(screen.getByTestId("sidebar-new-conversation")).toBeInTheDocument()
    } finally {
      window.removeEventListener("cognia:command-palette:request", onRequest)
    }
  })

  it("says where you are once the archived toggle is behind ⋯, and takes you back", async () => {
    renderProjected()
    expect(screen.queryByTestId("channel-list-archived-chip")).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("channel-list-actions-menu"))
    await user.click(await screen.findByTestId("channel-list-toggle-view"))
    // A chip under the search field names the view and is the way out of it —
    // neither a heading row nor the toggle itself is on screen to do that.
    const chip = await screen.findByTestId("channel-list-archived-chip")
    expect(chip).toHaveTextContent("archivedTitleSuffix")
    expect(chip).toHaveAccessibleName("viewActive")
    await user.click(chip)
    expect(screen.queryByTestId("channel-list-archived-chip")).toBeNull()
  })

  it("reports the rail's rendered width for the bar to size its outlet", () => {
    const rect = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width: 296, height: 800 }) as DOMRect)
    try {
      const { unmount } = renderProjected()
      expect(useShellColumnsStore.getState().widths.sidebar).toBe(296)
      unmount()
      expect(useShellColumnsStore.getState().widths.sidebar).toBe(0)
    } finally {
      rect.mockRestore()
    }
  })
})

describe("drop animation, settle mark and list telemetry", () => {
  const listProps = {
    activeSessionId: null,
    onSelect: jest.fn(),
    onNewDirect: jest.fn(),
    onNewTeamConversation: jest.fn(),
    onDelete: jest.fn(),
    onRename: jest.fn(),
  }
  const rowTitles = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("li[data-density]")).map((li) =>
      li.textContent?.includes("First")
        ? "First"
        : li.textContent?.includes("Second")
          ? "Second"
          : "?"
    )
  const dropSecondOnFirst = () =>
    act(() => {
      mockDragEnd?.({
        active: {
          id: "second",
          data: { current: { type: "session", folderId: null } },
          rect: { current: { initial: null, translated: null } },
        },
        over: { id: "first", data: { current: { type: "session", folderId: null } } },
        activatorEvent: new MouseEvent("pointerdown"),
        collisions: null,
        delta: { x: 0, y: 0 },
      })
    })

  test("a drop reorders the rows in the same tick, marks the moved row, and yields to the store once it carries the order", () => {
    conversationSidebar = { groupBy: "date" }
    callQueue.push(characters, [], undefined)
    const onReorderSessions = jest.fn(() => Promise.resolve())
    const now = Date.now()
    const first = baseSession("first", { title: "First", updatedAt: now })
    const second = baseSession("second", { title: "Second", updatedAt: now - 1 })
    const { container, rerender } = render(
      <ChannelList
        {...listProps}
        sessions={[first, second]}
        onReorderSessions={onReorderSessions}
      />
    )
    expect(rowTitles(container)).toEqual(["First", "Second"])

    dropSecondOnFirst()

    // Projected before the live query has said anything.
    expect(rowTitles(container)).toEqual(["Second", "First"])
    expect(onReorderSessions).toHaveBeenCalledWith(["second", "first"], "date:today")
    // The moved row carries the landing mark, the other one does not.
    const settled = container.querySelector("li[data-settled]")
    expect(settled?.textContent).toContain("Second")
    expect(settled?.querySelector('[data-testid="jump-flash"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="jump-flash"]')).toHaveLength(1)
    expect(listTelemetry.trackConversationReordered).toHaveBeenCalledWith({
      sectionKey: "date:today",
      before: ["first", "second"],
      after: ["second", "first"],
      via: "pointer",
    })

    // The store catches up with the persisted manual order: still the same
    // picture, now backed by the model rather than the projection.
    rerender(
      <ChannelList
        {...listProps}
        sessions={[
          { ...first, manualOrder: 1, manualOrderSection: "date:today" },
          { ...second, manualOrder: 0, manualOrderSection: "date:today" },
        ]}
        onReorderSessions={onReorderSessions}
      />
    )
    expect(rowTitles(container)).toEqual(["Second", "First"])

    // A later, unrelated store change is the model's to show — the projection
    // was released and does not re-apply.
    rerender(
      <ChannelList
        {...listProps}
        sessions={[
          { ...first, manualOrder: 0, manualOrderSection: "date:today" },
          { ...second, manualOrder: 1, manualOrderSection: "date:today" },
        ]}
        onReorderSessions={onReorderSessions}
      />
    )
    expect(rowTitles(container)).toEqual(["First", "Second"])
  })

  test("a keyboard drop is reported as such", () => {
    conversationSidebar = { groupBy: "date" }
    callQueue.push(characters, [], undefined)
    const now = Date.now()
    render(
      <ChannelList
        {...listProps}
        sessions={[
          baseSession("first", { title: "First", updatedAt: now }),
          baseSession("second", { title: "Second", updatedAt: now - 1 }),
        ]}
        onReorderSessions={jest.fn()}
      />
    )
    act(() => {
      mockDragEnd?.({
        active: { id: "second", data: { current: { type: "session", folderId: null } } },
        over: { id: "first", data: { current: { type: "session", folderId: null } } },
        activatorEvent: new KeyboardEvent("keydown", { key: " " }),
      })
    })
    expect(listTelemetry.trackConversationReordered).toHaveBeenCalledWith(
      expect.objectContaining({ via: "keyboard" })
    )
  })

  test("the projection is dropped when the store moves somewhere else", () => {
    conversationSidebar = { groupBy: "date" }
    callQueue.push(characters, [], undefined)
    const now = Date.now()
    const first = baseSession("first", { title: "First", updatedAt: now })
    const second = baseSession("second", { title: "Second", updatedAt: now - 1 })
    const { container, rerender } = render(
      <ChannelList {...listProps} sessions={[first, second]} onReorderSessions={jest.fn()} />
    )
    dropSecondOnFirst()
    expect(rowTitles(container)).toEqual(["Second", "First"])
    // A third conversation lands in the bucket before the write does: the
    // snapshot no longer holds, so the list shows the store's truth.
    rerender(
      <ChannelList
        {...listProps}
        sessions={[first, second, baseSession("third", { title: "Third", updatedAt: now - 2 })]}
        onReorderSessions={jest.fn()}
      />
    )
    expect(rowTitles(container)).toEqual(["First", "Second", "?"])
  })

  test("a rejected persist releases the projection instead of showing an order that never landed", async () => {
    conversationSidebar = { groupBy: "date" }
    callQueue.push(characters, [], undefined)
    const now = Date.now()
    const first = baseSession("first", { title: "First", updatedAt: now })
    const second = baseSession("second", { title: "Second", updatedAt: now - 1 })
    const { container } = render(
      <ChannelList
        {...listProps}
        sessions={[first, second]}
        onReorderSessions={jest.fn(() => Promise.reject(new Error("quota")))}
      />
    )
    dropSecondOnFirst()
    expect(rowTitles(container)).toEqual(["Second", "First"])
    await waitFor(() => expect(rowTitles(container)).toEqual(["First", "Second"]))
    expect(logWarn).toHaveBeenCalledWith(
      "channel-list reorder persist failed",
      expect.objectContaining({ error: expect.stringContaining("quota") })
    )
  })

  test("a pointer-following clone of the dragged row is shown while a drag is active", () => {
    conversationSidebar = { groupBy: "date" }
    callQueue.push(characters, [], undefined)
    const now = Date.now()
    render(
      <ChannelList
        {...listProps}
        sessions={[
          baseSession("first", { title: "First", updatedAt: now }),
          baseSession("second", { title: "Second", updatedAt: now - 1 }),
        ]}
        onReorderSessions={jest.fn()}
      />
    )
    expect(screen.queryByTestId("conversation-drag-overlay")).toBeNull()
    act(() => {
      mockDragStart?.({ active: { id: "second", data: { current: { type: "session" } } } })
    })
    const overlay = screen.getByTestId("conversation-drag-overlay")
    expect(overlay).toHaveTextContent("Second")
    // The clone is a picture: no grip to grab, no landing mark.
    expect(overlay.querySelector('[data-testid="jump-flash"]')).toBeNull()
    act(() => mockDragCancel?.())
    expect(screen.queryByTestId("conversation-drag-overlay")).toBeNull()
  })

  test("opening a conversation is tracked by how it was opened", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    const { container } = render(
      <ChannelList
        {...listProps}
        sessions={[baseSession("s-a", { title: "Alpha", updatedAt: 30 })]}
      />
    )
    await user.click(screen.getByText("Alpha"))
    expect(listTelemetry.trackConversationOpened).toHaveBeenCalledWith("s-a", "click")
    const list = container.querySelector('[tabindex="0"]') as HTMLElement
    list.focus()
    await user.keyboard("{ArrowDown}{Enter}")
    expect(listTelemetry.trackConversationOpened).toHaveBeenCalledWith("s-a", "keyboard")
  })

  test("view switches, section toggles, display options and new chats are tracked", async () => {
    conversationSidebar = { groupBy: "workspace" }
    useProjectStore.setState({
      projects: [
        { id: "w1", name: "Alpha" },
        { id: "w2", name: "Beta" },
      ] as unknown as Project[],
      activeProjectId: "w1",
      loaded: true,
    } as never)
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        {...listProps}
        sessions={[
          baseSession("a", { title: "A", projectId: "w1", updatedAt: 30 }),
          baseSession("b", { title: "B", projectId: "w2", updatedAt: 20 }),
        ]}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "Beta" }))
    expect(listTelemetry.trackConversationSectionToggled).toHaveBeenCalledWith(
      "workspace:w2",
      false
    )
    await user.click(screen.getByRole("button", { name: "viewArchived" }))
    expect(listTelemetry.trackConversationViewChanged).toHaveBeenCalledWith("archived")
    await user.click(screen.getAllByRole("button", { name: "newChat" })[0])
    expect(listTelemetry.trackConversationCreated).toHaveBeenCalledWith("direct")
  })

  test("row and bulk actions are tracked with their size", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    const onArchive = jest.fn()
    const onBulkDelete = jest.fn()
    render(
      <ChannelList
        {...listProps}
        sessions={[
          baseSession("s-a", { title: "Alpha", updatedAt: 30 }),
          baseSession("s-b", { title: "Bravo", updatedAt: 20 }),
        ]}
        onArchive={onArchive}
        onBulkDelete={onBulkDelete}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    await user.click(screen.getByRole("button", { name: "delete" }))
    const dialog = await screen.findByRole("alertdialog")
    const dialogDelete = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "delete"
    )
    if (!dialogDelete) throw new Error("expected destructive button")
    await user.click(dialogDelete)
    expect(onBulkDelete).toHaveBeenCalledWith(["s-a", "s-b"])
    expect(listTelemetry.trackConversationRowAction).toHaveBeenCalledWith("delete", 2)
  })

  test("a settled search is reported once per query, by length only", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        {...listProps}
        sessions={[
          baseSession("s-a", { title: "Alpha", updatedAt: 30 }),
          baseSession("s-b", { title: "Bravo", updatedAt: 20 }),
        ]}
      />
    )
    await user.type(screen.getByRole("searchbox"), "Al")
    await waitFor(() =>
      expect(listTelemetry.trackConversationSearched).toHaveBeenCalledWith({
        scope: "title",
        query: "Al",
        resultCount: 1,
        truncated: false,
      })
    )
    expect(listTelemetry.trackConversationSearched).toHaveBeenCalledTimes(1)
  })
})
