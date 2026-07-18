const call = jest.fn()
const subscribe = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
  onTauriEvent: (...args: unknown[]) => subscribe(...args),
}))

import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  beginTaskWorkspaceTurn,
  listTaskWorkspaces,
  resolveTaskWorkspaceConflict,
  runIdForTurn,
  settleTaskWorkspaceTurn,
  taskIdForMessage,
} from "./client"

describe("task workspace client", () => {
  beforeEach(() => {
    call.mockReset()
    subscribe.mockReset()
    useTaskWorkspaceStore.getState().clear()
  })

  it("normalizes task and run ids for the Rust boundary", () => {
    expect(taskIdForMessage("message / 1")).toBe("task:message___1")
    expect(runIdForTurn("session / 1", 2)).toBe("run:session___1:2")
  })

  it("activates the isolated execution root and starts watching", async () => {
    call.mockResolvedValueOnce({
      taskId: "task:message",
      runId: "run:session:1",
      executionRoot: "/isolated",
      state: "running",
    })
    call.mockResolvedValueOnce(null)

    const run = await beginTaskWorkspaceTurn({
      taskId: "task:message",
      sessionId: "session",
      runId: "run:session:1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/repo",
    })

    expect(run?.executionRoot).toBe("/isolated")
    expect(call).toHaveBeenNthCalledWith(1, "task_workspace_begin", {
      input: expect.objectContaining({ workspaceRoot: "/repo" }),
    })
    expect(call).toHaveBeenNthCalledWith(2, "task_workspace_watch", {
      runId: "run:session:1",
    })
  })

  it("settles only the matching active chat run", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task:message",
      runId: runIdForTurn("session", 3),
      sessionId: "session",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    call.mockResolvedValueOnce([]).mockResolvedValueOnce(null)

    await expect(settleTaskWorkspaceTurn("session", 2)).resolves.toBeNull()
    await expect(settleTaskWorkspaceTurn("session", 3)).resolves.toEqual([])
    expect(call).toHaveBeenCalledWith("task_workspace_settle", {
      runId: runIdForTurn("session", 3),
      finalState: "ready",
    })
  })

  it("lists persisted session tasks and forwards explicit conflict resolution", async () => {
    call.mockResolvedValueOnce([{ taskId: "task:message" }]).mockResolvedValueOnce({
      state: "reverted",
      revision: 2,
      conflicts: [],
    })

    await expect(listTaskWorkspaces("session")).resolves.toEqual([{ taskId: "task:message" }])
    await resolveTaskWorkspaceConflict("run:session:1", "keepCurrent")

    expect(call).toHaveBeenNthCalledWith(1, "task_workspace_list", { sessionId: "session" })
    expect(call).toHaveBeenNthCalledWith(2, "task_workspace_resolve_conflict", {
      runId: "run:session:1",
      resolution: "keepCurrent",
      selection: [],
    })
  })
})
