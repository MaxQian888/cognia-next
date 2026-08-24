const getSessionMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))
const applyMock = jest.fn()
const applyBundleMock = jest.fn()
const getBundleHandoffMock = jest.fn()
const retryBundleHandoffMock = jest.fn()
const undoMock = jest.fn()
const undoBundleMock = jest.fn()
const restoreMock = jest.fn()
const pinMock = jest.fn()
const pruneMock = jest.fn()
const resolveMock = jest.fn()
jest.mock("./client", () => ({
  applyTaskWorkspace: (...args: unknown[]) => applyMock(...args),
  applyWorkspaceBundle: (...args: unknown[]) => applyBundleMock(...args),
  getBundleHandoffOutcome: (...args: unknown[]) => getBundleHandoffMock(...args),
  retryWorkspaceBundleHandoff: (...args: unknown[]) => retryBundleHandoffMock(...args),
  undoTaskWorkspace: (...args: unknown[]) => undoMock(...args),
  undoWorkspaceBundleHandoff: (...args: unknown[]) => undoBundleMock(...args),
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

const managedBundle = {
  ...managed,
  executionContext: {
    ...managed.executionContext,
    execution: {
      mode: "managed" as const,
      bundleId: "bundle-1",
      base: { kind: "workingState" as const },
      roots: [
        {
          logicalRootId: "app",
          role: "primary" as const,
          aliasPath: "/isolated/app",
          workspaceId: "workspace-primary",
        },
        {
          logicalRootId: "docs",
          role: "additional" as const,
          aliasPath: "/isolated/docs",
          workspaceId: "workspace-docs",
        },
      ],
    },
    taskWorkspace: {
      ...managed.executionContext.taskWorkspace,
      bundleTurnId: "bundle-turn-1",
    },
  },
}

beforeEach(() => {
  getSessionMock.mockReset().mockResolvedValue(managed)
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  applyMock.mockReset().mockResolvedValue({ state: "applied", revision: 2, conflicts: [] })
  applyBundleMock.mockReset().mockResolvedValue({
    bundleTurnId: "bundle-turn-1",
    outcome: {
      bundleId: "bundle-1",
      applied: ["workspace-primary", "workspace-docs"],
      rolledBack: [],
      conflicts: [],
      state: "active",
    },
  })
  getBundleHandoffMock.mockReset().mockResolvedValue({
    bundleTurnId: "bundle-turn-1",
    request: {
      bundleTurnId: "bundle-turn-1",
      selections: [],
      allowIrreversible: false,
    },
    outcome: { state: "conflict", conflicts: [] },
  })
  retryBundleHandoffMock.mockReset().mockResolvedValue({
    bundleTurnId: "bundle-turn-1",
    request: {
      bundleTurnId: "bundle-turn-1",
      selections: [],
      allowIrreversible: false,
    },
    outcome: { state: "active", conflicts: [] },
  })
  undoMock.mockReset().mockResolvedValue({ state: "reverted", revision: 3, conflicts: [] })
  undoBundleMock.mockReset().mockResolvedValue({
    bundleTurnId: "bundle-turn-1",
    bundleId: "bundle-1",
    reverted: ["workspace-docs", "workspace-primary"],
    reApplied: [],
    conflicts: [],
    state: "active",
  })
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

it("hands off a managed Bundle atomically and scopes legacy patch selections to its primary root", async () => {
  getSessionMock.mockResolvedValueOnce(managedBundle)

  const outcome = await handoffSessionToLocal(
    "session-1",
    [{ path: "src/a.ts", hunkIds: ["h1"] }],
    false,
    20
  )

  expect(applyBundleMock).toHaveBeenCalledWith("bundle-1", {
    bundleTurnId: "bundle-turn-1",
    selections: [
      {
        workspaceId: "workspace-primary",
        logicalRootId: "app",
        selection: [{ path: "src/a.ts", hunkIds: ["h1"] }],
      },
    ],
    allowIrreversible: false,
  })
  expect(applyMock).not.toHaveBeenCalled()
  expect(outcome).toEqual(expect.objectContaining({ state: "active" }))
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({ executionContext: expect.objectContaining({ location: "local" }) })
  )
})

it("keeps a Bundle managed after a fully compensated handoff failure", async () => {
  getSessionMock.mockResolvedValueOnce(managedBundle)
  applyBundleMock.mockResolvedValueOnce({
    bundleTurnId: "bundle-turn-1",
    outcome: {
      bundleId: "bundle-1",
      applied: ["workspace-primary"],
      rolledBack: ["workspace-primary"],
      conflicts: [{ path: "docs.md", reason: "stale" }],
      state: "active",
    },
  })

  const outcome = await handoffSessionToLocal("session-1", [], false, 20)

  expect(outcome).toEqual(
    expect.objectContaining({ state: "active", conflicts: [expect.anything()] })
  )
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        location: "managedWorktree",
        lifecycle: expect.objectContaining({ state: "ready" }),
      }),
    })
  )
})

it("marks a managed Bundle failed when atomic handoff cannot run", async () => {
  getSessionMock.mockResolvedValueOnce(managedBundle)
  applyBundleMock.mockRejectedValueOnce(new Error("host unavailable"))

  await expect(handoffSessionToLocal("session-1", [], false, 20)).rejects.toThrow(
    "host unavailable"
  )
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        location: "managedWorktree",
        lifecycle: expect.objectContaining({ state: "failed" }),
      }),
    })
  )
})

it("fails closed before changing lifecycle when a managed Bundle has no persisted turn", async () => {
  getSessionMock.mockResolvedValueOnce({
    ...managed,
    executionContext: {
      ...managed.executionContext,
      execution: {
        mode: "managed",
        bundleId: "bundle-1",
        base: { kind: "workingState" },
        roots: [],
      },
    },
  })

  await expect(handoffSessionToLocal("session-1")).rejects.toThrow(
    "Managed workspace Bundle has no restorable turn"
  )
  expect(applyMock).not.toHaveBeenCalled()
  expect(applyBundleMock).not.toHaveBeenCalled()
  expect(updateSessionMock).not.toHaveBeenCalled()
})

it("supports exact undo and historical restoration", async () => {
  getSessionMock.mockResolvedValue({
    ...managed,
    executionContext: {
      ...managed.executionContext,
      execution: {
        mode: "managed",
        base: { kind: "workingState" },
        roots: [{ logicalRootId: "primary", role: "primary", aliasPath: "/isolated" }],
      },
    },
  })
  await undoSessionHandoff("session-1", 20)
  expect(undoMock).toHaveBeenCalledWith("run-1")
  await restoreSessionSnapshot("session-1", "run-old", 30)
  expect(restoreMock).toHaveBeenCalledWith("run-old")
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        execution: expect.objectContaining({
          roots: [expect.objectContaining({ role: "primary", aliasPath: "/managed" })],
        }),
      }),
    })
  )
})

it("undoes a Bundle handoff in one host transaction and never through the primary run", async () => {
  getSessionMock.mockResolvedValueOnce({
    ...managedBundle,
    executionContext: { ...managedBundle.executionContext, location: "local" },
  })
  await undoSessionHandoff("session-1", 20)
  expect(undoBundleMock).toHaveBeenCalledWith("bundle-1", "bundle-turn-1")
  expect(undoMock).not.toHaveBeenCalled()

  getSessionMock.mockResolvedValueOnce(managedBundle)
  await expect(
    resolveSessionHandoffConflict("session-1", "keepCurrent", [], false, 40)
  ).rejects.toThrow("Bundle handoff supports exact retry only")
  expect(resolveMock).not.toHaveBeenCalled()
})

it("retries a Bundle handoff with its exact persisted root selection", async () => {
  getSessionMock.mockResolvedValueOnce(managedBundle)

  await resolveSessionHandoffConflict("session-1", "retryMerge", [], false, 40)

  expect(getBundleHandoffMock).toHaveBeenCalledWith("bundle-turn-1")
  expect(retryBundleHandoffMock).toHaveBeenCalledWith(
    "bundle-1",
    expect.objectContaining({ bundleTurnId: "bundle-turn-1" })
  )
  expect(updateSessionMock).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      executionContext: expect.objectContaining({
        lifecycle: expect.objectContaining({ state: "ready" }),
      }),
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
