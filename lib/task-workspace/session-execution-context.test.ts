import {
  bindExecutionRun,
  bindExecutionBundleTurn,
  canBypassEnvironmentSetup,
  createSessionExecutionContext,
  repairManagedContextProjectId,
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
        execution: {
          mode: "managed",
          base: { kind: "gitRef", gitRef: "main" },
          roots: [{ logicalRootId: "primary", role: "primary", aliasPath: "/repo" }],
        },
        workspaceBinding: { kind: "project", projectId: "project-1" },
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

  it("persists the grouped Bundle turn identity independently from its primary run", () => {
    const context = bindExecutionBundleTurn(
      createSessionExecutionContext(input),
      "bundle-turn-1",
      "run-primary"
    )

    expect(context.taskWorkspace).toEqual({
      taskId: "task-workspace:session-1",
      workspaceKey: "session-1",
      runId: "run-primary",
      bundleTurnId: "bundle-turn-1",
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
    expect(context.execution).toEqual({
      mode: "managed",
      base: { kind: "workingState" },
      roots: [],
    })
  })

  it("keeps managed execution for non-Git projects so Task Workspace can use shadow isolation", () => {
    const context = createSessionExecutionContext({ ...input, isGitRepository: false })
    expect(context.location).toBe("managedWorktree")
    expect(context.baseRef).toBeUndefined()
    expect(context.lifecycle).toEqual(expect.objectContaining({ state: "requested" }))
  })

  it("tracks worktree lifecycle without changing durable workspace identity", () => {
    const context = createSessionExecutionContext(input)
    const ready = transitionManagedWorktree(context, "ready", 20)
    expect(ready.lifecycle?.state).toBe("ready")
    expect(ready.lifecycle?.updatedAt).toBe(20)
    expect(ready.taskWorkspace).toBe(context.taskWorkspace)
    expect(ready.worktreePath).toBeUndefined()
    expect(ready.branch).toBeUndefined()
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

describe("repairManagedContextProjectId", () => {
  const managed = (projectId: string) =>
    createSessionExecutionContext({
      sessionId: "s1",
      projectId,
      projectRoot: "",
      requestedLocation: "managedWorktree",
      isGitRepository: false,
      managedWorkspaceId: "managed-workspace_s1",
      now: 1,
    })

  it("fills an empty projectId from the session row", () => {
    // The send path looks the project up by this id; `""` never matches, so the
    // turn was refused as managed_project_unavailable before it started.
    const repaired = repairManagedContextProjectId(managed(""), "project-default")
    expect(repaired?.projectId).toBe("project-default")
  })

  it("keeps the managed binding while repairing", () => {
    const repaired = repairManagedContextProjectId(managed(""), "project-default")
    expect(repaired?.workspaceBinding).toEqual({
      kind: "managed",
      workspaceId: "managed-workspace_s1",
    })
    expect(repaired?.location).toBe("managedWorktree")
  })

  it("leaves a context that already names a project alone", () => {
    const context = managed("project-real")
    expect(repairManagedContextProjectId(context, "project-default")).toBe(context)
  })

  it("returns the context unchanged when there is nothing to repair from", () => {
    const context = managed("")
    expect(repairManagedContextProjectId(context, undefined)).toBe(context)
    expect(repairManagedContextProjectId(context, "   ")).toBe(context)
  })

  it("passes an absent context straight through", () => {
    expect(repairManagedContextProjectId(undefined, "project-default")).toBeUndefined()
  })
})
