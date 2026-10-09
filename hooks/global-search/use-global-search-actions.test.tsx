/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

import type { GlobalSearchItem } from "@/lib/global-search/types"

const push = jest.fn()
const setTheme = jest.fn()
const toast = { success: jest.fn(), info: jest.fn(), error: jest.fn() }
const jump = jest.fn()
const revealPanel = jest.fn()
const runQuickAction = jest.fn()
const getQuickAction = jest.fn()
const openFolder = jest.fn()
const checkForUpdate = jest.fn()
const openRecorder = jest.fn()
const clearMessages = jest.fn()
const recordRecentItem = jest.fn()
const clearAllRecents = jest.fn()
const isTauriMock = jest.fn(() => true)
const toggleDesktopPetWindow = jest.fn(async () => true)
const trackEvent = jest.fn(async () => true)
const pinSidebarItem = jest.fn(async (_id: string) => undefined)
const unpinSidebarItem = jest.fn(async (_id: string) => undefined)
const hideSidebarItem = jest.fn(async (_id: string) => undefined)
const toggleGuildRailAction = jest.fn()
const saveSettings = jest.fn(async (_patch: Record<string, unknown>) => undefined)
const settingsState: { settings: { sidebarSide?: "left" | "right" } | null } = { settings: {} }
let mockPathname: string | null = "/inbox/c"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}))
// The desktop catalog: every rail destination, whatever the snapshot says.
jest.mock("@/lib/platform/detect", () => ({ detectPlatform: () => "tauri" }))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => ({
    target: null,
    vaultState: "unavailable",
    connectionState: "offline",
  }),
}))
jest.mock("@/components/shell/use-sidebar-layout", () => ({
  pinSidebarItem: (id: string) => pinSidebarItem(id),
  unpinSidebarItem: (id: string) => unpinSidebarItem(id),
  hideSidebarItem: (id: string) => hideSidebarItem(id),
}))
jest.mock("@/lib/desktop/menu-actions", () => ({
  toggleGuildRailAction: () => toggleGuildRailAction(),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      ...settingsState,
      save: (patch: Record<string, unknown>) => saveSettings(patch),
    }),
  },
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...(args as [])),
}))
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme }) }))
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    info: (...a: unknown[]) => toast.info(...a),
    error: (...a: unknown[]) => toast.error(...a),
  },
}))
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
jest.mock("@/components/ai-elements/conversation", () => ({
  messagesToMarkdown: () => "# md",
}))
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...a: unknown[]) => jump(...a),
}))
jest.mock("@/lib/claude/guild", () => ({
  guildFromSession: (s: { teamId?: string }) =>
    s.teamId ? { kind: "team", teamId: s.teamId } : { kind: "dm" },
}))
jest.mock("@/lib/context-workbench/active-context", () => ({
  revealActiveWorkbenchPanel: (...a: unknown[]) => revealPanel(...a),
}))
jest.mock("@/lib/global-search/recents", () => ({
  recordRecentItem: (...a: unknown[]) => recordRecentItem(...a),
  clearAllGlobalSearchRecents: (...a: unknown[]) => clearAllRecents(...a),
}))
jest.mock("@/lib/plugin/registries/quick-action-registry", () => ({
  runQuickAction: (...a: unknown[]) => runQuickAction(...a),
  getQuickAction: (...a: unknown[]) => getQuickAction(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
jest.mock("@/lib/pet/commands", () => ({
  toggleDesktopPetWindow: () => toggleDesktopPetWindow(),
}))
jest.mock("@/lib/tauri/updater", () => ({
  checkForUpdate: (...a: unknown[]) => checkForUpdate(...a),
}))
jest.mock("@/lib/workspace/open-folder", () => ({
  openFolderAsWorkspace: (...a: unknown[]) => openFolder(...a),
}))
jest.mock("@/stores/skills/recorder-store", () => ({
  openRecorder: (...a: unknown[]) => openRecorder(...a),
}))
jest.mock("@/lib/db/messages", () => ({ clearMessages: (...a: unknown[]) => clearMessages(...a) }))

const chatState = {
  messages: [] as unknown[],
  activeSessionId: "s1" as string | null,
  replaceMessages: jest.fn(),
}
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => chatState } }))
const projectState = { activeProjectId: "p1", setActiveProject: jest.fn() }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => projectState },
}))
const uiState = { setSelectedGuild: jest.fn(), toggleSidebar: jest.fn(), guildRailCollapsed: false }
jest.mock("@/stores/ui", () => ({ useUIStore: { getState: () => uiState } }))

import { focusSession, useGlobalSearchActions } from "./use-global-search-actions"
import { onComposerReferenceRequest } from "@/lib/chat/composer-reference-request"
import { onWorkspaceDialogRequest } from "@/lib/workspace/workspace-dialog-request"

const sessions = [
  { id: "s1", title: "A", projectId: "p1" },
  { id: "s2", title: "B", projectId: "p2", teamId: "t1" },
] as ChatSession[]

const item = (
  action: GlobalSearchItem["action"],
  over: Partial<GlobalSearchItem> = {}
): GlobalSearchItem => ({
  id: "x",
  kind: "action",
  title: "X",
  score: 1,
  action,
  ...over,
})

function setup(hostOver: Partial<Parameters<typeof useGlobalSearchActions>[0]["host"]> = {}) {
  const host = { onOpenSettings: jest.fn(), ...hostOver }
  const select = jest.fn()
  const create = jest.fn(async () => ({ id: "new" }))
  const close = jest.fn()
  const hook = renderHook(() => useGlobalSearchActions({ host, sessions, select, create, close }))
  return { host, select, create, close, ...hook }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  chatState.messages = []
  chatState.activeSessionId = "s1"
  jump.mockResolvedValue(true)
  runQuickAction.mockResolvedValue(undefined)
  mockPathname = "/inbox/c"
  uiState.guildRailCollapsed = false
  settingsState.settings = {}
})

describe("focusSession", () => {
  it("switches workspace and guild before selecting", () => {
    const select = jest.fn()
    focusSession(sessions[1], "s2", select)
    expect(projectState.setActiveProject).toHaveBeenCalledWith("p2")
    expect(uiState.setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t1" })
    expect(select).toHaveBeenCalledWith("s2")
    focusSession(undefined, "ghost", select)
    expect(select).toHaveBeenLastCalledWith("ghost")
    // Same workspace → no switch.
    projectState.setActiveProject.mockClear()
    focusSession(sessions[0], "s1", select)
    expect(projectState.setActiveProject).not.toHaveBeenCalled()
  })
})

describe("useGlobalSearchActions", () => {
  it("runItem closes, records, and opens a session with a message jump", async () => {
    const { result, close, select } = setup()
    const it = item({ type: "open-session", sessionId: "s2", messageId: "m1" }, { kind: "message" })
    act(() => result.current.runItem(it))
    expect(close).toHaveBeenCalled()
    expect(recordRecentItem).toHaveBeenCalledWith(it)
    // Result kind + action type only — never the row's label or the query.
    expect(trackEvent).toHaveBeenCalledWith("app.search.activated", {
      kind: "message",
      actionType: "open-session",
    })
    expect(select).toHaveBeenCalledWith("s2")
    expect(jump).toHaveBeenCalledWith("s2", "m1", { align: "center" })
    jump.mockResolvedValueOnce(false)
    act(() =>
      result.current.runItem(item({ type: "open-session", sessionId: "s1", messageId: "m2" }))
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("jumpFailed"))
  })

  it("prefers the host's session selector when provided", () => {
    const onSelectSession = jest.fn()
    const { result, select } = setup({ onSelectSession })
    act(() => result.current.runItem(item({ type: "open-session", sessionId: "s1" })))
    expect(onSelectSession).toHaveBeenCalledWith("s1")
    expect(select).not.toHaveBeenCalled()
    expect(jump).not.toHaveBeenCalled()
  })

  it("opens IM conversations in the Inbox route, with the message id when given", async () => {
    const { result, select } = setup()
    await act(() =>
      result.current.runAction({ type: "open-inbox-conversation", conversationKey: "lark:a1:oc 1" })
    )
    expect(push).toHaveBeenLastCalledWith("/inbox/c?key=lark%3Aa1%3Aoc%201")
    await act(() =>
      result.current.runAction({
        type: "open-inbox-conversation",
        conversationKey: "k",
        messageId: "m/1",
      })
    )
    expect(push).toHaveBeenLastCalledWith("/inbox/c?key=k&messageId=m%2F1")
    // The route owns focusing + jumping; the palette does not touch the chat store.
    expect(select).not.toHaveBeenCalled()
    expect(jump).not.toHaveBeenCalled()
  })

  it("routes navigate / settings / panel / workspace / guild / character actions", async () => {
    const { result, host, create, select } = setup()
    await act(() => result.current.runAction({ type: "navigate", href: "/x" }))
    expect(push).toHaveBeenCalledWith("/x")
    await act(() => result.current.runAction({ type: "open-settings", tab: "mcp", focus: "m1" }))
    expect(host.onOpenSettings).toHaveBeenCalledWith("mcp", "m1")
    await act(() => result.current.runAction({ type: "reveal-panel", panelId: "files" }))
    expect(revealPanel).toHaveBeenCalledWith("files")
    await act(() => result.current.runAction({ type: "switch-workspace", projectId: "p9" }))
    expect(projectState.setActiveProject).toHaveBeenCalledWith("p9")
    await act(() => result.current.runAction({ type: "switch-guild", kind: "team", teamId: "t1" }))
    expect(uiState.setSelectedGuild).toHaveBeenLastCalledWith({ kind: "team", teamId: "t1" })
    await act(() => result.current.runAction({ type: "switch-guild", kind: "canvas" }))
    expect(uiState.setSelectedGuild).toHaveBeenLastCalledWith({ kind: "canvas" })
    expect(push).toHaveBeenLastCalledWith("/")
    await act(() => result.current.runAction({ type: "switch-guild", kind: "team" }))
    expect(uiState.setSelectedGuild).toHaveBeenLastCalledWith({ kind: "dm" })
    await act(() =>
      result.current.runAction({
        type: "new-chat-with-character",
        characterId: "c1",
        characterName: "Ada",
      })
    )
    expect(create).toHaveBeenCalledWith({
      title: 'titles.chatWith:{"name":"Ada"}',
      kind: "direct",
      characterId: "c1",
    })
    expect(select).toHaveBeenCalledWith("new")
    const run = jest.fn()
    await act(() => result.current.runAction({ type: "callback", run }))
    expect(run).toHaveBeenCalled()
  })

  it("runs plugin quick actions and tolerates their failure", async () => {
    const { result } = setup()
    const entry = { fullId: "p:a" } as never
    await act(() => result.current.runAction({ type: "quick-action", entry }))
    expect(runQuickAction).toHaveBeenCalledWith(entry)
    runQuickAction.mockRejectedValueOnce(new Error("no"))
    await act(() => result.current.runAction({ type: "quick-action", entry }))
  })

  it("runs every built-in command", async () => {
    const { result, host, create } = setup()
    const run = (id: string) => act(() => result.current.runCommand(id))
    await run("new-chat")
    expect(create).toHaveBeenCalled()
    await run("export-markdown")
    expect(toast.info).toHaveBeenCalledWith("toasts.nothingToExport")
    chatState.messages = [{ id: "m" }]
    const createObjectURL = jest.fn(() => "blob:x")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    await run("export-markdown")
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x")
    click.mockRestore()

    await run("clear-conversation")
    expect(clearMessages).toHaveBeenCalledWith("s1")
    expect(chatState.replaceMessages).toHaveBeenCalledWith([])
    expect(toast.success).toHaveBeenCalledWith("toasts.conversationCleared")
    clearMessages.mockRejectedValueOnce(new Error("locked"))
    await run("clear-conversation")
    expect(toast.error).toHaveBeenCalledWith("locked")
    chatState.activeSessionId = null
    clearMessages.mockClear()
    await run("clear-conversation")
    expect(clearMessages).not.toHaveBeenCalled()

    await run("toggle-theme")
    expect(setTheme).toHaveBeenCalledWith("light")
    expect(saveSettings).toHaveBeenCalledWith({ theme: "light" })
    await run("toggle-sidebar")
    expect(uiState.toggleSidebar).toHaveBeenCalled()
    /*
      All four workspace editors now go through the request seam, because the
      palette closes before running an action and cannot mount what it opens.
      The always-mounted `WorkspaceDialogHost` is what decides native chooser
      vs the picker that walks a paired host's filesystem.
    */
    const dialogRequests: string[] = []
    const stopListening = onWorkspaceDialogRequest(({ kind }) => dialogRequests.push(kind))
    await run("open-folder")
    await run("new-workspace")
    await run("adopt-workspaces")
    await run("manage-workspace-roots")
    stopListening()
    expect(dialogRequests).toEqual(["openFolder", "newWorkspace", "adopt", "manage"])

    await run("open-recorder")
    expect(openRecorder).toHaveBeenCalledWith("palette")

    checkForUpdate.mockResolvedValueOnce(null)
    await run("check-updates")
    expect(toast.success).toHaveBeenCalledWith("toasts.upToDate")
    checkForUpdate.mockResolvedValueOnce({ version: "9.9" })
    await run("check-updates")
    expect(toast.success).toHaveBeenCalledWith('toasts.updateAvailable:{"version":"9.9"}')
    expect(host.onOpenSettings).toHaveBeenCalledWith("about")
    checkForUpdate.mockRejectedValueOnce(new Error("net"))
    await run("check-updates")
    expect(toast.error).toHaveBeenCalledWith('toasts.updateFailed:{"message":"net"}')

    for (const [id, tab] of [
      ["open-settings", "general"],
      ["manage-api-key", "api-key"],
      ["manage-skills", "skills"],
      ["manage-teams", "teams"],
      ["manage-mcp", "mcp"],
    ] as const) {
      await run(id)
      expect(host.onOpenSettings).toHaveBeenLastCalledWith(tab)
    }
    await run("manage-agents")
    expect(push).toHaveBeenLastCalledWith("/agents")
    await run("clear-recent-searches")
    expect(clearAllRecents).toHaveBeenCalled()
    await run("unknown-command")

    // Off the desktop, updates degrade to a toast.
    //
    // The folder picker deliberately does NOT: it asks the dialog host, which
    // opens the native chooser on the desktop and the host-filesystem picker on
    // a paired client. Refusing here is what made the palette contradict the
    // workspace switcher on the same device.
    isTauriMock.mockReturnValue(false)
    checkForUpdate.mockClear()
    const offDesktopRequests: string[] = []
    const stopOffDesktop = onWorkspaceDialogRequest(({ kind }) => offDesktopRequests.push(kind))
    await run("open-folder")
    stopOffDesktop()
    expect(offDesktopRequests).toEqual(["openFolder"])
    await run("check-updates")
    expect(toast.info).toHaveBeenCalledWith("toasts.updatesDesktopOnly")
    expect(checkForUpdate).not.toHaveBeenCalled()
  })

  describe("navigation customization", () => {
    it("pins, unpins and hides the page the route is on, naming it in the toast", async () => {
      const { result } = setup()
      await act(() => result.current.runCommand("pin-current-page"))
      // `/inbox/c` is Inbox by the rail's prefix rule.
      expect(pinSidebarItem).toHaveBeenCalledWith("inbox")
      expect(toast.success).toHaveBeenLastCalledWith('toasts.pagePinned:{"page":"inbox"}')
      await act(() => result.current.runCommand("unpin-current-page"))
      expect(unpinSidebarItem).toHaveBeenCalledWith("inbox")
      expect(toast.success).toHaveBeenLastCalledWith('toasts.pageUnpinned:{"page":"inbox"}')
      await act(() => result.current.runCommand("hide-current-page"))
      expect(hideSidebarItem).toHaveBeenCalledWith("inbox")
      expect(toast.success).toHaveBeenLastCalledWith('toasts.pageHidden:{"page":"inbox"}')
    })

    it("resolves the page when it runs, so a replayed recent acts on the page in front", async () => {
      mockPathname = "/source-control"
      const { result } = setup()
      act(() => result.current.runStoredAction({ type: "command", id: "pin-current-page" }))
      await waitFor(() => expect(pinSidebarItem).toHaveBeenCalledWith("source-control"))
      // Labelled through the i18n key, which differs from the id here.
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('toasts.pagePinned:{"page":"sourceControl"}')
      )
    })

    it("says so, and writes nothing, off every catalog route", async () => {
      for (const path of ["/", "/settings", null]) {
        mockPathname = path
        const { result } = setup()
        await act(() => result.current.runCommand("hide-current-page"))
      }
      expect(hideSidebarItem).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledTimes(3)
      expect(toast.info).toHaveBeenLastCalledWith("toasts.noNavigationPage")
    })

    it("surfaces a failed layout write", async () => {
      unpinSidebarItem.mockRejectedValueOnce(new Error("disk full"))
      const { result } = setup()
      await act(() => result.current.runCommand("unpin-current-page"))
      expect(toast.error).toHaveBeenCalledWith(
        'toasts.navigationUpdateFailed:{"message":"disk full"}'
      )
      expect(toast.success).not.toHaveBeenCalled()
      hideSidebarItem.mockRejectedValueOnce("nope")
      await act(() => result.current.runCommand("hide-current-page"))
      expect(toast.error).toHaveBeenLastCalledWith(
        'toasts.navigationUpdateFailed:{"message":"nope"}'
      )
    })

    it("opens the rail customizer's settings section", async () => {
      const { result, host } = setup()
      await act(() => result.current.runCommand("customize-navigation"))
      expect(host.onOpenSettings).toHaveBeenCalledWith("sidebar")
    })

    it("shows and hides the rail only when that changes something", async () => {
      const { result } = setup()
      // Showing already → "show" is a no-op, "hide" toggles.
      await act(() => result.current.runCommand("show-nav-rail"))
      expect(toggleGuildRailAction).not.toHaveBeenCalled()
      await act(() => result.current.runCommand("hide-nav-rail"))
      expect(toggleGuildRailAction).toHaveBeenCalledTimes(1)
      uiState.guildRailCollapsed = true
      await act(() => result.current.runCommand("hide-nav-rail"))
      expect(toggleGuildRailAction).toHaveBeenCalledTimes(1)
      await act(() => result.current.runCommand("show-nav-rail"))
      expect(toggleGuildRailAction).toHaveBeenCalledTimes(2)
    })

    it("moves the rail to the named edge, on its own settings key", async () => {
      const { result } = setup()
      // Unset reads as the shipped left edge.
      await act(() => result.current.runCommand("move-nav-rail-left"))
      expect(saveSettings).not.toHaveBeenCalled()
      await act(() => result.current.runCommand("move-nav-rail-right"))
      expect(saveSettings).toHaveBeenLastCalledWith({ sidebarSide: "right" })
      settingsState.settings = { sidebarSide: "right" }
      await act(() => result.current.runCommand("move-nav-rail-left"))
      expect(saveSettings).toHaveBeenLastCalledWith({ sidebarSide: "left" })
      settingsState.settings = null
      saveSettings.mockRejectedValueOnce(new Error("locked"))
      await act(() => result.current.runCommand("move-nav-rail-right"))
      expect(toast.error).toHaveBeenCalledWith('toasts.navigationUpdateFailed:{"message":"locked"}')
      saveSettings.mockRejectedValueOnce("offline")
      await act(() => result.current.runCommand("move-nav-rail-right"))
      expect(toast.error).toHaveBeenLastCalledWith(
        'toasts.navigationUpdateFailed:{"message":"offline"}'
      )
    })
  })

  it("opens the browser preview route", async () => {
    const { result } = setup()
    await act(() => result.current.runCommand("open-browser"))
    expect(push).toHaveBeenCalledWith("/browser")
  })

  it("summons the desktop pet through the one shared summon path", async () => {
    const { result } = setup()
    await act(() => result.current.runCommand("toggle-desktop-pet"))
    expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("says so when the desktop pet cannot be toggled", async () => {
    toggleDesktopPetWindow.mockRejectedValueOnce(new Error("no window"))
    const { result } = setup()
    await act(() => result.current.runCommand("toggle-desktop-pet"))
    expect(toast.error).toHaveBeenCalledWith('toasts.petToggleFailed:{"message":"no window"}')
  })

  it("opens the pet console by route, so it works while the pet is switched off", async () => {
    const { result } = setup()
    await act(() => result.current.runCommand("open-pet-console"))
    expect(push).toHaveBeenCalledWith("/pet")
  })

  it("delegates new-chat to the host when it owns it", async () => {
    const onNewChat = jest.fn()
    const { result, create } = setup({ onNewChat })
    await act(() => result.current.runCommand("new-chat"))
    expect(onNewChat).toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("replays stored recent actions, resolving quick-action refs", async () => {
    const { result, close } = setup()
    getQuickAction.mockReturnValueOnce({ fullId: "p:a" })
    act(() => result.current.runStoredAction({ type: "quick-action-ref", fullId: "p:a" }))
    expect(close).toHaveBeenCalled()
    await waitFor(() => expect(runQuickAction).toHaveBeenCalled())
    getQuickAction.mockReturnValueOnce(undefined)
    act(() => result.current.runStoredAction({ type: "quick-action-ref", fullId: "gone" }))
    expect(toast.error).toHaveBeenCalledWith("recents.unavailable")
    act(() => result.current.runStoredAction({ type: "navigate", href: "/recent" }))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/recent"))
  })

  it("reports a failing item action", async () => {
    const { result } = setup()
    act(() =>
      result.current.runItem(
        item({
          type: "callback",
          run: () => {
            throw new Error("bad")
          },
        })
      )
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("bad"))
  })
})

describe("reference-in-composer", () => {
  // Staging is per entity kind and lives in the mention registry; the palette
  // must not grow a second copy of it, so the action carries the candidate and
  // the window seam does the rest.
  it("hands the candidate to the composer through the seam", async () => {
    const seen: unknown[] = []
    const off = onComposerReferenceRequest((candidate) => seen.push(candidate))
    const { result, close } = setup()
    const candidate = {
      entityKind: "memory" as const,
      id: "mem_1",
      title: "Prefers pnpm",
      searchText: "",
    }
    await act(async () => {
      await result.current.runItem(
        item({ type: "reference-in-composer", candidate }, { kind: "memory" })
      )
    })
    expect(seen).toEqual([candidate])
    // Closing is the same outcome a selection has: leaving the palette open
    // over a composer that just gained a chip hides the only feedback there is.
    expect(close).toHaveBeenCalled()
    off()
  })
})
