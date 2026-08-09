const getSessionMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))
const applyMock = jest.fn()
const undoMock = jest.fn()
const restoreMock = jest.fn()
const pinMock = jest.fn()
const pruneMock = jest.fn()
const resolveMock = jest.fn()
jest.mock("./client", () => ({
  applyTaskWorkspace: (...args: unknown[]) => applyMock(...args),
  undoTaskWorkspace: (...args: unknown[]) => undoMock(...args),
  restoreTaskWorkspaceSnapshot: (...args: unknown[]) => restoreMock(...args),
  pinTaskWorkspace: (...args: unknown[]) => pinMock(...args),
  pruneTaskWorkspaces: (...args: unknown[]) => pruneMock(...args),
  resolveTaskWorkspaceConflict: (...args: unknown[]) => resolveMock(...args),
}))

import {
  handoffSessionToLocal,
  handoffSessionToManaged,
  restoreSessionSnapshot,
  resolveSessionHandoffConflict,
  undoSessionHandoff,
} from "./handoff"

const managed = {
  id: "session-1",
  executionContext: {
    location: "managedWorktree" as const,
    projectId: "project-1",
    projectRoot: "/repo",
    taskWorkspace: {
      taskId: "task-workspace:session-1",
      workspaceKey: "session-1",
      runId: "run-1",
    },
    lifecycle: { state: "ready" as const, createdAt: 1, updatedAt: 1, pinned: false },
  },
}

beforeEach(() => {
  getSessionMock.mockReset().mockResolvedValue(managed)
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  applyMock.mockReset().mockResolvedValue({ state: "applied", revision: 2, conflicts: [] })
  undoMock.mockReset().mockResolvedValue({ state: "reverted", revision: 3, conflicts: [] })
  restoreMock.mockReset().mockResolvedValue({ executionRoot: "/managed", isolationRef: "branch" })
  resolveMock.mockReset().mockResolvedValue({ state: "ready", revision: 4, conflicts: [] })
})

it("previews dirty Local state by binding the chat before managed creation", async () => {
  const context = await handoffSessionToManaged({
    sessionId: "session-1",
    projectId: "project-1",
    projectRoot: "/repo",
    isGitRepository: true,
    now: 10,
  })
  expect(context).toEqual(
    expect.objectContaining({
      location: "managedWorktree",
      lifecycle: expect.objectContaining({ state: "requested" }),
    })
  )
  expect(updateSessionMock).toHaveBeenCalledWith("session-1", { executionContext: context })
})

it("applies cumulative patches to Local and records conflicts without guessing", async () => {
  await handoffSessionToLocal("session-1")
  expect(applyMock).toHaveBeenCalledWith("run-1", [], false)
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({ executionContext: expect.objectContaining({ location: "local" }) })
  )
  applyMock.mockResolvedValueOnce({
    state: "conflict",
    revision: 2,
    conflicts: [{ path: "a", reason: "stale" }],
  })
  await handoffSessionToLocal("session-1")
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        lifecycle: expect.objectContaining({ state: "conflict" }),
      }),
    })
  )
})

it("supports exact undo and historical restoration", async () => {
  await undoSessionHandoff("session-1", 20)
  expect(undoMock).toHaveBeenCalledWith("run-1")
  await restoreSessionSnapshot("session-1", "run-old", 30)
  expect(restoreMock).toHaveBeenCalledWith("run-old")
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({ worktreePath: "/managed" }),
    })
  )
})

it("restores a historical snapshot after a handoff returned the chat to Local", async () => {
  getSessionMock.mockResolvedValueOnce({
    ...managed,
    executionContext: { ...managed.executionContext, location: "local" },
  })
  await restoreSessionSnapshot("session-1", "run-old", 30)
  expect(updateSessionMock).toHaveBeenNthCalledWith(
    1,
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        location: "managedWorktree",
        lifecycle: expect.objectContaining({ state: "restoring" }),
      }),
    })
  )
})

it("resolves a handoff conflict and returns the managed workspace to ready", async () => {
  await resolveSessionHandoffConflict("session-1", "keepCurrent", [], false, 40)
  expect(resolveMock).toHaveBeenCalledWith("run-1", "keepCurrent", [], false)
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        lifecycle: expect.objectContaining({ state: "ready" }),
      }),
    })
  )
})
