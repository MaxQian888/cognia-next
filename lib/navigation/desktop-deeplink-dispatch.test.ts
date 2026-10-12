/** @jest-environment jsdom */
const setActiveSession = jest.fn()
const setSelectedGuild = jest.fn()
const requestOpenSettings = jest.fn()
const openPathAsWorkspace = jest.fn()
const publishLogtoDeepLinkCallback = jest.fn()
const handlePromotedTaskWake = jest.fn(async (..._args: unknown[]) => ({ ran: false }))
const findActiveSessionForConversation = jest.fn(
  async (_key: string): Promise<{ id: string } | undefined> => undefined
)
const getAgentTask = jest.fn(async (_id: string): Promise<unknown> => undefined)
const listAgentTaskAttempts = jest.fn(async (_id: string): Promise<unknown[]> => [])

jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession }) },
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild, requestOpenSettings }) },
}))
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (path: string) => openPathAsWorkspace(path),
}))
jest.mock("@/lib/logto/deep-link-callback", () => ({
  publishLogtoDeepLinkCallback: (route: unknown) => publishLogtoDeepLinkCallback(route),
}))
jest.mock("@/lib/scheduler/promoted-wake", () => ({
  handlePromotedTaskWake: (...args: unknown[]) => handlePromotedTaskWake(...args),
}))
jest.mock("@/lib/connectors/session-bindings", () => ({
  findActiveSessionForConversation: (key: string) => findActiveSessionForConversation(key),
}))
jest.mock("@/lib/db/agent-tasks", () => ({
  getAgentTask: (id: string) => getAgentTask(id),
  listAgentTaskAttempts: (id: string) => listAgentTaskAttempts(id),
}))
const hasPluginDeepLinkHandler = jest.fn(async (raw: string) =>
  /^(?:web\+)?cognia:\/\/plugin\/acme\//.test(raw)
)
jest.mock("@/lib/plugin/uri/route-deep-link", () => ({
  hasPluginDeepLinkHandler: (raw: string) => hasPluginDeepLinkHandler(raw),
}))
let pendingOAuthProvider: string | null = null
jest.mock("@cognia/provider-core/providers/oauth", () => ({
  ...jest.requireActual("@cognia/provider-core/providers/oauth"),
  getOAuthState: () => (pendingOAuthProvider ? { providerId: pendingOAuthProvider } : null),
}))

import { parseCogniaDeeplink } from "./cognia-deeplink"
import {
  AGENT_TASK_BOARD_SETTINGS_TAB,
  agentTaskSessionId,
  dispatchDesktopDeeplink,
  issuePagePath,
  type DesktopDeeplinkDeps,
} from "./desktop-deeplink-dispatch"

function deps() {
  return { navigate: jest.fn(), onUnknown: jest.fn() }
}

async function dispatch(raw: string, handlers: DesktopDeeplinkDeps = deps()) {
  await dispatchDesktopDeeplink(parseCogniaDeeplink(raw), handlers)
  return handlers
}

beforeEach(() => {
  jest.clearAllMocks()
  pendingOAuthProvider = null
})

describe("dispatchDesktopDeeplink", () => {
  it("focuses the conversation a session link names, under either host", async () => {
    await dispatch("cognia://session/s-1")
    expect(setActiveSession).toHaveBeenCalledWith("s-1")
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })

    await dispatch("cognia://chat/c-1")
    expect(setActiveSession).toHaveBeenCalledWith("c-1")
  })

  it("ignores a session link that names nothing", async () => {
    const handlers = await dispatch("cognia://session")
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(handlers.onUnknown).not.toHaveBeenCalled()
  })

  it("opens a conversation files link's file after focusing the conversation", async () => {
    const openFiles = jest.fn(async () => "opened" as const)
    const handlers = { ...deps(), openFiles, onFilesUnresolved: jest.fn() }
    await dispatch("cognia://session/s-1?view=files&path=%2Froots%2Fr%2Fa.md&line=2", handlers)
    expect(setActiveSession).toHaveBeenCalledWith("s-1")
    expect(openFiles).toHaveBeenCalledWith({ sessionId: "s-1", path: "/roots/r/a.md", line: 2 })
    expect(handlers.onFilesUnresolved).not.toHaveBeenCalled()

    await dispatch("cognia://session/s-1?view=files", handlers)
    expect(openFiles).toHaveBeenLastCalledWith({ sessionId: "s-1" })
  })

  it("focuses the conversation even when its linked file cannot be shown", async () => {
    const handlers = {
      ...deps(),
      openFiles: jest.fn(async () => "outside" as const),
      onFilesUnresolved: jest.fn(),
    }
    const pending = dispatchDesktopDeeplink(
      parseCogniaDeeplink("cognia://session/s-2?view=files&path=%2Fnowhere"),
      handlers
    )
    // Synchronous, before the files lookup resolves.
    expect(setActiveSession).toHaveBeenCalledWith("s-2")
    await pending
    expect(handlers.onFilesUnresolved).toHaveBeenCalledWith("outside")

    const throwing = {
      ...deps(),
      openFiles: jest.fn(async () => Promise.reject(new Error("x"))),
      onFilesUnresolved: jest.fn(),
    }
    await dispatch("cognia://session/s-3?view=files&path=%2Fworkspace%2Fa", throwing)
    expect(throwing.onFilesUnresolved).toHaveBeenCalledWith("not-found")
  })

  it("does not look for files on a plain conversation link", async () => {
    const openFiles = jest.fn(async () => "opened" as const)
    await dispatch("cognia://session/s-1", { ...deps(), openFiles })
    expect(openFiles).not.toHaveBeenCalled()
  })

  it("acts on a session link before its first await", () => {
    // The running-app hook does not wait for the promise; a synchronous route
    // must already be applied when the call returns.
    void dispatchDesktopDeeplink(parseCogniaDeeplink("cognia://session/s-sync"), deps())
    expect(setActiveSession).toHaveBeenCalledWith("s-sync")
  })

  it("opens the board on the issue an issue link names", async () => {
    const handlers = await dispatch("cognia://issues/issue-1")
    expect(handlers.navigate).toHaveBeenCalledWith("/issues?id=issue-1")
    expect(issuePagePath("a b")).toBe("/issues?id=a%20b")
  })

  it("opens the board itself for an issue link with no id", async () => {
    const handlers = await dispatch("cognia://issues")
    expect(handlers.navigate).toHaveBeenCalledWith("/issues")
  })

  it("opens the conversation an agent task's latest attempt ran in", async () => {
    getAgentTask.mockResolvedValueOnce({ id: "task-1" })
    listAgentTaskAttempts.mockResolvedValueOnce([
      { attemptNo: 1, sessionId: "s-first" },
      { attemptNo: 2, sessionId: "s-latest" },
      { attemptNo: 3 },
    ])
    await dispatch("cognia://agent-tasks/task-1")
    // The newest attempt WITH a conversation: attempt 3 has not started one.
    expect(setActiveSession).toHaveBeenCalledWith("s-latest")
    expect(requestOpenSettings).not.toHaveBeenCalled()
  })

  it("opens the agent's task board for a task that has not run", async () => {
    getAgentTask.mockResolvedValueOnce({ id: "task-2" })
    listAgentTaskAttempts.mockResolvedValueOnce([])
    await dispatch("cognia://agent-tasks/task-2")
    expect(requestOpenSettings).toHaveBeenCalledWith(AGENT_TASK_BOARD_SETTINGS_TAB)
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it("falls back to the board when the task is gone or cannot be read", async () => {
    getAgentTask.mockResolvedValueOnce(undefined)
    await dispatch("cognia://agent-tasks/missing")
    expect(listAgentTaskAttempts).not.toHaveBeenCalled()
    expect(requestOpenSettings).toHaveBeenCalledWith(AGENT_TASK_BOARD_SETTINGS_TAB)

    requestOpenSettings.mockClear()
    getAgentTask.mockRejectedValueOnce(new Error("db closed"))
    await dispatch("cognia://agent-tasks/broken")
    expect(requestOpenSettings).toHaveBeenCalledWith(AGENT_TASK_BOARD_SETTINGS_TAB)
  })

  it("answers agentTaskSessionId with null for a task with no attempts", async () => {
    getAgentTask.mockResolvedValueOnce({ id: "task-3" })
    listAgentTaskAttempts.mockResolvedValueOnce([])
    await expect(agentTaskSessionId("task-3")).resolves.toBeNull()
  })

  it("follows an IM link to the conversation bound to that thread", async () => {
    findActiveSessionForConversation.mockResolvedValueOnce({ id: "s-im" })
    await dispatch("cognia://im?conversationKey=discord%3Aa%3Ab")
    expect(findActiveSessionForConversation).toHaveBeenCalledWith("discord:a:b")
    expect(setActiveSession).toHaveBeenCalledWith("s-im")
  })

  it("does nothing for an IM link whose thread has no conversation", async () => {
    await dispatch("cognia://im?conversationKey=discord%3Aa%3Ab")
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it("hands a scheduler link to the promoted-task handler with the navigator", async () => {
    const handlers = deps()
    await dispatch("cognia://scheduler/task/task-9?run=tok", handlers)
    expect(handlePromotedTaskWake).toHaveBeenCalledWith(
      { taskId: "task-9", runToken: "tok" },
      { navigate: handlers.navigate }
    )
  })

  it("opens settings, workspaces and workflow runs", async () => {
    const handlers = deps()
    await dispatch("cognia://settings?tab=advanced", handlers)
    await dispatch("cognia://workspace?path=%2Fwork", handlers)
    await dispatch("cognia://workflow-run/wf-1/run-2", handlers)
    expect(requestOpenSettings).toHaveBeenCalledWith("advanced")
    expect(openPathAsWorkspace).toHaveBeenCalledWith("/work")
    expect(handlers.navigate).toHaveBeenCalledWith("/workflows/run?id=wf-1&runId=run-2")
  })

  it("passes a Logto callback to the sign-in seam", async () => {
    await dispatch("cognia://logto/callback?code=c&state=s")
    expect(publishLogtoDeepLinkCallback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "logto_callback", code: "c", state: "s" })
    )
  })

  it("passes the reverse-domain OIDC callback to the same sign-in seam", async () => {
    await dispatch("cn.cognia.app:/auth/callback?code=c2&state=s2")
    expect(publishLogtoDeepLinkCallback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "logto_callback", code: "c2", state: "s2" })
    )
  })

  it("leaves mobile-owned routes to the mobile shell", async () => {
    const handlers = deps()
    await dispatch("cognia://pair?payload=p", handlers)
    await dispatch("cognia://share?text=hi", handlers)
    await dispatch("cognia://oauth/claude?code=c", handlers)
    expect(handlers.navigate).not.toHaveBeenCalled()
    expect(handlers.onUnknown).not.toHaveBeenCalled()
  })

  it.each([
    "cognia://plugin/acme/auth/callback?code=c",
    "web+cognia://plugin/acme/auth/callback?code=c",
    "cognia://connector/oauth/lark?code=c&state=s",
    "cognia://provider/oauth/openrouter?code=c&state=s",
    "cognia://docs-provider/oauth/google-drive?code=c&state=s",
  ])("defers %s to its dedicated listener", async (raw) => {
    pendingOAuthProvider = "openrouter"
    const handlers = await dispatch(raw)
    expect(handlers.onUnknown).not.toHaveBeenCalled()
    expect(handlers.navigate).not.toHaveBeenCalled()
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it.each([
    "cognia://plugin",
    "cognia://connector/nope",
    "cognia://connector/oauth/",
    "cognia://provider/oauth/",
    "cognia://docs-provider/nope",
    "https://plugin/acme/auth/callback",
    "::not-a-url::",
  ])("still reports unclaimed or malformed links: %s", async (raw) => {
    const handlers = await dispatch(raw)
    expect(handlers.onUnknown).toHaveBeenCalledWith(raw)
  })

  it("reports a plugin link nobody handles, and a provider callback with no login in progress", async () => {
    const plugin = await dispatch("cognia://plugin/uninstalled/auth/callback?code=c")
    expect(hasPluginDeepLinkHandler).toHaveBeenCalledWith(
      "cognia://plugin/uninstalled/auth/callback?code=c"
    )
    expect(plugin.onUnknown).toHaveBeenCalledWith(
      "cognia://plugin/uninstalled/auth/callback?code=c"
    )

    const late = await dispatch("cognia://provider/oauth/openrouter?code=c")
    expect(late.onUnknown).toHaveBeenCalledWith("cognia://provider/oauth/openrouter?code=c")

    pendingOAuthProvider = "anthropic"
    const other = await dispatch("cognia://provider/oauth/openrouter?code=c")
    expect(other.onUnknown).toHaveBeenCalledWith("cognia://provider/oauth/openrouter?code=c")
  })

  it("hands an unknown link back to the caller", async () => {
    const handlers = await dispatch("cognia://nope")
    expect(handlers.onUnknown).toHaveBeenCalledWith("cognia://nope")
    const foreign = await dispatch("https://example.com/")
    expect(foreign.onUnknown).toHaveBeenCalledWith("https://example.com/")
  })
})
