/**
 * @jest-environment jsdom
 */

const transportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
  isTauri: jest.fn(() => true),
}))

const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const openExternal = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}))

const openDialog = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}))

const winClose = jest.fn().mockResolvedValue(undefined)
const winIsFullscreen = jest.fn().mockResolvedValue(false)
const winSetFullscreen = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: winClose,
    isFullscreen: winIsFullscreen,
    setFullscreen: winSetFullscreen,
  }),
}))

const chatClear = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ clear: chatClear }) },
}))

const setSelectedGuild = jest.fn()
const toggleSidebar = jest.fn()
const toggleGuildRail = jest.fn()
const toggleStatusBar = jest.fn()
const requestCreate = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: {
    getState: () => ({
      setSelectedGuild,
      toggleSidebar,
      toggleGuildRail,
      toggleStatusBar,
      requestCreate,
    }),
  },
}))

const settingsSave = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ save: settingsSave }) },
}))

const killSwitch = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/automation/client", () => ({
  desktop: { killSwitch: () => killSwitch() },
}))

const openVsxClear = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ openVsxCache: { clear: openVsxClear } }),
}))

const listSessionsMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
}))

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()
jest.mock("@/lib/logging", () => ({
  loggers: {
    ui: {
      info: (...a: unknown[]) => logInfo(...a),
      warn: (...a: unknown[]) => logWarn(...a),
      error: (...a: unknown[]) => logError(...a),
    },
  },
}))

import {
  MENU_ACTION_IDS,
  GO_ROUTES,
  newChatAction,
  newWorkflowAction,
  newAgentTeamAction,
  newCharacterAction,
  openWorkspaceAction,
  openSettingsAction,
  openLogsAction,
  quitAction,
  loadRecentSessions,
  commandPaletteAction,
  toggleSidebarAction,
  toggleGuildRailAction,
  toggleStatusBarAction,
  reloadAction,
  toggleFullscreenAction,
  setThemeAction,
  setLanguageAction,
  toggleReduceMotionAction,
  goAction,
  automationKillSwitchAction,
  manageConnectorsAction,
  manageMcpServerAction,
  pluginDevtoolsAction,
  restartSidecarAction,
  clearCacheAction,
  documentationAction,
  aboutAction,
  verifyMenuActionParity,
} from "./menu-actions"

const router = { push: jest.fn() } as unknown as Parameters<typeof goAction>[0]

beforeEach(() => {
  transportCall.mockReset().mockResolvedValue(undefined)
  invokeMock.mockReset()
  openExternal.mockClear().mockResolvedValue(undefined)
  openDialog.mockReset().mockResolvedValue(null)
  winClose.mockClear().mockResolvedValue(undefined)
  winIsFullscreen.mockClear().mockResolvedValue(false)
  winSetFullscreen.mockClear().mockResolvedValue(undefined)
  chatClear.mockClear()
  setSelectedGuild.mockClear()
  toggleSidebar.mockClear()
  toggleGuildRail.mockClear()
  toggleStatusBar.mockClear()
  requestCreate.mockClear()
  settingsSave.mockClear().mockResolvedValue(undefined)
  killSwitch.mockClear().mockResolvedValue(undefined)
  openVsxClear.mockClear().mockResolvedValue(undefined)
  listSessionsMock.mockReset().mockResolvedValue([])
  logInfo.mockReset()
  logWarn.mockReset()
  logError.mockReset()
  ;(router.push as jest.Mock).mockClear()
})

test("MENU_ACTION_IDS is a stable list — every id is unique", () => {
  const set = new Set<string>(MENU_ACTION_IDS)
  expect(set.size).toBe(MENU_ACTION_IDS.length)
})

test("GO_ROUTES covers every non-DM/Canvas go-* id", () => {
  const goIds = MENU_ACTION_IDS.filter((id) => id.startsWith("go-"))
  for (const id of goIds) {
    if (id === "go-dms" || id === "go-canvas") continue
    expect(GO_ROUTES[id]).toBeDefined()
  }
})

test("newChatAction clears chat and resets guild", () => {
  newChatAction()
  expect(chatClear).toHaveBeenCalled()
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
})

test("newWorkflowAction requests workflow creation and routes to /workflows", () => {
  newWorkflowAction(router)
  expect(requestCreate).toHaveBeenCalledWith("workflow")
  expect(router.push).toHaveBeenCalledWith("/workflows")
})

test("newAgentTeamAction requests agent-team creation and routes to /agent-teams", () => {
  newAgentTeamAction(router)
  expect(requestCreate).toHaveBeenCalledWith("agentTeam")
  expect(router.push).toHaveBeenCalledWith("/agent-teams")
})

test("newCharacterAction requests character creation and routes to characters tab", () => {
  newCharacterAction(router)
  expect(requestCreate).toHaveBeenCalledWith("character")
  expect(router.push).toHaveBeenCalledWith("/settings?section=characters")
})

test("openWorkspaceAction persists the picked directory", async () => {
  openDialog.mockResolvedValueOnce("/picked")
  await openWorkspaceAction()
  expect(settingsSave).toHaveBeenCalledWith({ defaultWorkingDir: "/picked" })
})

test("openWorkspaceAction logs a warning when the dialog throws", async () => {
  openDialog.mockRejectedValueOnce(new Error("nope"))
  await openWorkspaceAction()
  expect(logWarn).toHaveBeenCalledWith(
    "menu action open-workspace failed",
    expect.objectContaining({ error: "nope" })
  )
})

test("openWorkspaceAction tolerates non-Error rejection", async () => {
  openDialog.mockRejectedValueOnce("plain")
  await openWorkspaceAction()
  expect(logWarn).toHaveBeenCalledWith(
    "menu action open-workspace failed",
    expect.objectContaining({ error: "plain" })
  )
})

test("openWorkspaceAction skips save when the user cancels", async () => {
  openDialog.mockResolvedValueOnce(null)
  await openWorkspaceAction()
  expect(settingsSave).not.toHaveBeenCalled()
})

test("openSettingsAction routes to /settings without a section", () => {
  openSettingsAction(router)
  expect(router.push).toHaveBeenCalledWith("/settings")
})

test("openSettingsAction routes to /settings with a section query", () => {
  openSettingsAction(router, "about")
  expect(router.push).toHaveBeenCalledWith("/settings?section=about")
})

test("openLogsAction routes to /logs", () => {
  openLogsAction(router)
  expect(router.push).toHaveBeenCalledWith("/logs")
})

test("quitAction closes the active window", async () => {
  await quitAction()
  expect(winClose).toHaveBeenCalled()
})

test("quitAction warns when the window API throws", async () => {
  winClose.mockRejectedValueOnce(new Error("denied"))
  await quitAction()
  expect(logWarn).toHaveBeenCalledWith(
    "menu action quit failed",
    expect.objectContaining({ error: "denied" })
  )
})

test("loadRecentSessions caps result count at limit", async () => {
  listSessionsMock.mockResolvedValueOnce([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }])
  const result = await loadRecentSessions(2)
  expect(result.map((s) => s.id)).toEqual(["1", "2"])
})

test("loadRecentSessions returns [] when the Dexie call throws", async () => {
  listSessionsMock.mockRejectedValueOnce(new Error("io"))
  const result = await loadRecentSessions(5)
  expect(result).toEqual([])
  expect(logWarn).toHaveBeenCalled()
})

test("commandPaletteAction dispatches Ctrl+K", () => {
  const seen: KeyboardEvent[] = []
  const listener = (e: Event) => seen.push(e as KeyboardEvent)
  window.addEventListener("keydown", listener)
  try {
    commandPaletteAction()
    expect(seen.some((e) => e.key === "k" && e.ctrlKey)).toBe(true)
  } finally {
    window.removeEventListener("keydown", listener)
  }
})

test("toggleSidebarAction / toggleGuildRailAction / toggleStatusBarAction call store toggles", () => {
  toggleSidebarAction()
  toggleGuildRailAction()
  toggleStatusBarAction()
  expect(toggleSidebar).toHaveBeenCalled()
  expect(toggleGuildRail).toHaveBeenCalled()
  expect(toggleStatusBar).toHaveBeenCalled()
})

test("reloadAction logs the action (window.location.reload is unmockable in jsdom)", () => {
  // jsdom's window.location is locked from reassignment and its `reload`
  // property is non-writable, so we can't assert on the actual call. We
  // verify that the action ran by checking the log line it emits right
  // before the reload() call — close enough for coverage.
  expect(() => reloadAction()).not.toThrow()
  expect(logInfo).toHaveBeenCalledWith("menu action reload")
})

test("toggleFullscreenAction flips fullscreen", async () => {
  winIsFullscreen.mockResolvedValueOnce(false)
  await toggleFullscreenAction()
  expect(winSetFullscreen).toHaveBeenCalledWith(true)
})

test("toggleFullscreenAction logs error when the API throws", async () => {
  winIsFullscreen.mockRejectedValueOnce(new Error("denied"))
  await toggleFullscreenAction()
  expect(logError).toHaveBeenCalledWith("menu action toggle-fullscreen failed", expect.any(Error))
})

test("setThemeAction calls setTheme and persists the new theme", async () => {
  const setTheme = jest.fn()
  await setThemeAction(setTheme, settingsSave, "dark")
  expect(setTheme).toHaveBeenCalledWith("dark")
  expect(settingsSave).toHaveBeenCalledWith({ theme: "dark" })
})

test("setThemeAction warns when persistence throws", async () => {
  const setTheme = jest.fn()
  settingsSave.mockRejectedValueOnce(new Error("disk"))
  await setThemeAction(setTheme, settingsSave, "light")
  expect(logWarn).toHaveBeenCalledWith(
    "menu action set-theme persist failed",
    expect.objectContaining({ error: "disk" })
  )
})

test("setLanguageAction persists the language", async () => {
  await setLanguageAction(settingsSave, "zh-CN")
  expect(settingsSave).toHaveBeenCalledWith({ language: "zh-CN" })
})

test("setLanguageAction warns when persistence throws", async () => {
  settingsSave.mockRejectedValueOnce(new Error("denied"))
  await setLanguageAction(settingsSave, "en")
  expect(logWarn).toHaveBeenCalledWith(
    "menu action set-language persist failed",
    expect.objectContaining({ error: "denied" })
  )
})

test("toggleReduceMotionAction flips the current value", async () => {
  await toggleReduceMotionAction(false, settingsSave)
  expect(settingsSave).toHaveBeenCalledWith({ reduceMotion: true })
})

test("toggleReduceMotionAction warns when persistence throws", async () => {
  settingsSave.mockRejectedValueOnce(new Error("io"))
  await toggleReduceMotionAction(false, settingsSave)
  expect(logWarn).toHaveBeenCalledWith(
    "menu action toggle-reduce-motion persist failed",
    expect.objectContaining({ error: "io" })
  )
})

test("goAction routes static destinations", () => {
  goAction(router, "go-twin")
  expect(router.push).toHaveBeenCalledWith("/twin")
  goAction(router, "go-logs")
  expect(router.push).toHaveBeenCalledWith("/logs")
  goAction(router, "go-a2ui")
  expect(router.push).toHaveBeenCalledWith("/a2ui")
})

test("goAction handles go-dms by switching guild and routing to /", () => {
  goAction(router, "go-dms")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  expect(router.push).toHaveBeenCalledWith("/")
})

test("goAction handles go-canvas by switching guild and routing to /", () => {
  goAction(router, "go-canvas")
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
  expect(router.push).toHaveBeenCalledWith("/")
})

test("goAction is a no-op for ids without a route entry", () => {
  // Passing a non-go id never matches; nothing should happen.
  goAction(router, "new-chat")
  expect(router.push).not.toHaveBeenCalled()
})

test("automationKillSwitchAction invokes the automation client", async () => {
  await automationKillSwitchAction()
  expect(killSwitch).toHaveBeenCalled()
})

test("manageConnectorsAction routes to connections settings tab", () => {
  manageConnectorsAction(router)
  expect(router.push).toHaveBeenCalledWith("/settings?section=connections")
})

test("manageMcpServerAction routes to external-bridge settings", () => {
  manageMcpServerAction(router)
  expect(router.push).toHaveBeenCalledWith("/settings?section=external-bridge")
})

test("pluginDevtoolsAction routes to the plugins settings tab", () => {
  pluginDevtoolsAction(router)
  expect(router.push).toHaveBeenCalledWith("/settings?section=plugins")
})

test("restartSidecarAction invokes claude_restart_sidecar", async () => {
  await restartSidecarAction()
  expect(transportCall).toHaveBeenCalledWith("claude_restart_sidecar", {})
})

test("clearCacheAction wipes openVsxCache and Service Worker caches", async () => {
  const cachesDelete = jest.fn().mockResolvedValue(true)
  ;(
    globalThis as unknown as {
      caches: { keys: () => Promise<string[]>; delete: typeof cachesDelete }
    }
  ).caches = {
    keys: () => Promise.resolve(["a", "b"]),
    delete: cachesDelete,
  }
  await clearCacheAction()
  expect(openVsxClear).toHaveBeenCalled()
  expect(cachesDelete).toHaveBeenCalledTimes(2)
})

test("clearCacheAction reports partial failures via thrown error", async () => {
  openVsxClear.mockRejectedValueOnce(new Error("io"))
  ;(
    globalThis as unknown as { caches: { keys: () => Promise<string[]>; delete: jest.Mock } }
  ).caches = {
    keys: () => Promise.resolve([]),
    delete: jest.fn(),
  }
  await expect(clearCacheAction()).rejects.toThrow(/openVsxCache/)
})

test("documentationAction opens the docs URL through the opener helper", async () => {
  await documentationAction()
  expect(openExternal).toHaveBeenCalledWith("https://v2.tauri.app")
})

test("documentationAction logs an error when the opener throws", async () => {
  openExternal.mockRejectedValueOnce(new Error("blocked"))
  await documentationAction()
  expect(logError).toHaveBeenCalledWith("menu action documentation failed", expect.any(Error))
})

test("aboutAction routes to settings about section", () => {
  aboutAction(router)
  expect(router.push).toHaveBeenCalledWith("/settings?section=about")
})

describe("verifyMenuActionParity", () => {
  test("returns an empty diff when Rust returns every renderer id (sans renderer-only ones)", async () => {
    const rustIds = MENU_ACTION_IDS.filter(
      (id) =>
        !["quit", "about", "toggle-fullscreen", "zoom-in", "zoom-out", "zoom-reset"].includes(id)
    )
    invokeMock.mockResolvedValueOnce(rustIds)
    const report = await verifyMenuActionParity()
    expect(invokeMock).toHaveBeenCalledWith("menu_action_ids")
    expect(report).toEqual({ missingInRust: [], missingInRenderer: [] })
  })

  test("reports renderer ids missing on the Rust side", async () => {
    // Rust list is missing `go-twin` (vs the renderer's MENU_ACTION_IDS).
    const rustIds = MENU_ACTION_IDS.filter(
      (id) =>
        id !== "go-twin" &&
        !["quit", "about", "toggle-fullscreen", "zoom-in", "zoom-out", "zoom-reset"].includes(id)
    )
    invokeMock.mockResolvedValueOnce(rustIds)
    const report = await verifyMenuActionParity()
    expect(report?.missingInRust).toEqual(["go-twin"])
    expect(report?.missingInRenderer).toEqual([])
  })

  test("reports Rust ids the renderer hasn't learned yet", async () => {
    const rustIds = [...MENU_ACTION_IDS, "future-rust-only-id"]
    invokeMock.mockResolvedValueOnce(rustIds)
    const report = await verifyMenuActionParity()
    expect(report?.missingInRust).toEqual([])
    expect(report?.missingInRenderer).toEqual(["future-rust-only-id"])
  })

  test("returns null when the IPC call rejects (skip-the-check signal)", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not in tauri"))
    const report = await verifyMenuActionParity()
    expect(report).toBeNull()
  })

  test("returns null when Rust returns a non-array (defensive)", async () => {
    invokeMock.mockResolvedValueOnce({ not: "an array" } as unknown)
    const report = await verifyMenuActionParity()
    expect(report).toBeNull()
  })
})
