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

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
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
const uiState = { setSelectedGuild: jest.fn(), toggleSidebar: jest.fn() }
jest.mock("@/stores/ui", () => ({ useUIStore: { getState: () => uiState } }))

import { focusSession, useGlobalSearchActions } from "./use-global-search-actions"

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
    await run("toggle-sidebar")
    expect(uiState.toggleSidebar).toHaveBeenCalled()
    await run("open-folder")
    expect(openFolder).toHaveBeenCalled()
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
      ["manage-characters", "characters"],
      ["manage-skills", "skills"],
      ["manage-teams", "teams"],
      ["manage-mcp", "mcp"],
    ] as const) {
      await run(id)
      expect(host.onOpenSettings).toHaveBeenLastCalledWith(tab)
    }
    await run("clear-recent-searches")
    expect(clearAllRecents).toHaveBeenCalled()
    await run("unknown-command")

    // Off the desktop, folder + updates degrade to a toast.
    isTauriMock.mockReturnValue(false)
    openFolder.mockClear()
    checkForUpdate.mockClear()
    await run("open-folder")
    expect(toast.info).toHaveBeenCalledWith("toasts.openFolderDesktopOnly")
    await run("check-updates")
    expect(toast.info).toHaveBeenCalledWith("toasts.updatesDesktopOnly")
    expect(openFolder).not.toHaveBeenCalled()
    expect(checkForUpdate).not.toHaveBeenCalled()
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
