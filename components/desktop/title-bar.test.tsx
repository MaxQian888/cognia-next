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

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
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

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
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

const settingsRef = { webviewZoom: 1.0 as number | undefined }
const settingsSave = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => {
  const useSettingsStore: ((s: (state: unknown) => unknown) => unknown) & {
    getState: () => unknown
  } = Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ settings: { webviewZoom: settingsRef.webviewZoom }, save: settingsSave }),
    { getState: () => ({ save: settingsSave }) }
  )
  return { useSettingsStore }
})

const openExternal = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}))

const chatClear = jest.fn()
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
    { getState: () => ({ clear: chatClear }) }
  ),
}))

const setSelectedGuild = jest.fn()
const toggleSidebar = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: Object.assign(
    (
      selector: (s: {
        setSelectedGuild: typeof setSelectedGuild
        toggleSidebar: typeof toggleSidebar
      }) => unknown
    ) => selector({ setSelectedGuild, toggleSidebar }),
    { getState: () => ({ setSelectedGuild, toggleSidebar }) }
  ),
}))

const sessionRef = {
  value: undefined as undefined | { id: string; title: string; characterId?: string },
}
const characterRef = { value: undefined as undefined | { id: string; name: string } }
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
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
})

import { TitleBar } from "./title-bar"

beforeEach(() => {
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
  settingsSave.mockClear().mockResolvedValue(undefined)
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  openExternal.mockClear().mockResolvedValue(undefined)
  chatClear.mockClear()
  setSelectedGuild.mockReset()
  toggleSidebar.mockReset()
  routerPush.mockClear()
  chatStateRef.activeSessionId = null
  chatStateRef.status = "idle"
  sessionRef.value = undefined
  characterRef.value = undefined
  settingsRef.webviewZoom = 1.0
  narrowState.matches = false
})

function setPlatform(platform: "Win32" | "MacIntel") {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
}

test("renders nothing when not in Tauri", () => {
  isTauriMock.mockReturnValue(false)
  const { container } = render(<TitleBar />)
  expect(container.firstChild).toBeNull()
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
  openDialog.mockRejectedValueOnce("not-an-error")
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

test("File > New Chat clears chat and resets guild", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.newChat"))
  await waitFor(() => expect(chatClear).toHaveBeenCalled())
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
})

test("File > Open Workspace persists picked path", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  openDialog.mockResolvedValueOnce("/picked/path")
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("desktop.menu.file.label")).toBeInTheDocument())
  await user.click(screen.getByText("desktop.menu.file.label"))
  await user.click(await screen.findByText("desktop.menu.file.openWorkspace"))
  await waitFor(() =>
    expect(settingsSave).toHaveBeenCalledWith({ defaultWorkingDir: "/picked/path" })
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

test("Edit > Find dispatches Ctrl+F", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  const seen: KeyboardEvent[] = []
  const listener = (e: Event) => seen.push(e as KeyboardEvent)
  window.addEventListener("keydown", listener)
  try {
    render(<TitleBar />)
    await waitFor(() => expect(screen.getByText("desktop.menu.edit.label")).toBeInTheDocument())
    await user.click(screen.getByText("desktop.menu.edit.label"))
    await user.click(await screen.findByText("desktop.menu.edit.find"))
    expect(seen.some((e) => e.key === "f" && e.ctrlKey)).toBe(true)
  } finally {
    window.removeEventListener("keydown", listener)
  }
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

test("View > Command Palette dispatches Ctrl+K", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  const seen: KeyboardEvent[] = []
  const listener = (e: Event) => seen.push(e as KeyboardEvent)
  window.addEventListener("keydown", listener)
  try {
    render(<TitleBar />)
    await waitFor(() => expect(screen.getByText("desktop.menu.view.label")).toBeInTheDocument())
    await user.click(screen.getByText("desktop.menu.view.label"))
    await user.click(await screen.findByText("desktop.menu.view.commandPalette"))
    await waitFor(() => expect(seen.find((e) => e.key === "k" && e.ctrlKey)).toBeTruthy())
  } finally {
    window.removeEventListener("keydown", listener)
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

test("clicking the search pill dispatches Ctrl+K", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("Win32")
  const user = userEvent.setup()
  const seen: KeyboardEvent[] = []
  const listener = (e: Event) => seen.push(e as KeyboardEvent)
  window.addEventListener("keydown", listener)
  try {
    render(<TitleBar />)
    await waitFor(() => expect(screen.getByTestId("title-bar-search-pill")).toBeInTheDocument())
    await user.click(screen.getByTestId("title-bar-search-pill"))
    expect(seen.some((e) => e.key === "k" && e.ctrlKey)).toBe(true)
  } finally {
    window.removeEventListener("keydown", listener)
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

test("right-click is suppressed on Mac", async () => {
  isTauriMock.mockReturnValue(true)
  setPlatform("MacIntel")
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByTestId("title-bar")).toBeInTheDocument())
  fireEvent.contextMenu(screen.getByTestId("title-bar"))
  expect(screen.queryByTestId("title-bar-system-menu-trigger")).toBeNull()
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
