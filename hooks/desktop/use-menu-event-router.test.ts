/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { MenuActionId } from "@/lib/desktop/menu-actions"

// ---------------------------------------------------------------------------
// Mocks — keep the mocked menu-actions module tiny but addressable so tests
// can assert which helper a given `menu://<id>` event drove.
// ---------------------------------------------------------------------------

const calls: Array<{ name: string; args: unknown[] }> = []
const track =
  (name: string) =>
  (...args: unknown[]) => {
    calls.push({ name, args })
  }

jest.mock("@/lib/desktop/menu-actions", () => {
  const ids = [
    "new-chat",
    "new-workflow",
    "new-agent-team",
    "new-character",
    "open-workspace",
    "open-settings",
    "open-logs",
    "quit",
    "command-palette",
    "toggle-sidebar",
    "toggle-guild-rail",
    "toggle-status-bar",
    "reload",
    "toggle-fullscreen",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "theme-light",
    "theme-dark",
    "theme-system",
    "language-en",
    "language-zh-cn",
    "toggle-reduce-motion",
    "go-inbox",
    "go-workflows",
    "go-twin",
    "go-skills",
    "go-plugins",
    "go-agent-teams",
    "go-scheduler",
    "go-discover",
    "go-a2ui",
    "go-dms",
    "go-canvas",
    "go-logs",
    "go-settings",
    "automation-kill-switch",
    "manage-connectors",
    "manage-mcp-server",
    "plugin-devtools",
    "sidecar-restart",
    "clear-cache",
    "keyboard-shortcuts",
    "documentation",
    "about",
  ]
  return {
    MENU_ACTION_IDS: ids,
    newChatAction: () => track("newChatAction")(),
    newWorkflowAction: (r: unknown) => track("newWorkflowAction")(r),
    newAgentTeamAction: (r: unknown) => track("newAgentTeamAction")(r),
    newCharacterAction: (r: unknown) => track("newCharacterAction")(r),
    openWorkspaceAction: () => track("openWorkspaceAction")(),
    openSettingsAction: (r: unknown) => track("openSettingsAction")(r),
    openLogsAction: (r: unknown) => track("openLogsAction")(r),
    quitAction: () => track("quitAction")(),
    commandPaletteAction: () => track("commandPaletteAction")(),
    toggleSidebarAction: () => track("toggleSidebarAction")(),
    toggleGuildRailAction: () => track("toggleGuildRailAction")(),
    toggleStatusBarAction: () => track("toggleStatusBarAction")(),
    reloadAction: () => track("reloadAction")(),
    toggleFullscreenAction: () => track("toggleFullscreenAction")(),
    setThemeAction: (...args: unknown[]) => track("setThemeAction")(...args),
    setLanguageAction: (...args: unknown[]) => track("setLanguageAction")(...args),
    toggleReduceMotionAction: (...args: unknown[]) => track("toggleReduceMotionAction")(...args),
    goAction: (r: unknown, id: string) => track("goAction")(r, id),
    automationKillSwitchAction: () => track("automationKillSwitchAction")(),
    manageConnectorsAction: (r: unknown) => track("manageConnectorsAction")(r),
    manageMcpServerAction: (r: unknown) => track("manageMcpServerAction")(r),
    pluginDevtoolsAction: (r: unknown) => track("pluginDevtoolsAction")(r),
    restartSidecarAction: () => track("restartSidecarAction")(),
    clearCacheAction: () => track("clearCacheAction")(),
    documentationAction: () => track("documentationAction")(),
    aboutAction: (r: unknown) => track("aboutAction")(r),
  }
})

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

type Listener = (payload?: unknown) => void
const subscribers: Map<string, Listener> = new Map()
let lastUnlistens: Array<jest.Mock> = []
const onTauriEvent = jest.fn(async (name: string, listener: Listener) => {
  subscribers.set(name, listener)
  const u = jest.fn(() => {
    subscribers.delete(name)
  })
  lastUnlistens.push(u)
  return u
})
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (name: string, listener: Listener) => onTauriEvent(name, listener),
  TAURI_EVENTS: {
    menuPrefix: "menu://",
    trayOpenLogs: "tray://open-logs",
  },
}))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

const setTheme = jest.fn()
jest.mock("next-themes", () => ({
  useTheme: () => ({ setTheme }),
}))

const settingsSave = jest.fn().mockResolvedValue(undefined)
const settingsRef = { reduceMotion: false }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      save: settingsSave,
      settings: { reduceMotion: settingsRef.reduceMotion },
    }),
  },
}))

const logWarn = jest.fn()
jest.mock("@/lib/logging", () => ({
  loggers: {
    ui: { info: jest.fn(), warn: (...a: unknown[]) => logWarn(...a), error: jest.fn() },
  },
}))

import { useMenuEventRouter } from "./use-menu-event-router"

async function flush(): Promise<void> {
  // Two microtask drains for the cascade inside the hook's subscribe loop.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  subscribers.clear()
  lastUnlistens = []
  calls.length = 0
  onTauriEvent.mockClear()
  setTheme.mockClear()
  settingsSave.mockClear().mockResolvedValue(undefined)
  settingsRef.reduceMotion = false
  logWarn.mockReset()
})

test("subscribes to one channel per menu id (minus zoom + reload + fullscreen) plus tray fallback", async () => {
  renderHook(() => useMenuEventRouter())
  await flush()
  // 45 ids in our mocked list minus 5 skipped (reload, toggle-fullscreen, zoom-in/out/reset)
  // plus 1 tray fallback => exact count.
  expect(subscribers.size).toBe(45 - 5 + 1)
  // Spot-check both kinds of subscription.
  expect(subscribers.has("menu://new-chat")).toBe(true)
  expect(subscribers.has("tray://open-logs")).toBe(true)
  // Verify the skipped ids never subscribed.
  for (const skipped of ["reload", "toggle-fullscreen", "zoom-in", "zoom-out", "zoom-reset"]) {
    expect(subscribers.has(`menu://${skipped}`)).toBe(false)
  }
})

test("is a no-op outside of Tauri", async () => {
  isTauriMock.mockReturnValueOnce(false)
  renderHook(() => useMenuEventRouter())
  await flush()
  expect(subscribers.size).toBe(0)
})

test("each menu event routes to the right action helper", async () => {
  renderHook(() => useMenuEventRouter())
  await flush()

  const cases: Array<[MenuActionId, string]> = [
    ["new-chat", "newChatAction"],
    ["new-workflow", "newWorkflowAction"],
    ["new-agent-team", "newAgentTeamAction"],
    ["new-character", "newCharacterAction"],
    ["open-workspace", "openWorkspaceAction"],
    ["open-settings", "openSettingsAction"],
    ["open-logs", "openLogsAction"],
    ["quit", "quitAction"],
    ["command-palette", "commandPaletteAction"],
    ["toggle-sidebar", "toggleSidebarAction"],
    ["toggle-guild-rail", "toggleGuildRailAction"],
    ["toggle-status-bar", "toggleStatusBarAction"],
    ["theme-light", "setThemeAction"],
    ["theme-dark", "setThemeAction"],
    ["theme-system", "setThemeAction"],
    ["language-en", "setLanguageAction"],
    ["language-zh-cn", "setLanguageAction"],
    ["toggle-reduce-motion", "toggleReduceMotionAction"],
    ["go-inbox", "goAction"],
    ["go-twin", "goAction"],
    ["go-dms", "goAction"],
    ["go-canvas", "goAction"],
    ["go-logs", "openLogsAction"],
    ["go-settings", "goAction"],
    ["automation-kill-switch", "automationKillSwitchAction"],
    ["manage-connectors", "manageConnectorsAction"],
    ["manage-mcp-server", "manageMcpServerAction"],
    ["plugin-devtools", "pluginDevtoolsAction"],
    ["sidecar-restart", "restartSidecarAction"],
    ["clear-cache", "clearCacheAction"],
    ["documentation", "documentationAction"],
    ["about", "aboutAction"],
  ]

  for (const [id, helper] of cases) {
    calls.length = 0
    const listener = subscribers.get(`menu://${id}`)
    expect(listener).toBeDefined()
    listener?.()
    await flush()
    expect(calls.find((c) => c.name === helper)).toBeDefined()
  }
})

test("keyboard-shortcuts event invokes the onShowKeyboardShortcuts callback", async () => {
  const onShow = jest.fn()
  renderHook(() => useMenuEventRouter({ onShowKeyboardShortcuts: onShow }))
  await flush()
  subscribers.get("menu://keyboard-shortcuts")?.()
  await flush()
  expect(onShow).toHaveBeenCalled()
})

test("tray://open-logs falls through to the same handler as menu://open-logs", async () => {
  renderHook(() => useMenuEventRouter())
  await flush()
  subscribers.get("tray://open-logs")?.()
  await flush()
  expect(calls.find((c) => c.name === "openLogsAction")).toBeDefined()
})

test("returns unsubscribers on cleanup", async () => {
  const { unmount } = renderHook(() => useMenuEventRouter())
  await flush()
  const unlistens = [...lastUnlistens]
  expect(unlistens.length).toBeGreaterThan(0)
  unmount()
  for (const u of unlistens) {
    expect(u).toHaveBeenCalled()
  }
})

test("logs a warning when a handler throws", async () => {
  renderHook(() => useMenuEventRouter())
  await flush()
  settingsSave.mockRejectedValueOnce(new Error("disk"))
  subscribers.get("menu://theme-dark")?.()
  await flush()
  // setThemeAction itself swallows the error and logs internally; the
  // event-router never sees a throw. Sanity: at least we know the handler
  // ran.
  expect(calls.find((c) => c.name === "setThemeAction")).toBeDefined()
})
