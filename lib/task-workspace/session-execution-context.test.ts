import {
  bindExecutionRun,
  canBypassEnvironmentSetup,
  createSessionExecutionContext,
  transitionManagedWorktree,
} from "./session-execution-context"

describe("session execution context", () => {
  const input = {
    sessionId: "session-1",
    projectId: "project-1",
    projectRoot: "/repo",
    requestedLocation: "managedWorktree" as const,
    isGitRepository: true,
    baseRef: "main",
    now: 10,
  }

  it("creates one durable managed-worktree binding per chat", () => {
    const context = createSessionExecutionContext(input)
    expect(context).toEqual(
      expect.objectContaining({
        location: "managedWorktree",
        workspaceBinding: { kind: "project", projectId: "project-1" },
        baseRef: "main",
        taskWorkspace: {
          taskId: "task-workspace:session-1",
          workspaceKey: "session-1",
        },
        lifecycle: expect.objectContaining({ state: "requested" }),
      })
    )

    const firstRun = bindExecutionRun(context, "run-1")
    const repeatedTurn = bindExecutionRun(firstRun, "run-2")
    expect(repeatedTurn.taskWorkspace).toEqual({
      taskId: "task-workspace:session-1",
      workspaceKey: "session-1",
      runId: "run-2",
    })
  })

  it("creates a projectless managed workspace with a stable portable identity", () => {
    const context = createSessionExecutionContext({
      sessionId: "session-1",
      projectId: "",
      projectRoot: "",
      requestedLocation: "managedWorktree",
      isGitRepository: false,
      managedWorkspaceId: "managed-workspace:session-1",
      now: 10,
    })

    expect(context).toEqual(
      expect.objectContaining({
        location: "managedWorktree",
        workspaceBinding: {
          kind: "managed",
          workspaceId: "managed-workspace:session-1",
        },
        managedWorkspace: { availability: "missing-on-device" },
      })
    )
    expect(context.taskWorkspace.workspaceKey).toBe("managed-workspace:session-1")
  })

  it("keeps managed execution for non-Git projects so Task Workspace can use shadow isolation", () => {
    const context = createSessionExecutionContext({ ...input, isGitRepository: false })
    expect(context.location).toBe("managedWorktree")
    expect(context.baseRef).toBeUndefined()
    expect(context.lifecycle).toEqual(expect.objectContaining({ state: "requested" }))
  })

  it("tracks worktree lifecycle without changing durable workspace identity", () => {
    const context = createSessionExecutionContext(input)
    const ready = transitionManagedWorktree(context, "ready", 20, {
      worktreePath: "/managed/session-1",
      branch: "codex/session-1",
    })
    expect(ready.lifecycle?.state).toBe("ready")
    expect(ready.lifecycle?.updatedAt).toBe(20)
    expect(ready.taskWorkspace).toBe(context.taskWorkspace)
  })

  it("rejects managed transitions for a local context", () => {
    const local = createSessionExecutionContext({ ...input, requestedLocation: "local" })
    expect(() => transitionManagedWorktree(local, "ready", 20)).toThrow(/requires/)
  })

  it("allows interactive setup bypass but never scheduled bypass", () => {
    expect(canBypassEnvironmentSetup("interactive")).toBe(true)
    expect(canBypassEnvironmentSetup("scheduled")).toBe(false)
  })
})
