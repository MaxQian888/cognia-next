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

const startNewSessionMock = jest.fn().mockResolvedValue({ id: "s-new" })
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))

const isMainAppWindowMock = jest.fn(() => true)
jest.mock("@/lib/pet/window-role", () => ({
  isMainAppWindow: () => isMainAppWindowMock(),
}))

const setSelectedGuild = jest.fn()
const toggleSidebar = jest.fn()
const toggleGuildRail = jest.fn()
const toggleStatusBar = jest.fn()
const requestCreate = jest.fn()
const requestChatHome = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: {
    getState: () => ({
      requestChatHome,
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

const openFolderAsWorkspace = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/workspace/open-folder", () => ({
  openFolderAsWorkspace: (...args: unknown[]) => openFolderAsWorkspace(...args),
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
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...a: unknown[]) => logInfo(...a),
      warn: (...a: unknown[]) => logWarn(...a),
      error: (...a: unknown[]) => logError(...a),
    },
  },
}))

import { readFileSync } from "fs"
import { join } from "path"

import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

import { GO_MENU_SECTIONS } from "./go-menu"
import {
  MENU_ACTION_IDS,
  MENU_COMMAND_IDS,
  GO_MENU_IDS,
  GO_ROUTES,
  RENDERER_ONLY_IDS,
  RUST_ONLY_IDS,
  isGoMenuId,
  newChatAction,
  newWorkflowAction,
  newAgentTeamAction,
  newAgentAction,
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
  startNewSessionMock.mockClear()
  isMainAppWindowMock.mockClear().mockReturnValue(true)
  setSelectedGuild.mockClear()
  toggleSidebar.mockClear()
  toggleGuildRail.mockClear()
  toggleStatusBar.mockClear()
  requestCreate.mockClear()
  requestChatHome.mockClear()
  settingsSave.mockClear().mockResolvedValue(undefined)
  openFolderAsWorkspace.mockReset().mockResolvedValue(null)
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

test("GO_MENU_IDS is one go-<id> per catalog entry plus DMs / Canvas / Settings", () => {
  expect([...GO_MENU_IDS].sort()).toEqual(
    [
      ...SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`),
      "go-dms",
      "go-canvas",
      "go-settings",
    ].sort()
  )
})

test("GO_MENU_IDS is the Go-menu table's ids, in menu order", () => {
  expect(GO_MENU_IDS).toEqual(GO_MENU_SECTIONS.flatMap((section) => section.map((item) => item.id)))
})

test("GO_MENU_IDS keeps every id the menus and accelerators already use", () => {
  expect(GO_MENU_IDS).toEqual(
    expect.arrayContaining([
      "go-inbox",
      "go-workflows",
      "go-sites",
      "go-twin",
      "go-skills",
      "go-plugins",
      "go-squads",
      "go-scheduler",
      "go-discover",
      "go-a2ui",
      "go-logs",
      "go-settings",
      "go-dms",
      "go-canvas",
    ])
  )
  // Destinations the hand-kept list used to miss, `issues` being a default pin.
  expect(GO_MENU_IDS).toEqual(
    expect.arrayContaining(["go-issues", "go-goals", "go-templates", "go-memory", "go-bots"])
  )
})

test("MENU_ACTION_IDS is the command ids followed by the go ids, with no go id hand-listed", () => {
  expect(MENU_ACTION_IDS).toEqual([...MENU_COMMAND_IDS, ...GO_MENU_IDS])
  expect(MENU_COMMAND_IDS.filter((id) => id.startsWith("go-"))).toEqual([])
})

test("GO_ROUTES maps every non-DM/Canvas go id to its catalog route", () => {
  for (const meta of SIDEBAR_NAV_META) {
    const id = `go-${meta.id}`
    expect(GO_ROUTES[id]).toBe(id === "go-inbox" ? "/inbox/all" : meta.route)
  }
  expect(GO_ROUTES["go-settings"]).toBe("/settings")
  expect(GO_ROUTES["go-dms"]).toBeUndefined()
  expect(GO_ROUTES["go-canvas"]).toBeUndefined()
  for (const id of GO_MENU_IDS) {
    if (id === "go-dms" || id === "go-canvas") continue
    expect(GO_ROUTES[id]).toBeDefined()
  }
})

test("isGoMenuId accepts exactly the go ids", () => {
  for (const id of GO_MENU_IDS) expect(isGoMenuId(id)).toBe(true)
  expect(isGoMenuId("go-agent-teams")).toBe(false)
  expect(isGoMenuId("go-")).toBe(false)
  expect(isGoMenuId("new-chat")).toBe(false)
})

// Rust broadcasts menu:// / tray:// to every window, and the pet overlay /
// popup / island load the same root layout. Creating a session is not
// idempotent, so a secondary window acting on it would double-create.
test("newChatAction is a no-op outside the main window", () => {
  isMainAppWindowMock.mockReturnValue(false)
  newChatAction()
  expect(requestChatHome).not.toHaveBeenCalled()
  expect(startNewSessionMock).not.toHaveBeenCalled()
})

// The conversation is only created when the user sends from the welcome
// surface, so the menu action itself never starts a session.
test("newChatAction requests the DM welcome surface without creating a session", () => {
  newChatAction()
  expect(requestChatHome).toHaveBeenCalledWith({ kind: "dm" })
  expect(startNewSessionMock).not.toHaveBeenCalled()
})

test("newWorkflowAction requests workflow creation and routes to /workflows", () => {
  newWorkflowAction(router)
  expect(requestCreate).toHaveBeenCalledWith("workflow")
  expect(router.push).toHaveBeenCalledWith("/workflows")
})

test("newAgentTeamAction requests Squad creation and routes to /squads", () => {
  newAgentTeamAction(router)
  expect(requestCreate).toHaveBeenCalledWith("agentTeam")
  expect(router.push).toHaveBeenCalledWith("/settings?section=squads")
})

test("newAgentAction opens the agents console's create chooser", () => {
  newAgentAction(router)
  expect(router.push).toHaveBeenCalledWith("/agents?new=1")
  expect(requestCreate).not.toHaveBeenCalled()
})

test("openWorkspaceAction creates/activates a workspace via the unified flow", async () => {
  openFolderAsWorkspace.mockResolvedValueOnce({ id: "p1" })
  await openWorkspaceAction()
  expect(openFolderAsWorkspace).toHaveBeenCalledTimes(1)
  expect(settingsSave).not.toHaveBeenCalled()
})

test("openWorkspaceAction logs a warning when the flow throws", async () => {
  openFolderAsWorkspace.mockRejectedValueOnce(new Error("nope"))
  await openWorkspaceAction()
  expect(logWarn).toHaveBeenCalledWith(
    "menu action open-workspace failed",
    expect.objectContaining({ error: "nope" })
  )
})

test("openWorkspaceAction tolerates non-Error rejection", async () => {
  openFolderAsWorkspace.mockRejectedValueOnce("plain")
  await openWorkspaceAction()
  expect(logWarn).toHaveBeenCalledWith(
    "menu action open-workspace failed",
    expect.objectContaining({ error: "plain" })
  )
})

test("openWorkspaceAction tolerates a cancelled picker (null result)", async () => {
  openFolderAsWorkspace.mockResolvedValueOnce(null)
  await openWorkspaceAction()
  expect(logWarn).not.toHaveBeenCalled()
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

test("loadRecentSessions excludes embedded workbench threads", async () => {
  listSessionsMock.mockResolvedValueOnce([
    { id: "resource", kind: "resource-workbench", visibility: "embedded" },
    { id: "ordinary", kind: "direct" },
  ])
  const result = await loadRecentSessions(8)
  expect(result.map((session) => session.id)).toEqual(["ordinary"])
})

test("loadRecentSessions returns [] when the Dexie call throws", async () => {
  listSessionsMock.mockRejectedValueOnce(new Error("io"))
  const result = await loadRecentSessions(5)
  expect(result).toEqual([])
  expect(logWarn).toHaveBeenCalled()
})

test("commandPaletteAction asks the palette through the request seam (no forged keystroke)", () => {
  const seen: Event[] = []
  const requests: Event[] = []
  const keyListener = (e: Event) => seen.push(e)
  const requestListener = (e: Event) => requests.push(e)
  window.addEventListener("keydown", keyListener)
  window.addEventListener("cognia:command-palette:request", requestListener)
  try {
    commandPaletteAction()
    expect(requests).toHaveLength(1)
    expect(seen).toHaveLength(0)
  } finally {
    window.removeEventListener("keydown", keyListener)
    window.removeEventListener("cognia:command-palette:request", requestListener)
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
  goAction(router, "go-sites")
  expect(router.push).toHaveBeenCalledWith("/sites")
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

test("goAction routes catalog destinations the old hand-kept map missed", () => {
  goAction(router, "go-issues")
  expect(router.push).toHaveBeenLastCalledWith("/issues")
  goAction(router, "go-agent-runs")
  expect(router.push).toHaveBeenLastCalledWith("/agent-runs")
  goAction(router, "go-devices")
  expect(router.push).toHaveBeenLastCalledWith("/devices")
})

test("goAction keeps go-inbox on /inbox/all and go-settings on /settings", () => {
  goAction(router, "go-inbox")
  expect(router.push).toHaveBeenLastCalledWith("/inbox/all")
  goAction(router, "go-settings")
  expect(router.push).toHaveBeenLastCalledWith("/settings")
})

test("goAction is a no-op for ids without a route entry", () => {
  // Passing a non-go id never matches; nothing should happen.
  goAction(router, "new-chat")
  // Spelled like a go id but not a destination (the retired Rust spelling).
  goAction(router, "go-agent-teams")
  expect(router.push).not.toHaveBeenCalled()
  expect(setSelectedGuild).not.toHaveBeenCalled()
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

  test("does not report the Rust-only toggle-devtools as drift", async () => {
    const rustIds = [
      ...MENU_ACTION_IDS.filter((id) => !RENDERER_ONLY_IDS.has(id)),
      "toggle-devtools",
    ]
    invokeMock.mockResolvedValueOnce(rustIds)
    const report = await verifyMenuActionParity()
    expect(report).toEqual({ missingInRust: [], missingInRenderer: [] })
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

/**
 * Parity with the Rust side without running Tauri: parse the `MENU_IDS`
 * array out of `src-tauri/src/commands.rs` and the Go table out of
 * `src-tauri/src/menu.rs`. `verifyMenuActionParity` only runs inside the
 * desktop shell, so without this a renamed or missing id (the old
 * `go-agent-teams` vs `go-squads`) would only surface as a dead menu item.
 */
describe("Rust menu parity (source-parsed)", () => {
  const tauriSrc = join(__dirname, "..", "..", "src-tauri", "src")

  function quotedIdsIn(block: string): string[] {
    const withoutComments = block
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n")
    return [...withoutComments.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  }

  function rustMenuIds(): string[] {
    const source = readFileSync(join(tauriSrc, "commands.rs"), "utf8")
    const match = source.match(/pub const MENU_IDS: &\[&str\] = &\[([\s\S]*?)\n\];/)
    if (!match) throw new Error("MENU_IDS array not found in src-tauri/src/commands.rs")
    return quotedIdsIn(match[1])
  }

  /** `GO_MENU_SECTIONS` out of `menu.rs`, as sections of `[id, English label]`. */
  function rustGoMenuSections(): [string, string][][] {
    const source = readFileSync(join(tauriSrc, "menu.rs"), "utf8")
    const match = source.match(/const GO_MENU_SECTIONS: [^=]+= &\[([\s\S]*?)\n\];/)
    if (!match) throw new Error("GO_MENU_SECTIONS table not found in src-tauri/src/menu.rs")
    // Each section is `&[ ... ]`; each entry is `("go-…", "Label")`.
    return [...match[1].matchAll(/&\[([\s\S]*?)\]/g)].map((section) =>
      [...section[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/g)].map(
        (entry): [string, string] => [entry[1], entry[2]]
      )
    )
  }

  function rustGoMenuTableIds(): string[] {
    return rustGoMenuSections().flatMap((section) => section.map(([id]) => id))
  }

  test("Rust MENU_IDS has no duplicates", () => {
    const ids = rustMenuIds()
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("Rust MENU_IDS go ids equal the renderer's GO_MENU_IDS", () => {
    const rustGo = rustMenuIds().filter((id) => id.startsWith("go-"))
    expect([...rustGo].sort()).toEqual([...GO_MENU_IDS].sort())
  })

  test("the native Go submenu builds exactly the renderer's go ids", () => {
    expect([...rustGoMenuTableIds()].sort()).toEqual([...GO_MENU_IDS].sort())
  })

  test("the native Go submenu has the renderer's ids in the same order and sections", () => {
    expect(rustGoMenuSections().map((section) => section.map(([id]) => id))).toEqual(
      GO_MENU_SECTIONS.map((section) => section.map((item) => item.id))
    )
  })

  test("the native Go submenu's labels are the rail's English labels", () => {
    const en = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "i18n", "messages", "en", "desktop.json"), "utf8")
    ) as { guildRail: Record<string, unknown> }
    const labelKeyById = new Map<string, string>(
      GO_MENU_SECTIONS.flatMap((section) =>
        section.map((item): [string, string] => [item.id, item.labelKey])
      )
    )
    for (const [id, label] of rustGoMenuSections().flat()) {
      const labelKey = labelKeyById.get(id)
      expect(labelKey).toBeDefined()
      expect([id, label]).toEqual([id, en.guildRail[labelKey as string]])
    }
  })

  test("no native Go item binds an accelerator", () => {
    const source = readFileSync(join(tauriSrc, "menu.rs"), "utf8")
    const goBuilder = source.slice(
      source.indexOf("// -------------------- Go --------------------"),
      source.indexOf("// -------------------- Tools --------------------")
    )
    expect(goBuilder).toContain("GO_MENU_SECTIONS")
    expect(goBuilder).not.toContain(".accelerator(")
    expect(source).not.toMatch(/"go-[a-z0-9-]+"\s*,\s*"[^"]*"\s*,/)
  })

  test("the whole Rust list matches the renderer, minus each side's documented exclusives", () => {
    const rust = rustMenuIds()
    const rustOnly = rust.filter((id) => !(MENU_ACTION_IDS as readonly string[]).includes(id))
    expect(rustOnly).toEqual([...RUST_ONLY_IDS])
    const rendererExpected = MENU_ACTION_IDS.filter((id) => !RENDERER_ONLY_IDS.has(id))
    expect([...rust.filter((id) => !RUST_ONLY_IDS.has(id))].sort()).toEqual(
      [...rendererExpected].sort()
    )
  })

  test("verifyMenuActionParity reports no drift against the real Rust list", async () => {
    invokeMock.mockResolvedValueOnce(rustMenuIds())
    await expect(verifyMenuActionParity()).resolves.toEqual({
      missingInRust: [],
      missingInRenderer: [],
    })
  })
})
