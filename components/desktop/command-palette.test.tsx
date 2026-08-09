/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, ChatSession, Team } from "@cognia/agent-config-types"

const logInfo = jest.fn()
const logError = jest.fn()
const toastSuccess = jest.fn()
const toastInfo = jest.fn()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: (...args: unknown[]) => logError(...args),
    },
    agent: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    },
  },
  // Pulled in transitively by @/lib/plugin → hooks-system → core/logger.
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
}))

// Stub the plugin event surface so the new dispatchShortcut wiring doesn't
// drag the real plugin store (and its Tauri bindings) into this test.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: jest.fn().mockResolvedValue(false),
    dispatchProjectSwitch: jest.fn().mockResolvedValue(false),
  }),
}))

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: jest.fn(),
  },
}))

const select = jest.fn()
const create = jest.fn(async () => ({ id: "new-s", title: "" }))
const sessionsRef: { current: ChatSession[] } = { current: [] }
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({
    sessions: sessionsRef.current,
    select,
    create,
  }),
}))

const historySearchRef = {
  current: {
    results: [] as Array<Record<string, unknown>>,
    moreOlderHistory: false,
    indexIncomplete: false,
    loading: false,
    error: null as Error | null,
  },
}
jest.mock("@/hooks/chat/use-chat-history-search", () => ({
  useChatHistorySearch: () => historySearchRef.current,
}))

const jumpToSessionMessage = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...args: unknown[]) => jumpToSessionMessage(...args),
}))

const messagesRef: { current: unknown[] } = { current: [] }
const setSelectedGuild = jest.fn()
const replaceMessages = jest.fn()
const activeSessionIdRef: { current: string | null } = { current: null }

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(selector: (s: { messages: unknown[] }) => T): T =>
      selector({ messages: messagesRef.current }),
    {
      getState: () => ({
        activeSessionId: activeSessionIdRef.current,
        replaceMessages,
      }),
    }
  ),
}))

const settingsRef: { current: { apiKey?: string } | null } = { current: { apiKey: "k" } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { apiKey?: string } | null }) => T): T =>
    selector({ settings: settingsRef.current }),
}))

jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { setSelectedGuild: typeof setSelectedGuild }) => T): T =>
    selector({ setSelectedGuild }),
}))

const charactersRef: { current: Character[] } = { current: [] }
const teamsRef: { current: Team[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(query: () => Promise<T> | T, _d: unknown[], _i: T): T => {
    const src = query.toString()
    if (src.includes("listCharacters")) return charactersRef.current as unknown as T
    if (src.includes("listTeams")) return teamsRef.current as unknown as T
    return _i
  },
}))

const setTheme = jest.fn()
let theme: string | undefined = "light"
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme, setTheme }),
}))

jest.mock("@/components/ai-elements/conversation", () => ({
  messagesToMarkdown: () => "# md",
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

let platformValue: "tauri" | "mobile" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

import { CommandPalette } from "./command-palette"
import {
  publishActiveContextPanels,
  resetActiveContextForTesting,
  setActiveContextForHost,
} from "@/lib/context-workbench/active-context"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

beforeEach(() => {
  logInfo.mockReset()
  logError.mockReset()
  toastInfo.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  select.mockReset()
  create.mockReset().mockResolvedValue({ id: "new-s", title: "" })
  setSelectedGuild.mockReset()
  setTheme.mockReset()
  replaceMessages.mockReset()
  sessionsRef.current = []
  historySearchRef.current = {
    results: [],
    moreOlderHistory: false,
    indexIncomplete: false,
    loading: false,
    error: null,
  }
  jumpToSessionMessage.mockReset().mockResolvedValue(true)
  messagesRef.current = []
  activeSessionIdRef.current = null
  settingsRef.current = { apiKey: "k" }
  charactersRef.current = []
  teamsRef.current = []
  theme = "light"
  routerPush.mockReset()
  platformValue = "tauri"
  resetActiveContextForTesting()
})

function queueChars(c: Character[], t: Team[]) {
  charactersRef.current = c
  teamsRef.current = t
}

import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"

async function openWithShortcut() {
  const user = userEvent.setup()
  await user.keyboard("{Control>}k{/Control}")
  return user
}

test("opens via Cmd/Ctrl+K and renders the action list", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  // CommandDialog keeps the title in the DOM for a11y; the action list only
  // appears once the dialog is opened.
  expect(screen.queryByText("actions.newChat")).toBeNull()
  await openWithShortcut()
  await waitFor(() => expect(screen.getByText("actions.newChat")).toBeInTheDocument())
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette toggle",
    expect.objectContaining({ next: true, source: "shortcut" })
  )
})

test("New chat action calls create() and closes the palette", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.newChat"))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(logInfo).toHaveBeenCalledWith("command-palette new-chat")
})

test("Toggle theme switches between light and dark and logs", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.toggleTheme"))
  expect(setTheme).toHaveBeenCalledWith("dark")
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette toggle-theme",
    expect.objectContaining({ from: "light", to: "dark" })
  )
})

test("Open settings actions invoke onOpenSettings with the right tab", async () => {
  queueChars([], [])
  const onOpen = jest.fn()
  render(<CommandPalette onOpenSettings={onOpen} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.manageApiKey"))
  expect(onOpen).toHaveBeenCalledWith("api-key")
  expect(logInfo).toHaveBeenCalledWith(
    "command-palette open-settings",
    expect.objectContaining({ tab: "api-key" })
  )
})

test("Export with no messages toasts the empty-state info", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.exportMd"))
  expect(toastInfo).toHaveBeenCalledWith("toasts.nothingToExport")
})

test("Switch to team selects that team's guild", async () => {
  const team: Team = {
    id: "t-1",
    name: "Squad",
    members: [],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Team
  queueChars([], [team])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("Squad"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
})

test("Check updates outside Tauri toasts a desktop-only info", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.checkUpdates"))
  await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("toasts.updatesDesktopOnly"))
})

test("Switch workspace activates that project", async () => {
  queueChars([], [])
  const { useProjectStore } = await import("@/stores/project/project-store")
  act(() => {
    useProjectStore.setState({
      projects: [
        {
          id: "ws-1",
          name: "Backend",
          roots: [{ id: "r", path: "/srv", isPrimary: true }],
        } as never,
      ],
      activeProjectId: null,
      loaded: false,
    })
  })
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("Backend"))
  expect(useProjectStore.getState().activeProjectId).toBe("ws-1")
})

test("Open folder outside Tauri toasts a desktop-only info", async () => {
  queueChars([], [])
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.click(screen.getByText("actions.openFolder"))
  await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("toasts.openFolderDesktopOnly"))
})

test("Cleanup removes the keydown listener on unmount", () => {
  const removeSpy = jest.spyOn(window, "removeEventListener")
  queueChars([], [])
  const { unmount } = render(<CommandPalette onOpenSettings={jest.fn()} />)
  unmount()
  expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function))
  removeSpy.mockRestore()
})

test("searches message history and jumps to the selected message hit", async () => {
  sessionsRef.current = [
    {
      id: "s-search",
      title: "Other title",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession,
  ]
  historySearchRef.current = {
    ...historySearchRef.current,
    results: [
      {
        messageId: "m-search",
        sessionId: "s-search",
        sessionTitle: "Planning",
        projectId: "p1",
        role: "user",
        createdAt: 1,
        count: 1,
        at: 0,
        snippet: { text: "needle in the plan", positions: [0, 1, 2, 3, 4, 5] },
        score: 1,
        archived: false,
        otherBranchCount: 0,
      },
    ],
  }

  render(<CommandPalette onOpenSettings={jest.fn()} />)
  const user = await openWithShortcut()
  await user.type(screen.getByPlaceholderText("placeholder"), "needle")
  await user.click(await screen.findByText("Planning"))

  expect(select).toHaveBeenCalledWith("s-search")
  expect(jumpToSessionMessage).toHaveBeenCalledWith("s-search", "m-search", {
    align: "center",
  })
})

// React 19 doesn't expose `act` directly from imports for our use, but we keep
// this here in case the rule changes.
void act

describe("navigation", () => {
  test("lists every rail destination and routes to it", async () => {
    queueChars([], [])
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()

    // The whole catalog, not just the pinned three — the palette is the
    // fallback route to anything the user took off the rail.
    for (const meta of SIDEBAR_NAV_META) {
      expect(screen.getByText(meta.i18nKey)).toBeInTheDocument()
    }

    const user = userEvent.setup()
    await user.click(screen.getByText("workflows"))
    expect(routerPush).toHaveBeenCalledWith("/workflows")
    expect(logInfo).toHaveBeenCalledWith("command-palette navigate", { route: "/workflows" })
  })

  test("drops desktop-only destinations off the desktop shell", async () => {
    platformValue = "web"
    queueChars([], [])
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()
    // `browser` is desktopOnly — listing it in a browser is a dead end.
    expect(screen.queryByText("browser")).not.toBeInTheDocument()
    expect(screen.getByText("workflows")).toBeInTheDocument()
  })

  test("switches to the DM and Canvas guilds and returns home", async () => {
    queueChars([], [])
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()
    const user = userEvent.setup()
    await user.click(screen.getByText("directMessages"))
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    expect(routerPush).toHaveBeenCalledWith("/")
  })
})

describe("workbench panels", () => {
  const SCOPE = "dock::session:s-1"
  const mountWorkbench = () => {
    setActiveContextForHost(SCOPE, {
      kind: "session",
      id: "s-1",
      title: "S",
      capabilities: [],
    } as never)
    publishActiveContextPanels(SCOPE, [
      { id: "artifacts", activity: "review", labelKey: "artifacts.dock.artifacts" },
      { id: "workspace", activity: "workspace", labelKey: "artifacts.dock.workspace" },
    ])
  }

  test("omits the group entirely when no workbench is mounted", async () => {
    queueChars([], [])
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()
    expect(screen.queryByText("desktop.commandPalette.groups.workbenchPanels")).toBeNull()
  })

  test("lists the mounted workbench's panels and reveals the chosen one", async () => {
    queueChars([], [])
    act(() => mountWorkbench())
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()

    expect(screen.getByText("artifacts.dock.workspace")).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByText("artifacts.dock.workspace"))
    expect(logInfo).toHaveBeenCalledWith("command-palette reveal-panel", { panelId: "workspace" })
    // Reaching a panel is the point — assert it actually landed in front.
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.activePanelId).toBe("workspace")
  })
})

test("labels a plugin panel from its own namespace, falling back to its literal", async () => {
  // Plugin panels namespace their label key. The mocked `useTranslations` has no
  // `has()`, which is exactly the "no translation shipped" case — the panel's
  // own `label` is the fallback, and its raw key the last resort.
  queueChars([], [])
  const SCOPE = "dock::session:s-2"
  act(() => {
    setActiveContextForHost(SCOPE, {
      kind: "session",
      id: "s-2",
      title: "S",
      capabilities: [],
    } as never)
    publishActiveContextPanels(SCOPE, [
      {
        id: "acme:board",
        activity: "templates",
        labelKey: "board",
        label: "Acme board",
        pluginId: "acme",
      },
      { id: "acme:bare", activity: "review", labelKey: "bare", pluginId: "acme" },
    ])
  })
  render(<CommandPalette onOpenSettings={jest.fn()} />)
  await openWithShortcut()
  expect(screen.getByText("Acme board")).toBeInTheDocument()
  expect(screen.getByText("bare")).toBeInTheDocument()
})

describe("the Record Skill entry", () => {
  beforeEach(() => {
    __resetRecorderAvailabilityForTesting()
    useRecorderStore.getState().reset()
  })

  it("is absent until the owning plugin publishes", async () => {
    // Gated on the plugin rather than on `isTauri()` — disabling the Skill
    // Recorder has to withdraw every entry point at once.
    queueChars([], [])
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    await openWithShortcut()
    await waitFor(() => expect(screen.getByText("actions.newChat")).toBeInTheDocument())
    expect(screen.queryByText("entry.paletteLabel")).not.toBeInTheDocument()
  })

  it("opens the global recorder and closes the palette behind it", async () => {
    queueChars([], [])
    act(() => {
      setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    })
    render(<CommandPalette onOpenSettings={jest.fn()} />)
    const user = await openWithShortcut()
    const item = await screen.findByText("entry.paletteLabel")
    await user.click(item)

    expect(useRecorderStore.getState().sheetOpen).toBe(true)
    expect(useRecorderStore.getState().phase).toBe("setup")
    await waitFor(() => expect(screen.queryByText("actions.newChat")).not.toBeInTheDocument())
  })
})
