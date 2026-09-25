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

import { parseCogniaDeeplink } from "./cognia-deeplink"
import {
  AGENT_TASK_BOARD_SETTINGS_TAB,
  agentTaskSessionId,
  dispatchDesktopDeeplink,
  issuePagePath,
} from "./desktop-deeplink-dispatch"

function deps() {
  return { navigate: jest.fn(), onUnknown: jest.fn() }
}

async function dispatch(raw: string, handlers = deps()) {
  await dispatchDesktopDeeplink(parseCogniaDeeplink(raw), handlers)
  return handlers
}

beforeEach(() => {
  jest.clearAllMocks()
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

  it("leaves mobile-owned routes to the mobile shell", async () => {
    const handlers = deps()
    await dispatch("cognia://pair?payload=p", handlers)
    await dispatch("cognia://share?text=hi", handlers)
    await dispatch("cognia://oauth/claude?code=c", handlers)
    expect(handlers.navigate).not.toHaveBeenCalled()
    expect(handlers.onUnknown).not.toHaveBeenCalled()
  })

  it("hands an unknown link back to the caller", async () => {
    const handlers = await dispatch("cognia://nope")
    expect(handlers.onUnknown).toHaveBeenCalledWith("cognia://nope")
    const foreign = await dispatch("https://example.com/")
    expect(foreign.onUnknown).toHaveBeenCalledWith("https://example.com/")
  })
})
