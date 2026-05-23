/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const logInfo = jest.fn()
const logWarn = jest.fn()
jest.mock("@/lib/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
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

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// `stores/index.ts` calls `isTauri()` at module top-level; declaring the
// jest.fn inside the factory dodges the TDZ.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

jest.mock("@/lib/tauri/webview-zoom", () => {
  const actual = jest.requireActual<typeof import("@/lib/tauri/webview-zoom")>(
    "@/lib/tauri/webview-zoom"
  )
  return { ...actual, applyZoom: jest.fn() }
})

import * as webviewZoom from "@/lib/tauri/webview-zoom"
const applyZoom = webviewZoom.applyZoom as jest.Mock

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ getCharacter: jest.fn() }))

const sessionRef = {
  value: undefined as undefined | { id: string; title: string; characterId?: string },
}
const characterRef = {
  value: undefined as undefined | { id: string; name: string },
}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    const src = factory.toString()
    if (src.includes("getCharacter")) return characterRef.value
    return sessionRef.value
  },
}))

const chatRef = {
  activeSessionId: null as string | null,
  status: "idle" as "idle" | "streaming" | "awaiting_approval" | "error",
  errorMessage: null as string | null,
  permissionMode: "default" as "default" | "plan" | "acceptEdits" | "bypassPermissions" | null,
}
const setPermissionMode = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeSessionId: chatRef.activeSessionId,
      status: chatRef.status,
      errorMessage: chatRef.errorMessage,
      permissionMode: chatRef.permissionMode,
      setPermissionMode,
    }),
}))

const toggleSidebar = jest.fn()
const uiRef = { sidebarCollapsed: false }
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ toggleSidebar, sidebarCollapsed: uiRef.sidebarCollapsed }),
}))

const settingsRef = {
  webviewZoom: 1.0 as number | undefined,
  language: "en" as "en" | "zh-CN",
}
const setLanguage = jest.fn().mockResolvedValue(undefined)
const saveSettings = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { webviewZoom: settingsRef.webviewZoom },
      language: settingsRef.language,
      setLanguage,
      save: saveSettings,
    }),
}))

const setTheme = jest.fn()
const themeRef = { value: "system" as "light" | "dark" | "system" | undefined }
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme }),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}))

import { StatusBar } from "./status-bar"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  isTauriMock.mockReset().mockReturnValue(true)
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  toggleSidebar.mockReset()
  setPermissionMode.mockReset()
  setLanguage.mockReset().mockResolvedValue(undefined)
  saveSettings.mockReset().mockResolvedValue(undefined)
  setTheme.mockReset()
  routerPush.mockReset()
  chatRef.activeSessionId = null
  chatRef.status = "idle"
  chatRef.errorMessage = null
  chatRef.permissionMode = "default"
  uiRef.sidebarCollapsed = false
  settingsRef.webviewZoom = 1.0
  settingsRef.language = "en"
  themeRef.value = "system"
  sessionRef.value = undefined
  characterRef.value = undefined
})

test("renders all top-level segments", () => {
  render(<StatusBar />)
  expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  expect(screen.getByTestId("status-sidebar")).toBeInTheDocument()
  expect(screen.getByTestId("status-runtime")).toBeInTheDocument()
  expect(screen.getByTestId("status-session")).toBeInTheDocument()
  expect(screen.getByTestId("status-permission")).toBeInTheDocument()
  expect(screen.getByTestId("status-status")).toBeInTheDocument()
  expect(screen.getByTestId("status-theme")).toBeInTheDocument()
  expect(screen.getByTestId("status-zoom")).toBeInTheDocument()
  expect(screen.getByTestId("status-locale")).toBeInTheDocument()
  expect(screen.getByTestId("status-bell")).toBeInTheDocument()
})

test("sidebar segment toggles the sidebar", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-sidebar"))
  expect(toggleSidebar).toHaveBeenCalled()
})

test("session segment dispatches Ctrl+K", async () => {
  const user = userEvent.setup()
  const seen: KeyboardEvent[] = []
  const listener = (e: Event) => seen.push(e as KeyboardEvent)
  window.addEventListener("keydown", listener)
  try {
    render(<StatusBar />)
    await user.click(screen.getByTestId("status-session"))
    expect(seen.some((e) => e.key === "k" && e.ctrlKey)).toBe(true)
  } finally {
    window.removeEventListener("keydown", listener)
  }
})

test("permission popover lets the user pick a mode", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-permission"))
  await waitFor(() => expect(screen.getByTestId("status-permission-plan")).toBeInTheDocument())
  await user.click(screen.getByTestId("status-permission-plan"))
  expect(setPermissionMode).toHaveBeenCalledWith("plan")
})

test("theme button cycles light → dark", async () => {
  const user = userEvent.setup()
  themeRef.value = "light"
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-theme"))
  expect(setTheme).toHaveBeenCalledWith("dark")
})

test("theme button cycles dark → system", async () => {
  const user = userEvent.setup()
  themeRef.value = "dark"
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-theme"))
  expect(setTheme).toHaveBeenCalledWith("system")
})

test("theme button cycles system → light", async () => {
  const user = userEvent.setup()
  themeRef.value = "system"
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-theme"))
  expect(setTheme).toHaveBeenCalledWith("light")
})

test("locale button cycles en → zh-CN", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-locale"))
  expect(setLanguage).toHaveBeenCalledWith("zh-CN")
})

test("locale button shows 中 when language is zh-CN", () => {
  settingsRef.language = "zh-CN"
  render(<StatusBar />)
  expect(screen.getByTestId("status-locale")).toHaveTextContent("中")
})

test("locale segment cycles zh-CN → en", async () => {
  const user = userEvent.setup()
  settingsRef.language = "zh-CN"
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-locale"))
  expect(setLanguage).toHaveBeenCalledWith("en")
})

test("zoom popover applies and persists", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-zoom"))
  await waitFor(() => expect(screen.getByTestId("status-zoom-in")).toBeInTheDocument())
  await user.click(screen.getByTestId("status-zoom-in"))
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
  await waitFor(() =>
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ webviewZoom: expect.any(Number) })
    )
  )
})

test("zoom out works as well", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-zoom"))
  await user.click(screen.getByTestId("status-zoom-out"))
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
})

test("zoom reset returns to 1.0", async () => {
  const user = userEvent.setup()
  settingsRef.webviewZoom = 1.5
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-zoom"))
  await user.click(screen.getByTestId("status-zoom-reset"))
  await waitFor(() => expect(applyZoom).toHaveBeenCalledWith(1.0))
})

test("logs warning when zoom persist throws", async () => {
  const user = userEvent.setup()
  saveSettings.mockRejectedValueOnce(new Error("io"))
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-zoom"))
  await user.click(screen.getByTestId("status-zoom-out"))
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "status-bar zoom persist failed",
      expect.objectContaining({ error: "io" })
    )
  )
})

test("zoom percent reflects clamped persisted value", () => {
  settingsRef.webviewZoom = 5
  render(<StatusBar />)
  // 5 clamps to 2.0 → "200%"
  expect(screen.getByTestId("status-zoom")).toHaveTextContent("200%")
})

test("bell routes to /logs", async () => {
  const user = userEvent.setup()
  render(<StatusBar />)
  await user.click(screen.getByLabelText("desktop.statusBar.openLogs"))
  expect(routerPush).toHaveBeenCalledWith("/logs")
})

test("error indicator dot renders when errorMessage is non-null", () => {
  chatRef.errorMessage = "boom"
  const { container } = render(<StatusBar />)
  expect(container.querySelector(".bg-destructive.size-2")).not.toBeNull()
})

test("no error dot when errorMessage is null", () => {
  chatRef.errorMessage = null
  const { container } = render(<StatusBar />)
  expect(container.querySelector(".bg-destructive.size-2")).toBeNull()
})

test("runtime badge says Web in browser mode", () => {
  isTauriMock.mockReturnValue(false)
  render(<StatusBar />)
  expect(screen.getByTestId("status-runtime")).toHaveTextContent("desktop.statusBar.web")
})

test("permission popover marks the active mode with bg-accent", async () => {
  const user = userEvent.setup()
  chatRef.permissionMode = "plan"
  render(<StatusBar />)
  await user.click(screen.getByTestId("status-permission"))
  await waitFor(() => expect(screen.getByTestId("status-permission-plan")).toBeInTheDocument())
  expect(screen.getByTestId("status-permission-plan").className).toContain("bg-accent")
})

test("setLanguage failure is caught and logged", async () => {
  const user = userEvent.setup()
  setLanguage.mockRejectedValueOnce(new Error("oops"))
  render(<StatusBar />)
  await act(async () => {
    await user.click(screen.getByTestId("status-locale"))
  })
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "setLanguage failed",
      expect.objectContaining({ error: "oops" })
    )
  )
})

test("status indicator turns into the streaming state with animate-pulse", async () => {
  chatRef.status = "streaming"
  const { container } = render(<StatusBar />)
  await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeTruthy())
})

test.each([
  ["awaiting_approval" as const, "desktop.statusBar.awaitingApproval"],
  ["error" as const, "desktop.statusBar.error"],
  ["idle" as const, "desktop.statusBar.idle"],
])("status %s renders %s label", (status, label) => {
  chatRef.status = status
  render(<StatusBar />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

test("falls back to session title when no character is bound", () => {
  chatRef.activeSessionId = "s1"
  sessionRef.value = { id: "s1", title: "My chat" }
  render(<StatusBar />)
  expect(screen.getByText("My chat")).toBeInTheDocument()
})

test("prefers character name over session title", () => {
  chatRef.activeSessionId = "s1"
  sessionRef.value = { id: "s1", title: "Session", characterId: "c1" }
  characterRef.value = { id: "c1", name: "Pixel" }
  render(<StatusBar />)
  expect(screen.getByText("Pixel")).toBeInTheDocument()
})

test("sidebar icon dims when sidebarCollapsed is true", () => {
  uiRef.sidebarCollapsed = true
  const { container } = render(<StatusBar />)
  const icon = container.querySelector("[data-testid='status-sidebar'] svg")
  const cls = (icon?.getAttribute("class") ?? icon?.className.toString() ?? "") as string
  expect(cls).toContain("opacity-60")
})

test("non-interactive runtime badge has cursor-default", () => {
  render(<StatusBar />)
  expect(screen.getByTestId("status-runtime").className).toContain("cursor-default")
})
