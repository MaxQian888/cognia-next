/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, ChatSession, Team } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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

const callQueue: Array<unknown> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_q: () => Promise<T> | T, _d: unknown[], _i: T): T =>
    (callQueue.shift() ?? _i) as unknown as T,
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
let sidebarCollapsed = false
const setGroupCollapsed = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: Record<string, unknown>) => T): T =>
    selector({
      selectedGuild,
      channelListView: "active",
      setChannelListView: () => {},
      collapsedFolderIds: [],
      setCollapsedFolders: () => {},
      groupCollapseOverrides: {},
      setGroupCollapsed,
      sidebarWidth: 256,
      setSidebarWidth: () => {},
      sidebarCollapsed,
    }),
  SIDEBAR_WIDTH_DEFAULT: 256,
  SIDEBAR_WIDTH_MIN: 220,
  SIDEBAR_WIDTH_MAX: 420,
}))

// Behavior settings default to today's behavior (comfortable, date grouping on,
// unread badges on, title-only search) so existing assertions hold. Individual
// tests can override `conversationSidebar` to exercise the settings-driven paths.
let conversationSidebar: Record<string, unknown> | null = null
const saveSettings = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: typeof saveSettings }) => T): T =>
    selector({
      settings: conversationSidebar ? { conversationSidebar } : null,
      save: saveSettings,
    }),
}))

const searchSessionsByContent = jest.fn()
jest.mock("@/lib/db/messages", () => ({
  searchSessionsByContent: (...args: unknown[]) => searchSessionsByContent(...args),
}))

let isNarrow = false
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui") as Record<string, unknown>
  return {
    ...actual,
    useIsNarrow: () => isNarrow,
  }
})

import { ChannelList } from "./channel-list"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

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
  callQueue.length = 0
  selectedGuild = { kind: "dm" }
  isNarrow = false
  sidebarCollapsed = false
  conversationSidebar = null
  setGroupCollapsed.mockReset()
  saveSettings.mockReset()
  saveSettings.mockResolvedValue(undefined)
  searchSessionsByContent.mockReset()
  searchSessionsByContent.mockResolvedValue({ ids: new Set<string>(), truncated: false })
})

test("DM guild renders only direct sessions, grouped into date buckets", () => {
  // The rail's DM/Team split is the `"team"` grouping mode; the default
  // (`"workspace"`) deliberately stops filtering by guild.
  conversationSidebar = { groupBy: "team" }
  // queries: characters, sessionStates (none), team (none)
  callQueue.push(characters, [], undefined)
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
  expect(rail).toHaveAttribute("data-slot", "sidebar-inner")
  expect(container.querySelector("[data-tonality='translucent']")).toBeInTheDocument()
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
  expect(screen.getByText("Trip budget")).toBeInTheDocument()
  expect(screen.queryByText("bucketOlder")).toBeNull()
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
  expect(screen.getByText("/")).toBeInTheDocument()
  expect(await screen.findByText("Hi Alice")).toBeInTheDocument()
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
  callQueue.push(characters, [], team)
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
  expect(screen.getByText("Squad")).toBeInTheDocument()
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

test("New chat button on DM guild calls onNewDirect", async () => {
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
  await user.click(screen.getByLabelText("newChat"))
  expect(onNewDirect).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("channel-list new-direct")
})

test("New conversation button on team guild routes to onNewTeamConversation with teamId", async () => {
  selectedGuild = { kind: "team", teamId: "t-1" }
  callQueue.push(characters, [], team)
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
  await user.click(screen.getByLabelText("newConversation"))
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
  await user.click(screen.getByRole("button", { name: "Work" }))
  expect(screen.queryByText("Inside work")).toBeNull()
})

test("New folder button invokes onCreateFolder", async () => {
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
  await user.click(screen.getByRole("button", { name: "newFolder" }))
  expect(onCreateFolder).toHaveBeenCalledWith("newFolderName")
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

  test("content-scope search surfaces sessions matched only by message body", async () => {
    conversationSidebar = { searchScope: "titleAndContent" }
    searchSessionsByContent.mockResolvedValue({ ids: new Set(["s-b"]), truncated: false })
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
    await waitFor(() => expect(searchSessionsByContent).toHaveBeenCalled())
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
