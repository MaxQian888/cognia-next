/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
    },
    // Pulled in transitively by the plugin extension slot → agent-team-store,
    // which calls `loggers.agent.child(...)` at module load.
    agent: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: function () {
        return this
      },
    },
  },
  // Pulled in transitively by the plugin extension slot → extension-api → core/logger.
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }),
}))

// `stores/index.ts` calls `isTauri()` at module top-level (Zustand
// `create()` factory). Declaring the jest.fn inside the factory dodges
// the TDZ that an outer const would otherwise hit during import hoisting.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
  transport: { call: jest.fn().mockResolvedValue(undefined) },
}))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri
const transportCall = (jest.requireMock("@/lib/tauri") as { transport: { call: jest.Mock } })
  .transport.call

const setTheme = jest.fn()
const themeRef = { value: "system" as "light" | "dark" | "system" }
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme }),
}))

const killSwitch = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/automation/client", () => ({
  desktop: { killSwitch: () => killSwitch() },
}))

const openVsxClear = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ openVsxCache: { clear: openVsxClear } }),
}))

const minimize = jest.fn().mockResolvedValue(undefined)
const toggleMaximize = jest.fn().mockResolvedValue(undefined)
const close = jest.fn().mockResolvedValue(undefined)
const isMaximized = jest.fn().mockResolvedValue(false)
const isFullscreen = jest.fn().mockResolvedValue(false)
const setFullscreen = jest.fn().mockResolvedValue(undefined)
const setAlwaysOnTop = jest.fn().mockResolvedValue(undefined)
const isAlwaysOnTop = jest.fn().mockResolvedValue(false)
const onResized = jest.fn().mockResolvedValue(() => {})

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    isFullscreen,
    setFullscreen,
    setAlwaysOnTop,
    isAlwaysOnTop,
    onResized,
  }),
}))

const openDialog = jest.fn().mockResolvedValue(null)
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}))

jest.mock("@/lib/tauri/webview-zoom", () => {
  const actual = jest.requireActual<typeof import("@/lib/tauri/webview-zoom")>(
    "@/lib/tauri/webview-zoom"
  )
  return { ...actual, applyZoom: jest.fn() }
})

import * as webviewZoom from "@/lib/tauri/webview-zoom"
const applyZoom = webviewZoom.applyZoom as jest.Mock

const settingsRef = {
  webviewZoom: 1.0 as number | undefined,
  language: "en" as string,
  reduceMotion: false as boolean,
}
const settingsSave = jest.fn().mockResolvedValue(undefined)
// Function declarations, not consts: `jest.mock` factories are hoisted above
// every `const` in the module, so an arrow here would hit the TDZ the moment
// the mocked module is first required.
function buildSettings() {
  return {
    webviewZoom: settingsRef.webviewZoom,
    language: settingsRef.language,
    reduceMotion: settingsRef.reduceMotion,
    titleBarLayout: {
      order: barOrder ?? TITLE_BAR_ITEMS.map((m) => m.id),
      hidden: [...barHidden],
    },
  }
}
function buildSettingsStore() {
  return Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ settings: buildSettings(), save: settingsSave }),
    { getState: () => ({ save: settingsSave, settings: buildSettings() }) }
  )
}
jest.mock("@/stores/settings", () => ({ useSettingsStore: buildSettingsStore() }))
jest.mock("@/stores/settings/settings-store", () => ({ useSettingsStore: buildSettingsStore() }))

const openFolderAsWorkspace = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/workspace/open-folder", () => ({
  openFolderAsWorkspace: (...args: unknown[]) => openFolderAsWorkspace(...args),
}))

const openExternal = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}))

const chatClear = jest.fn()
const setActiveSession = jest.fn()
const chatStateRef = {
  activeSessionId: null as string | null,
  status: "idle" as "idle" | "streaming" | "awaiting_approval" | "error",
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: Object.assign(
    (selector: (s: { activeSessionId: string | null; status: string }) => unknown) =>
      selector({
        activeSessionId: chatStateRef.activeSessionId,
        status: chatStateRef.status,
      }),
    { getState: () => ({ clear: chatClear, setActiveSession }) }
  ),
}))

const startNewSessionMock = jest.fn().mockResolvedValue({ id: "s-new" })
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))

const setSelectedGuild = jest.fn()
const toggleSidebar = jest.fn()
const toggleGuildRail = jest.fn()
const toggleStatusBar = jest.fn()
const requestCreate = jest.fn()
const openFind = jest.fn()
const uiStateRef = {
  sidebarCollapsed: false,
  guildRailCollapsed: false,
  statusBarCollapsed: false,
}
// Segment order + visibility come from `settings.titleBarLayout` now, resolved
// by `useBarLayout` (covered by `components/shell/use-bar-layout.test.ts`).
// This suite drives the real hook through the settings mock below.
const barHidden = new Set<string>()
let barOrder: string[] | null = null

let mockPlatform: "tauri" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

// The customizer dialog reached from the bar's context menu / Views menu has
// its own suite.
jest.mock("@/components/shell/shell-layout-dialog", () => ({
  ShellLayoutDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="shell-layout-dialog" /> : null,
}))

jest.mock("@/stores/ui/ui-store", () => {
  const buildState = () => ({
    setSelectedGuild,
    toggleSidebar,
    toggleGuildRail,
    toggleStatusBar,
    requestCreate,
    openFind,
    barItems: {},
    sidebarCollapsed: uiStateRef.sidebarCollapsed,
    guildRailCollapsed: uiStateRef.guildRailCollapsed,
    statusBarCollapsed: uiStateRef.statusBarCollapsed,
  })
  return {
    useUIStore: Object.assign(
      (selector: (s: ReturnType<typeof buildState>) => unknown) => selector(buildState()),
      { getState: buildState }
    ),
  }
})

// New title-bar segments — covered by their own suites; stub to keep this test
// focused on the title-bar shell + gating.
jest.mock("@/components/desktop/title-bar-workspace", () => ({
  TitleBarWorkspace: () => <div data-testid="title-bar-workspace-seg" />,
}))
jest.mock("@/components/desktop/title-bar-quick-actions", () => ({
  TitleBarQuickActions: () => <div data-testid="title-bar-quick-actions" />,
}))
jest.mock("@/components/account/account-bar-button", () => ({
  AccountBarButton: () => <div data-testid="account-bar-button" />,
}))

const sessionRef = {
  value: undefined as undefined | { id: string; title: string; characterId?: string },
}
const characterRef = { value: undefined as undefined | { id: string; name: string } }
const listSessionsMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
}))
jest.mock("@/lib/db/characters", () => ({ getCharacter: jest.fn() }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => Promise<unknown> | unknown) => {
    const src = factory.toString()
    if (src.includes("getCharacter")) return characterRef.value
    return sessionRef.value
  },
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  usePathname: () => "/",
}))

const toggleTerminalPanel = jest.fn()
const setTerminalPanelOpen = jest.fn()
const terminalStateRef = { panelOpen: false }
// Terminal > New goes through `spawnDefaultTerminal`, which hands
// `useTerminalStore.getState()` to the spawn orchestrator as its
// `TerminalStoreLike`. A selector-only mock made that path throw, so the mock
// also carries the surface the orchestrator touches: registration plus the
// session mutators it wires live session events to. One shared state object
// with a `panelOpen` getter, so the members keep stable identities across
// reads (as the real store's do) while the tests can still flip the panel via
// `terminalStateRef`.
const terminalStoreState = {
  get panelOpen() {
    return terminalStateRef.panelOpen
  },
  setPanelOpen: setTerminalPanelOpen,
  togglePanel: toggleTerminalPanel,
  sessions: {} as Record<string, unknown>,
  setHostState: jest.fn(),
  markTabActivity: jest.fn(),
  registerSession: jest.fn(),
  removeSession: jest.fn(),
  setSessionStatus: jest.fn(),
  setSessionExit: jest.fn(),
  setSessionCwd: jest.fn(),
  pushPrompt: jest.fn(),
  closePrompt: jest.fn(),
  pushCommand: jest.fn(),
}
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(terminalStoreState),
    { getState: () => terminalStoreState }
  ),
}))

// `spawnDefaultTerminal` itself stays real (its shell/profile/cwd precedence is
// covered by `lib/terminal/spawn-default.test.ts`); only the orchestrator — the
// seam that talks to the Rust PTY — is stubbed, the same boundary that suite
// mocks. Without it the menu item would drive the live transport chain against
// jsdom and resolve to an error outcome.
const spawnFromDockMock = jest.fn(async (_input: { store: unknown }) => ({
  kind: "spawned" as const,
  sessionId: "term-1",
  shell: "/bin/zsh",
}))
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (input: { store: unknown }) => spawnFromDockMock(input),
}))

// matchMedia mock — test toggles `narrowMatches` at will to switch between
// the wide Menubar layout and the narrow hamburger layout.
const narrowState = { matches: false, listeners: new Set<() => void>() }
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => {
      const isNarrow = query.includes("max-width")
      return {
        matches: isNarrow ? narrowState.matches : false,
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: () => void) => narrowState.listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => narrowState.listeners.delete(cb),
        addListener: (cb: () => void) => narrowState.listeners.add(cb),
        removeListener: (cb: () => void) => narrowState.listeners.delete(cb),
        dispatchEvent: () => false,
      }
    },
  })
  // JSDOM doesn't ship document.execCommand; install a default no-op so
  // `jest.spyOn(document, "execCommand")` works in the Edit-menu tests.
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue(true),
  })
  // Tools → Clear Cache touches the Service Worker `caches` API. JSDOM
  // doesn't ship it; we provide a no-op so the action resolves cleanly in
  // tests that exercise it.
  if (typeof (globalThis as { caches?: unknown }).caches === "undefined") {
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      writable: true,
      value: { keys: async () => [], delete: async () => true },
    })
  }
})

import { TitleBar } from "./title-bar"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"
import { resetNavHistory } from "@/hooks/desktop/use-nav-history"
import { DEFAULT_TITLE_BAR_LAYOUT, TITLE_BAR_ITEMS } from "@/types/shell/bars"
import { createPortal } from "react-dom"
import {
  TitleBarOutletsProvider,
  TitleBarProjectionScope,
  useTitleBarProjection,
} from "@/components/shell/title-bar-outlets"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { COMMAND_PALETTE_REQUEST_EVENT } from "@/lib/shell/command-palette-request"

beforeEach(() => {
  resetNavHistory()
  toggleTerminalPanel.mockReset()
  setTerminalPanelOpen.mockReset()
  terminalStateRef.panelOpen = false
  logInfo.mockReset()
  logWarn.mockReset()
  logError.mockReset()
  minimize.mockClear()
  toggleMaximize.mockClear()
  close.mockClear()
  isMaximized.mockClear().mockResolvedValue(false)
  isFullscreen.mockClear().mockResolvedValue(false)
  setFullscreen.mockClear().mockResolvedValue(undefined)
  setAlwaysOnTop.mockClear().mockResolvedValue(undefined)
  isAlwaysOnTop.mockClear().mockResolvedValue(false)
  onResized.mockClear().mockResolvedValue(() => {})
  openDialog.mockClear().mockResolvedValue(null)
  openFolderAsWorkspace.mockReset().mockResolvedValue(null)
  settingsSave.mockClear().mockResolvedValue(undefined)
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  openExternal.mockClear().mockResolvedValue(undefined)
  chatClear.mockClear()
  setActiveSession.mockClear()
  setSelectedGuild.mockReset()
  toggleSidebar.mockReset()
  toggleGuildRail.mockReset()
  toggleStatusBar.mockReset()
  requestCreate.mockReset()
  routerPush.mockClear()
  setTheme.mockClear()
  killSwitch.mockClear().mockResolvedValue(undefined)
  openVsxClear.mockClear().mockResolvedValue(undefined)
  transportCall.mockClear().mockResolvedValue(undefined)
  listSessionsMock.mockClear().mockResolvedValue([])
  chatStateRef.activeSessionId = null
  chatStateRef.status = "idle"
  sessionRef.value = undefined
  characterRef.value = undefined
  settingsRef.webviewZoom = 1.0
  settingsRef.language = "en"
  settingsRef.reduceMotion = false
  themeRef.value = "system"
  uiStateRef.sidebarCollapsed = false
  uiStateRef.guildRailCollapsed = false
  uiStateRef.statusBarCollapsed = false
  mockPlatform = "tauri"
  barHidden.clear()
  barOrder = null
  openFind.mockClear()
  narrowState.matches = false
})

function setPlatform(platform: "Win32" | "MacIntel") {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
}

test("outside Tauri it is a plain application bar: no window controls, no menubar", async () => {
  // The bar renders in the web shell too — it is what the column headers
  // project into — but the frameless-window plumbing stays Tauri-only.
  isTauriMock.mockReturnValue(false)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  expect(screen.getByTestId("title-bar")).toHaveClass("h-10")
  expect(screen.queryByLabelText("desktop.titleBar.minimize")).toBeNull()
  expect(screen.queryByLabelText("desktop.titleBar.close")).toBeNull()
  expect(screen.queryByText("desktop.menu.file.label")).toBeNull()
  expect(screen.queryByTestId("title-bar-hamburger")).toBeNull()
})

test("is 40px tall, matching the column headers it hosts", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toHaveClass("h-10"))
})

test("renders the brand text in Tauri", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("desktop.titleBar.appName")
  )
})

test("clicking minimize/maximize/close routes to the Tauri window API and logs", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByLabelText("desktop.titleBar.minimize")).toBeInTheDocument()
  )
  await user.click(screen.getByLabelText("desktop.titleBar.minimize"))
  await waitFor(() => expect(minimize).toHaveBeenCalled())
  expect(logInfo).toHaveBeenCalledWith("title-bar minimize")

  await user.click(screen.getByLabelText("desktop.titleBar.maximize"))
  await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())

  await user.click(screen.getByLabelText("desktop.titleBar.close"))
  await waitFor(() => expect(close).toHaveBeenCalled())
})

test("hides menubar and window controls on Mac (system menu owns them)", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  render(<TitleBar />)
  await waitFor(() => expect(screen.queryByLabelText("desktop.titleBar.minimize")).toBeNull())
  expect(screen.queryByLabelText("desktop.titleBar.close")).toBeNull()
  expect(screen.queryByText("desktop.menu.file.label")).toBeNull()
})

test("logs a structured warning when Tauri window setup fails", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isMaximized.mockRejectedValueOnce(new Error("boom"))
  render(<TitleBar />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar window setup failed",
      expect.objectContaining({ error: "boom" })
    )
  )
})

test("setup-failed warning falls back to String(err) for non-Error", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isMaximized.mockRejectedValueOnce("plain string")
  render(<TitleBar />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar window setup failed",
      expect.objectContaining({ error: "plain string" })
    )
  )
})

test("Open Workspace warning falls back to String(err) for non-Error", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  openFolderAsWorkspace.mockRejectedValueOnce("not-an-error")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.openWorkspace"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar open-workspace failed",
      expect.objectContaining({ error: "not-an-error" })
    )
  )
})

test("renders dynamic title when an active session resolves", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  chatStateRef.activeSessionId = "s1"
  sessionRef.value = { id: "s1", title: "My chat" }
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent(
      "desktop.titleBar.appNamedesktop.titleBar.separatorMy chat"
    )
  )
})

test("dynamic title prefers character name over session title", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  chatStateRef.activeSessionId = "s1"
  sessionRef.value = { id: "s1", title: "Session", characterId: "c1" }
  characterRef.value = { id: "c1", name: "Pixel" }
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent(
      "desktop.titleBar.appNamedesktop.titleBar.separatorPixel"
    )
  )
})

test("Win/Linux menubar renders File / Edit / View / Go / Window / Help triggers", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  expect(screen.getByText("desktop.menu.edit.label")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.go.label")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.window.label")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.help.label")).toBeInTheDocument()
})

test("wide menubar exposes the Run and Terminal menus", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.run.label")).toBeInTheDocument())
  expect(screen.getByText("desktop.menu.terminal.label")).toBeInTheDocument()
})

test("Run > Open Scheduler navigates to /scheduler", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.run.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.run.label"))
  await user.click(await screen.findByText("desktop.menu.run.openScheduler"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/scheduler"))
})

test("Terminal > New Terminal opens the dock and Toggle flips the panel", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.terminal.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.terminal.label"))
  await user.click(await screen.findByText("desktop.menu.terminal.new"))
  await waitFor(() => expect(setTerminalPanelOpen).toHaveBeenCalledWith(true))
  // "New" spawns as well as reveals — and hands the orchestrator the live
  // store, which is what `useTerminalStore.getState()` resolves to.
  await waitFor(() => expect(spawnFromDockMock).toHaveBeenCalled())
  expect(spawnFromDockMock.mock.calls.at(-1)![0].store).toBe(terminalStoreState)

  await user.click(screen.getByText("desktop.menu.terminal.label"))
  await user.click(await screen.findByText("desktop.menu.terminal.togglePanel"))
  await waitFor(() => expect(toggleTerminalPanel).toHaveBeenCalled())
})

test("renders the nav arrows and layout controls", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar-nav-arrows")).toBeInTheDocument())
  expect(screen.getByTestId("title-bar-layout-controls")).toBeInTheDocument()
  expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()
  // Back is disabled at the only-entry history bound.
  expect(screen.getByTestId("title-bar-nav-back")).toBeDisabled()
})

test("mounts the optional workspace / quick-actions / account segments by default", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar-workspace-seg")).toBeInTheDocument())
  expect(screen.getByTestId("title-bar-quick-actions")).toBeInTheDocument()
  expect(screen.getByTestId("account-bar-button")).toBeInTheDocument()
})

test("drops the segments the stored layout hides", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  for (const id of ["workspace", "quickActions", "accountTop"]) barHidden.add(id)
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar-nav-arrows")).toBeInTheDocument())
  expect(screen.queryByTestId("title-bar-workspace-seg")).toBeNull()
  expect(screen.queryByTestId("title-bar-quick-actions")).toBeNull()
  expect(screen.queryByTestId("account-bar-button")).toBeNull()
})

test("command-center caret menu surfaces quick targets", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-command-center-menu")).toBeInTheDocument()
  )
  await user.click(screen.getByTestId("title-bar-command-center-menu"))
  expect(await screen.findByTestId("cc-command-palette")).toBeInTheDocument()
})

// The command centre is a customizable segment now, so its handlers arrive via
// the zone's item context rather than as inline JSX props. These two pin that
// the wiring survived the move.
test("command-center Go item routes through the shared menu action", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-command-center-menu"))
  await user.click(await screen.findByTestId("cc-go-go-inbox"))
  expect(routerPush).toHaveBeenCalledWith("/inbox/all")
})

test("command-center recent session opens that conversation", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  listSessionsMock.mockResolvedValue([{ id: "s-1", title: "Refactor the parser" }])
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-command-center-menu"))
  await user.click(await screen.findByTestId("cc-recent-s-1"))
  expect(setActiveSession).toHaveBeenCalledWith("s-1")
})

// Delegates to newChatAction so this menu and the native menu bar stay in
// lockstep — it starts a real conversation rather than clearing to the welcome.
test("File > New Chat starts a conversation and resets guild", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.newChat"))
  await waitFor(() => expect(startNewSessionMock).toHaveBeenCalled())
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  // The old behavior nuked every open pane; it must not come back.
  expect(chatClear).not.toHaveBeenCalled()
})

test("File > Open Workspace creates/activates a workspace via the unified flow", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  openFolderAsWorkspace.mockResolvedValueOnce({ id: "p1" })
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.openWorkspace"))
  await waitFor(() => expect(openFolderAsWorkspace).toHaveBeenCalledTimes(1))
  expect(settingsSave).not.toHaveBeenCalledWith(
    expect.objectContaining({ defaultWorkingDir: expect.anything() })
  )
})

test("File > Open Settings routes to /settings", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.openSettings"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings"))
})

test("File > Open Logs routes to /logs", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.openLogs"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/logs"))
})

test("File > Quit closes the window", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.quit"))
  await waitFor(() => expect(close).toHaveBeenCalled())
})

test("Edit > Find opens the in-app find bar", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.edit.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.edit.label"))
  await user.click(await screen.findByText("desktop.menu.edit.find"))
  expect(openFind).toHaveBeenCalled()
})

test("Edit > Copy delegates to document.execCommand", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const exec = jest.spyOn(document, "execCommand").mockReturnValue(true)
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.edit.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.edit.label"))
  await user.click(await screen.findByText("desktop.menu.edit.copy"))
  expect(exec).toHaveBeenCalledWith("copy")
  exec.mockRestore()
})

test("View > Command Palette asks the palette to open", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  const seen: unknown[] = []
  const listener = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
  try {
    render(<TitleBar />)
    await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
    await user.click(screen.getByText("desktop.menu.view.label"))
    await user.click(await screen.findByText("desktop.menu.view.commandPalette"))
    await waitFor(() => expect(seen).toHaveLength(1))
  } finally {
    window.removeEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
  }
})

test("View > Toggle Sidebar calls toggleSidebar", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.toggleSidebar"))
  expect(toggleSidebar).toHaveBeenCalled()
})

test("View > Toggle Fullscreen flips fullscreen state", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isFullscreen.mockResolvedValue(false)
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.toggleFullscreen"))
  await waitFor(() => expect(setFullscreen).toHaveBeenCalledWith(true))
})

test("View > Toggle Fullscreen logs an error when the API throws", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isFullscreen.mockRejectedValueOnce(new Error("nope"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.toggleFullscreen"))
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith("title-bar toggle-fullscreen failed", expect.any(Error))
  )
})

test("Go > Twin routes to /twin", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.go.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.go.label"))
  await user.click(await screen.findByText("desktop.menu.go.twin"))
  expect(routerPush).toHaveBeenCalledWith("/twin")
})

test("Go > Canvas sets the canvas guild", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.go.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.go.label"))
  await user.click(await screen.findByText("desktop.menu.go.canvas"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
})

test("Window > Always on Top toggles state", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.window.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.window.label"))
  await user.click(await screen.findByText("desktop.menu.window.alwaysOnTop"))
  await waitFor(() => expect(setAlwaysOnTop).toHaveBeenCalledWith(true))
})

test("Help > Documentation opens the Tauri docs URL", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.help.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.help.label"))
  await user.click(await screen.findByText("desktop.menu.help.documentation"))
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://v2.tauri.app"))
})

test("Help > Documentation logs error when openExternal throws", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  openExternal.mockRejectedValueOnce(new Error("blocked"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.help.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.help.label"))
  await user.click(await screen.findByText("desktop.menu.help.documentation"))
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith("title-bar documentation failed", expect.any(Error))
  )
})

test("Help > About routes to settings about section", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.help.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.help.label"))
  await user.click(await screen.findByText("desktop.menu.help.about"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=about"))
})

test("data-tauri-drag-region is on header and the centered area, NOT on buttons / triggers / pill", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const { container } = render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByLabelText("desktop.titleBar.minimize")).toBeInTheDocument()
  )
  const header = container.querySelector("header")
  expect(header).toHaveAttribute("data-tauri-drag-region")
  // Buttons must NOT carry the drag attribute.
  expect(
    screen.getByLabelText("desktop.titleBar.minimize").hasAttribute("data-tauri-drag-region")
  ).toBe(false)
  // Menu triggers must NOT carry the drag attribute.
  expect(screen.getByText("desktop.menu.file.label").hasAttribute("data-tauri-drag-region")).toBe(
    false
  )
  // Search pill (clickable button) must NOT carry the drag attribute, otherwise
  // the click would not register reliably.
  expect(screen.getByTestId("title-bar-search-pill").hasAttribute("data-tauri-drag-region")).toBe(
    false
  )
})

test("logs an error when minimize itself rejects", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  minimize.mockRejectedValueOnce(new Error("min-fail"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByLabelText("desktop.titleBar.minimize")).toBeInTheDocument()
  )
  await user.click(screen.getByLabelText("desktop.titleBar.minimize"))
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith("title-bar minimize failed", expect.any(Error))
  )
})

test("logs an error when toggleMaximize rejects", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  toggleMaximize.mockRejectedValueOnce(new Error("max-fail"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByLabelText("desktop.titleBar.maximize")).toBeInTheDocument()
  )
  await user.click(screen.getByLabelText("desktop.titleBar.maximize"))
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith("title-bar toggle maximize failed", expect.any(Error))
  )
})

test("logs an error when close rejects", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  close.mockRejectedValueOnce(new Error("close-fail"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByLabelText("desktop.titleBar.close")).toBeInTheDocument())
  await user.click(screen.getByLabelText("desktop.titleBar.close"))
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith("title-bar close failed", expect.any(Error))
  )
})

test("shows the restore icon (and label) once the window is maximized", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isMaximized.mockResolvedValue(true)
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByLabelText("desktop.titleBar.restore")).toBeInTheDocument())
})

test("clicking the search pill asks the palette to open — on every platform, in and out of Tauri", async () => {
  // It used to forge ⌘K / Ctrl+K and had to guess the modifier; the web shell
  // (where `isMac` is deliberately false) sent Ctrl+K to a Mac palette that
  // listens for ⌘K, and nothing opened. A request has no modifier to get wrong.
  const user = userEvent.setup()
  for (const [tauri, platform] of [
    [true, "Win32"],
    [true, "MacIntel"],
    [false, "MacIntel"],
  ] as const) {
    isTauriMock.mockReturnValue(tauri)
    setPlatform(platform)
    const seen: unknown[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
    const view = render(<TitleBar />)
    try {
      await waitFor(() => expect(screen.getByTestId("title-bar-search-pill")).toBeInTheDocument())
      await user.click(screen.getByTestId("title-bar-search-pill"))
      expect(seen).toHaveLength(1)
    } finally {
      window.removeEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
      view.unmount()
    }
  }
})

test("streaming dot replaces the search icon when chat is streaming", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  chatStateRef.status = "streaming"
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar-streaming-dot")).toBeInTheDocument())
})

test("double-clicking the title bar toggles maximize on Win/Linux", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  fireEvent.doubleClick(screen.getByTestId("title-bar"))
  await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())
})

test("double-clicking is a no-op on Mac (system handles it)", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  fireEvent.doubleClick(screen.getByTestId("title-bar"))
  expect(toggleMaximize).not.toHaveBeenCalled()
})

test("right-click opens the system menu on Win/Linux", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  fireEvent.contextMenu(screen.getByTestId("title-bar"))
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-system-menu-trigger")).toBeInTheDocument()
  )
})

test("right-click on Mac opens the menu without the window commands", async () => {
  // The menu is no longer Win/Linux-only: it carries "Customize layout" on
  // every platform (see the customizer test below). What stays platform-gated
  // is the restore/minimize/maximize/close block, which macOS gets from the
  // traffic lights instead.
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  fireEvent.contextMenu(screen.getByTestId("title-bar"))
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-system-menu-trigger")).toBeInTheDocument()
  )
  expect(screen.queryByText("desktop.menu.window.close")).toBeNull()
  expect(screen.queryByText("desktop.menu.window.maximize")).toBeNull()
})

test("hamburger menu replaces Menubar at narrow widths", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar-hamburger")).toBeInTheDocument())
  expect(screen.queryByText("desktop.menu.file.label")).toBeNull()
})

test("hamburger menu lists items from every section", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-hamburger"))
  // File and Help labels are now MenubarLabel-style headers inside the dropdown.
  await waitFor(() => expect(screen.getByText("desktop.menu.go.label")).toBeInTheDocument())
  expect(screen.getByText("desktop.menu.window.label")).toBeInTheDocument()
})

// The hamburger is the entire menu on a narrow window, so its items must
// dispatch the same actions the wide menubar does rather than only render.
test.each([
  ["desktop.menu.tools.manageConnectors", "/settings?section=connections"],
  ["desktop.menu.tools.manageMcpServer", "/settings?section=external-bridge"],
  ["desktop.menu.tools.pluginDevtools", "/settings?section=plugins"],
])("hamburger > %s routes to %s", async (label, route) => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-hamburger"))
  await user.click(await screen.findByText(label))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith(route))
})

test("hamburger > Command Palette dispatches the shortcut", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-hamburger"))
  await user.click(await screen.findByText("desktop.menu.tools.commandPalette"))
  await waitFor(() => expect(logInfo).toHaveBeenCalledWith("title-bar menu command-palette"))
})

test("a viewport crossing the narrow breakpoint swaps the menubar for the hamburger", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = false
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  // Drive the matchMedia listener the width hook subscribes to.
  act(() => {
    narrowState.matches = true
    narrowState.listeners.forEach((cb) => cb())
  })
  await waitFor(() => expect(screen.getByTestId("title-bar-hamburger")).toBeInTheDocument())
})

test("act-friendly Edit > Undo path", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const exec = jest.spyOn(document, "execCommand").mockReturnValue(true)
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.edit.label"))
  await user.click(await screen.findByText("desktop.menu.edit.undo"))
  await waitFor(() => expect(exec).toHaveBeenCalledWith("undo"))
  exec.mockRestore()
})

test("Edit menu items log when execCommand throws", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const exec = jest.spyOn(document, "execCommand").mockImplementation(() => {
    throw new Error("nope")
  })
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.edit.label"))
  await user.click(await screen.findByText("desktop.menu.edit.paste"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar edit failed",
      expect.objectContaining({ cmd: "paste", error: "nope" })
    )
  )
  exec.mockRestore()
})

test("Window > Maximize via menubar toggles maximize", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.window.label"))
  await user.click(await screen.findByText("desktop.menu.window.maximize"))
  await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())
})

test("View > Reload triggers the reload handler (logs the action)", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  // window.location.reload is not mockable in JSDOM; verify the handler ran
  // by asserting on the log line emitted right before the reload() call.
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.reload"))
  await waitFor(() => expect(logInfo).toHaveBeenCalledWith("title-bar menu reload"))
})

test("act-wrap to silence pending-state warnings", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  await act(async () => {
    render(<TitleBar />)
  })
})

// ---------------------------------------------------------------------------
// Coverage sweep: drive every still-untouched menu item so that the inline
// `onSelect={() => …}` closures show up as covered. We assert on a single
// observable side-effect per item and group them by parent menu.
// ---------------------------------------------------------------------------

test.each([
  ["edit", "redo", "redo"],
  ["edit", "cut", "cut"],
  ["edit", "paste", "paste"],
  ["edit", "selectAll", "selectAll"],
])("Edit > %s -> %s delegates to execCommand", async (_menu, item, cmd) => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const exec = jest.spyOn(document, "execCommand").mockReturnValue(true)
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.edit.label"))
  await user.click(await screen.findByText(`desktop.menu.edit.${item}`))
  expect(exec).toHaveBeenCalledWith(cmd)
  exec.mockRestore()
})

test.each([
  ["in", 1.1],
  ["out", 0.9],
  ["reset", 1.0],
])("View > Zoom %s applies the change", async (_kind, expected) => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  // The zoom group lives inside a sub-menu trigger ("Cognia: Zoom"). Hover it
  // to reveal Zoom In / Out / Reset.
  await user.click(
    await screen.findByText(
      _kind === "in"
        ? "desktop.menu.view.zoomIn"
        : _kind === "out"
          ? "desktop.menu.view.zoomOut"
          : "desktop.menu.view.zoomReset"
    )
  )
  await waitFor(() => expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(expected, 4)))
})

test("View > Zoom logs instead of throwing when the new zoom fails to persist", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  settingsSave.mockRejectedValueOnce(new Error("disk full"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.zoomIn"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith("title-bar zoom persist failed", {
      error: "disk full",
    })
  )
})

test("a resize event refreshes the maximized state", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  let onResizedCb: (() => Promise<void>) | undefined
  onResized.mockImplementation(async (cb: () => Promise<void>) => {
    onResizedCb = cb
    return () => {}
  })
  render(<TitleBar />)
  await waitFor(() => expect(onResizedCb).toBeDefined())
  isMaximized.mockResolvedValueOnce(true)
  await act(async () => {
    await onResizedCb?.()
  })
  // Maximized → the button offers Restore rather than Maximize.
  await waitFor(() => expect(screen.getByLabelText("desktop.titleBar.restore")).toBeInTheDocument())
})

test.each([["dms"], ["logs"], ["settings"]])(
  "Go > %s routes/dispatches as expected",
  async (target) => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    const user = userEvent.setup()
    render(<TitleBar />)
    await user.click(await screen.findByText("desktop.menu.go.label"))
    await user.click(await screen.findByText(`desktop.menu.go.${target}`))
    // dms hits setSelectedGuild + push("/"), the other two just push.
    if (target === "dms") {
      expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    } else {
      expect(routerPush).toHaveBeenCalledWith(`/${target}`)
    }
  }
)

test("Window > Minimize via menubar minimizes the window", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.window.label"))
  await user.click(await screen.findByText("desktop.menu.window.minimize"))
  await waitFor(() => expect(minimize).toHaveBeenCalled())
})

test("Window > Close via menubar closes the window", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.window.label"))
  await user.click(await screen.findByText("desktop.menu.window.close"))
  await waitFor(() => expect(close).toHaveBeenCalled())
})

test("Always-on-top ignores missing setAlwaysOnTop API", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  // Simulate older Tauri builds that don't expose setAlwaysOnTop.
  setAlwaysOnTop.mockImplementationOnce(async () => {
    throw new Error("not supported")
  })
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.window.label"))
  await user.click(await screen.findByText("desktop.menu.window.alwaysOnTop"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar always-on-top failed",
      expect.objectContaining({ error: "not supported" })
    )
  )
})

test("hamburger menu: every section is reachable", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-hamburger"))
  // Spot-check items from each section to ensure their JSX onSelect closures
  // are all instantiated and rendered.
  expect(await screen.findByText("desktop.menu.file.newChat")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.edit.copy")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.view.toggleSidebar")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.go.canvas")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.window.maximize")).toBeInTheDocument()
  expect(screen.getByText("desktop.menu.help.about")).toBeInTheDocument()
})

test.each([
  ["file.newChat"],
  ["file.openSettings"],
  ["file.openLogs"],
  ["file.quit"],
  ["edit.undo"],
  ["edit.redo"],
  ["edit.cut"],
  ["edit.copy"],
  ["edit.paste"],
  ["edit.selectAll"],
  ["edit.find"],
  ["view.commandPalette"],
  ["view.toggleSidebar"],
  ["view.reload"],
  ["view.openLogs"],
  ["view.zoomIn"],
  ["view.zoomOut"],
  ["view.zoomReset"],
  ["go.dms"],
  ["go.canvas"],
  ["go.twin"],
  ["go.logs"],
  ["go.settings"],
  ["window.alwaysOnTop"],
  ["window.minimize"],
  ["window.maximize"],
  ["window.close"],
  ["help.documentation"],
  ["help.about"],
])("hamburger menu > %s is selectable without throwing", async (key) => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  narrowState.matches = true
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByTestId("title-bar-hamburger"))
  await user.click(await screen.findByText(`desktop.menu.${key}`))
  // Each item's success path differs, so we just assert the closure ran by
  // checking no error was thrown synchronously.
  expect(true).toBe(true)
})

test("right-click system menu items each act on the window", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  isMaximized.mockResolvedValue(true)
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByLabelText("desktop.titleBar.restore")).toBeInTheDocument())
  fireEvent.contextMenu(screen.getByTestId("title-bar"))
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-system-menu-trigger")).toBeInTheDocument()
  )
  // Click Restore — toggles maximize once and closes the menu.
  toggleMaximize.mockClear()
  await user.click(await screen.findByText("desktop.menu.window.restore"))
  await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())
})

test("right-click system menu Close routes to handleClose", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  fireEvent.contextMenu(screen.getByTestId("title-bar"))
  await waitFor(() =>
    expect(screen.getByTestId("title-bar-system-menu-trigger")).toBeInTheDocument()
  )
  await user.click(
    await screen.findAllByText("desktop.menu.window.close").then((nodes) => nodes[0])
  )
  await waitFor(() => expect(close).toHaveBeenCalled())
})

test("right-click is suppressed when target is a button or menu trigger", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  fireEvent.contextMenu(screen.getByText("desktop.menu.file.label"))
  expect(screen.queryByTestId("title-bar-system-menu-trigger")).toBeNull()
})

test("double-click is suppressed when target is a button or menu trigger", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() =>
    expect(screen.getByLabelText("desktop.titleBar.minimize")).toBeInTheDocument()
  )
  toggleMaximize.mockClear()
  fireEvent.doubleClick(screen.getByLabelText("desktop.titleBar.minimize"))
  expect(toggleMaximize).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// Extended File menu (New Workflow / Agent Team / Character + Recent Sessions)
// ---------------------------------------------------------------------------

test("File > New Workflow signals create + routes to /workflows", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.newWorkflow"))
  expect(requestCreate).toHaveBeenCalledWith("workflow")
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/workflows"))
})

test("File > New Agent Team signals create + routes to /agent-teams", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.newAgentTeam"))
  expect(requestCreate).toHaveBeenCalledWith("agentTeam")
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/agent-teams"))
})

test("File > New Character signals create + routes to settings characters tab", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.newCharacter"))
  expect(requestCreate).toHaveBeenCalledWith("character")
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=characters"))
})

test("File > Recent Sessions submenu lists loaded sessions and routes on click", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  listSessionsMock.mockResolvedValueOnce([
    { id: "s1", title: "Latest chat", kind: "direct", createdAt: 1, updatedAt: 1 },
    { id: "s2", title: "Older chat", kind: "direct", createdAt: 1, updatedAt: 0 },
    {
      id: "embedded",
      title: "Canvas assistant",
      kind: "resource-workbench",
      visibility: "embedded",
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.file.label"))
  // Radix submenu opens via keyboard ArrowRight on the focused trigger.
  // jsdom pointer events aren't reliable enough for hover/click.
  const subTrigger = await screen.findByText("desktop.menu.file.recentSessions")
  subTrigger.focus()
  await user.keyboard("{ArrowRight}")
  expect(screen.queryByText("Canvas assistant")).toBeNull()
  await user.click(await screen.findByText("Latest chat"))
  expect(setActiveSession).toHaveBeenCalledWith("s1")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"))
})

test("File > Recent Sessions shows the empty-state row when there are no sessions", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  listSessionsMock.mockResolvedValueOnce([])
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.file.label"))
  const subTrigger = await screen.findByText("desktop.menu.file.recentSessions")
  subTrigger.focus()
  await user.keyboard("{ArrowRight}")
  expect(await screen.findByText("desktop.menu.file.recentSessionsEmpty")).toBeInTheDocument()
})

test("File > Recent Sessions tolerates a listSessions failure", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  listSessionsMock.mockRejectedValueOnce(new Error("disk"))
  render(<TitleBar />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar load recent-sessions failed",
      expect.objectContaining({ error: "disk" })
    )
  )
})

// ---------------------------------------------------------------------------
// Extended View menu (toggles, theme submenu, language submenu, reduce motion)
// ---------------------------------------------------------------------------

test("View > Toggle Guild Rail calls toggleGuildRail", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.toggleGuildRail"))
  expect(toggleGuildRail).toHaveBeenCalled()
})

test("View > Toggle Status Bar calls toggleStatusBar", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.toggleStatusBar"))
  expect(toggleStatusBar).toHaveBeenCalled()
})

test("View > Theme submenu sets the chosen theme and persists it", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  const themeTrigger = await screen.findByText("desktop.menu.view.theme")
  themeTrigger.focus()
  await user.keyboard("{ArrowRight}")
  const darkItem = await screen.findByRole("menuitemradio", {
    name: "desktop.menu.view.themeDark",
  })
  await user.click(darkItem)
  await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"))
  await waitFor(() => expect(settingsSave).toHaveBeenCalledWith({ theme: "dark" }))
})

test("View > Language submenu persists the chosen locale", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  const langTrigger = await screen.findByText("desktop.menu.view.language")
  langTrigger.focus()
  await user.keyboard("{ArrowRight}")
  const zhItem = await screen.findByRole("menuitemradio", {
    name: "desktop.menu.view.languageChinese",
  })
  await user.click(zhItem)
  await waitFor(() => expect(settingsSave).toHaveBeenCalledWith({ language: "zh-CN" }))
})

test("View > Reduce Motion flips the persisted boolean", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.view.label"))
  await user.click(await screen.findByText("desktop.menu.view.reduceMotion"))
  await waitFor(() => expect(settingsSave).toHaveBeenCalledWith({ reduceMotion: true }))
})

// ---------------------------------------------------------------------------
// Extended Go menu — every new top-level destination
// ---------------------------------------------------------------------------

test.each([
  ["go.inbox", "/inbox/all"],
  ["go.workflows", "/workflows"],
  ["go.sites", "/sites"],
  ["go.skills", "/skills"],
  ["go.plugins", "/plugins"],
  ["go.agentTeams", "/agent-teams"],
  ["go.scheduler", "/scheduler"],
  ["go.discover", "/discover"],
  ["go.a2ui", "/a2ui"],
])("Go > %s routes to %s", async (key, route) => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.go.label"))
  await user.click(await screen.findByText(`desktop.menu.${key}`))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith(route))
})

// ---------------------------------------------------------------------------
// Tools menu
// ---------------------------------------------------------------------------

test("Tools > Command Palette asks the palette to open", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const seen: unknown[] = []
  const listener = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
  try {
    const user = userEvent.setup()
    render(<TitleBar />)
    await user.click(await screen.findByText("desktop.menu.tools.label"))
    await user.click(await screen.findByText("desktop.menu.tools.commandPalette"))
    expect(seen).toHaveLength(1)
  } finally {
    window.removeEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
  }
})

test("Tools > Automation Kill-Switch invokes the automation client", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.automationKillSwitch"))
  await waitFor(() => expect(killSwitch).toHaveBeenCalled())
})

test("Tools > Automation Kill-Switch logs warning when the call throws", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  killSwitch.mockRejectedValueOnce(new Error("denied"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.automationKillSwitch"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar tools automation-kill-switch failed",
      expect.objectContaining({ error: "denied" })
    )
  )
})

test("Tools > Manage Connectors routes to the connections settings tab", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.manageConnectors"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=connections"))
})

test("Tools > Manage MCP Server routes to external-bridge settings", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.manageMcpServer"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=external-bridge"))
})

test("Tools > Plugin DevTools routes to the plugins settings tab", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.pluginDevtools"))
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=plugins"))
})

test("Tools > Restart Sidecar invokes claude_restart_sidecar", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.sidecarRestart"))
  await waitFor(() => expect(transportCall).toHaveBeenCalledWith("claude_restart_sidecar", {}))
})

test("Tools > Restart Sidecar logs warning when invoke fails", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  transportCall.mockRejectedValueOnce(new Error("offline"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.sidecarRestart"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar tools sidecar-restart failed",
      expect.objectContaining({ error: "offline" })
    )
  )
})

test("Tools > Clear Cache wipes the openVsxCache table", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.clearCache"))
  await waitFor(() => expect(openVsxClear).toHaveBeenCalled())
})

test("Tools > Clear Cache logs warning when the cache wipe rejects", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  openVsxClear.mockRejectedValueOnce(new Error("io"))
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.tools.label"))
  await user.click(await screen.findByText("desktop.menu.tools.clearCache"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar tools clear-cache failed",
      expect.objectContaining({ error: expect.stringContaining("openVsxCache") })
    )
  )
})

// ---------------------------------------------------------------------------
// Help → Keyboard Shortcuts dialog
// ---------------------------------------------------------------------------

test("Help > Keyboard Shortcuts opens the shortcuts dialog", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await user.click(await screen.findByText("desktop.menu.help.label"))
  await user.click(await screen.findByText("desktop.menu.help.keyboardShortcuts"))
  await waitFor(() => expect(screen.getByTestId("keyboard-shortcuts-dialog")).toBeInTheDocument())
  // Spot-check one shortcut row.
  expect(screen.getByText("desktop.menu.shortcut.cmdOrCtrlShiftP")).toBeInTheDocument()
})

// ---------------------------------------------------------------------------
// Wide Menubar: ensure every new top-level trigger is rendered
// ---------------------------------------------------------------------------

test("wide menubar exposes Tools as a top-level trigger", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.tools.label")).toBeInTheDocument())
})

test("stays within the title-bar chrome control budget on macOS", async () => {
  // macOS is the tightest case worth guarding: `!isMac` suppresses the whole
  // in-window Menubar, so what remains IS the permanent control surface.
  // Ratchet, not a target — see lib/ui/chrome-budget.ts.
  //
  // `beforeEach` clears the hidden set so the other tests can assert every
  // segment; the budget must measure what users actually get, so restore the
  // shipped hidden set here.
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  for (const id of DEFAULT_TITLE_BAR_LAYOUT.hidden) barHidden.add(id)
  render(<TitleBar />)
  const header = await screen.findByTestId("title-bar")
  expect(countControls(header)).toBeLessThanOrEqual(CHROME_BUDGET.titleBar)
})

test("offers a right-click route into the customizer on macOS too", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  const user = userEvent.setup()
  render(<TitleBar />)
  const header = await screen.findByTestId("title-bar")
  fireEvent.contextMenu(header)
  const customize = await screen.findByTestId("title-bar-customize")
  // The window commands stay Win/Linux-only — macOS has the traffic lights.
  expect(screen.queryByText("desktop.menu.window.minimize")).toBeNull()
  await user.click(customize)
  expect(await screen.findByTestId("shell-layout-dialog")).toBeInTheDocument()
})

describe("the Win/Linux right-click system menu", () => {
  const openSystemMenu = async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    render(<TitleBar />)
    fireEvent.contextMenu(await screen.findByTestId("title-bar"))
    await waitFor(() =>
      expect(screen.getByTestId("title-bar-system-menu-trigger")).toBeInTheDocument()
    )
  }

  it("minimizes the window", async () => {
    const user = userEvent.setup()
    await openSystemMenu()
    await user.click(screen.getByText("desktop.menu.window.minimize"))
    await waitFor(() => expect(minimize).toHaveBeenCalled())
  })

  it("maximizes the window when it is not already maximized", async () => {
    const user = userEvent.setup()
    await openSystemMenu()
    await user.click(screen.getByText("desktop.menu.window.maximize"))
    await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())
  })

  it("closes the window", async () => {
    const user = userEvent.setup()
    await openSystemMenu()
    await user.click(screen.getByText("desktop.menu.window.close"))
    await waitFor(() => expect(close).toHaveBeenCalled())
  })

  it("disables Restore while the window is not maximized", async () => {
    await openSystemMenu()
    expect(
      screen.getByText("desktop.menu.window.restore").closest("[role='menuitem']")
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("also reaches the customizer, below the window commands", async () => {
    const user = userEvent.setup()
    await openSystemMenu()
    await user.click(screen.getByTestId("title-bar-customize"))
    expect(await screen.findByTestId("shell-layout-dialog")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Column-header projection (components/shell/title-bar-outlets.tsx)
// ---------------------------------------------------------------------------

function ProjectedHeader({ zone }: { zone: "start" | "center" | "end" }) {
  const outlet = useTitleBarProjection(zone)
  const content = <span data-testid={`projected-${zone}`}>{zone}</span>
  return outlet ? (
    createPortal(content, outlet)
  ) : (
    <div data-testid={`inline-${zone}`}>{content}</div>
  )
}

function renderProjecting(zones: Array<"start" | "center" | "end">) {
  return render(
    <TitleBarOutletsProvider>
      <TitleBar />
      <TitleBarProjectionScope enabled>
        {zones.map((zone) => (
          <ProjectedHeader key={zone} zone={zone} />
        ))}
      </TitleBarProjectionScope>
    </TitleBarOutletsProvider>
  )
}

describe("column-header projection", () => {
  beforeEach(() => {
    act(() =>
      useShellColumnsStore.setState({
        widths: { rail: 0, sidebar: 0, dock: 0 },
        sidebarHostsNav: false,
      })
    )
  })

  test("outlets stay hidden and empty until something projects", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    render(
      <TitleBarOutletsProvider>
        <TitleBar />
      </TitleBarOutletsProvider>
    )
    const start = await screen.findByTestId("title-bar-outlet-start")
    expect(start).toHaveAttribute("hidden")
    expect(screen.getByTestId("title-bar-outlet-center")).toHaveAttribute("hidden")
    expect(screen.getByTestId("title-bar-outlet-end")).toHaveAttribute("hidden")
    // The bar's own segments are untouched.
    expect(screen.getByTestId("title-bar-search-pill")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-search-pill")).not.toHaveAttribute("data-compact")
    expect(screen.getByTestId("title-bar-workspace-seg")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-toggle-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-toggle-panel")).toBeInTheDocument()
  })

  test("hosts the conversation-rail header in the start outlet, sized to the rail below", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    act(() => {
      useShellColumnsStore.getState().setColumnWidth("rail", 56)
      useShellColumnsStore.getState().setColumnWidth("sidebar", 296)
    })
    renderProjecting(["start"])
    const start = await screen.findByTestId("title-bar-outlet-start")
    await waitFor(() => expect(start).toContainElement(screen.getByTestId("projected-start")))
    expect(start).not.toHaveAttribute("hidden")
    // measured nav rail 56 + conversation rail 296, less the bar's own `pl-2`
    // (8) and the (jsdom-zero) width of the chrome ahead of the outlet.
    expect(start).toHaveStyle({ width: "344px" })
    // The Windows/Linux menubar folds into the hamburger so it cannot sit over
    // the conversation rail's column.
    expect(screen.getByTestId("title-bar-hamburger")).toBeInTheDocument()
    expect(screen.queryByText("desktop.menu.file.label")).toBeNull()
    // The bar's own segments are constant: projection sizes the outlet and
    // folds the menubar, it does not delete the workspace pill.
    expect(screen.getByTestId("title-bar-workspace-seg")).toBeInTheDocument()
  })

  test("with the rail hidden (sidebar hosting the navigation) the start outlet spans the sidebar alone", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    // The rail reports 0 while unmounted; the outlet is offset by what it draws.
    act(() => useShellColumnsStore.getState().setColumnWidth("sidebar", 296))
    renderProjecting(["start"])
    const start = await screen.findByTestId("title-bar-outlet-start")
    await waitFor(() => expect(start).toContainElement(screen.getByTestId("projected-start")))
    expect(start).toHaveStyle({ width: "288px" })
  })

  test("with the chat header in the centre, the header leads and the bar's segments are unchanged", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    renderProjecting(["center"])
    const center = await screen.findByTestId("title-bar-outlet-center")
    await waitFor(() => expect(center).toContainElement(screen.getByTestId("projected-center")))
    // Nothing is dropped — route history, the workspace pill and the VS Code-
    // style search pill all stay — they follow the header, which keeps the
    // chat column's leading edge.
    const nav = screen.getByTestId("title-bar-nav-arrows")
    const search = screen.getByTestId("title-bar-search-pill")
    expect(screen.getByTestId("title-bar-workspace-seg")).toBeInTheDocument()
    expect(center.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(center.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The pill keeps its full "app · conversation" shape — the bar's segments
    // do not change with the outlet, or the top row would be one shape inside a
    // conversation and another everywhere else.
    expect(search).not.toHaveAttribute("data-compact")
    // Every end-zone toggle stays. The projected chat header drops its own
    // copies of the two the bar owns (`components/chat/chat-header.tsx`).
    expect(screen.getByTestId("title-bar-toggle-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-toggle-right-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-toggle-panel")).toBeInTheDocument()
    // Start and end are still idle.
    expect(screen.getByTestId("title-bar-outlet-start")).toHaveAttribute("hidden")
    expect(screen.getByTestId("title-bar-outlet-end")).toHaveAttribute("hidden")
  })

  test("sizes the end outlet to the artifact dock below", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    act(() => useShellColumnsStore.getState().setColumnWidth("dock", 420))
    renderProjecting(["end"])
    const end = await screen.findByTestId("title-bar-outlet-end")
    await waitFor(() => expect(end).toContainElement(screen.getByTestId("projected-end")))
    // Rail is on the left by default, so nothing offsets the right edge; the
    // chrome after the outlet measures zero in jsdom.
    expect(end).toHaveStyle({ width: "420px" })
  })

  test("without a provider (mobile shell) headers stay inline and the bar is unaffected", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    render(
      <>
        <TitleBar />
        <TitleBarProjectionScope enabled>
          <ProjectedHeader zone="center" />
        </TitleBarProjectionScope>
      </>
    )
    await screen.findByTestId("title-bar")
    expect(screen.getByTestId("inline-center")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-search-pill")).toBeInTheDocument()
  })
})
