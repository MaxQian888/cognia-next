import {
  resolveTaskWorkspace,
  taskVisibleInWorkspace,
  WORKSPACE_LOOKUP_TIMEOUT_MS,
  workspaceScopeForSchedulerHost,
} from "./task-workspace-binding"

const deps = (over: Partial<Parameters<typeof resolveTaskWorkspace>[1]> = {}) => ({
  sessionWorkspace: async () => null,
  activeWorkspace: async () => null,
  timeoutMs: 50,
  ...over,
})

describe("resolveTaskWorkspace", () => {
  it("keeps an explicit workspace without touching anything", async () => {
    const sessionWorkspace = jest.fn(async () => "from-session")
    const activeWorkspace = jest.fn(async () => "from-active")
    await expect(
      resolveTaskWorkspace(
        { projectId: "explicit", createdBy: { kind: "agent", sessionId: "s1" } },
        deps({ sessionWorkspace, activeWorkspace })
      )
    ).resolves.toBe("explicit")
    expect(sessionWorkspace).not.toHaveBeenCalled()
    expect(activeWorkspace).not.toHaveBeenCalled()
  })

  it("prefers the creating conversation's workspace over the one on screen", async () => {
    // An agent scheduling a follow-up while the user looks at another
    // repository must bind the schedule to the repository it is working in.
    await expect(
      resolveTaskWorkspace(
        { createdBy: { kind: "agent", sessionId: "s1" } },
        deps({ sessionWorkspace: async () => "owner", activeWorkspace: async () => "on-screen" })
      )
    ).resolves.toBe("owner")
  })

  it("falls back to the active workspace for a hand-made task", async () => {
    await expect(
      resolveTaskWorkspace(
        { createdBy: { kind: "user" } },
        deps({ activeWorkspace: async () => "w1" })
      )
    ).resolves.toBe("w1")
  })

  it("falls back to the active workspace when the conversation has none", async () => {
    await expect(
      resolveTaskWorkspace(
        { createdBy: { kind: "agent", sessionId: "s1" } },
        deps({ sessionWorkspace: async () => null, activeWorkspace: async () => "w1" })
      )
    ).resolves.toBe("w1")
  })

  it("leaves the task unattributed rather than failing when a lookup throws", async () => {
    await expect(
      resolveTaskWorkspace(
        { createdBy: { kind: "agent", sessionId: "s1" } },
        deps({
          sessionWorkspace: async () => {
            throw new Error("db closed")
          },
          activeWorkspace: async () => {
            throw new Error("db closed")
          },
        })
      )
    ).resolves.toBeUndefined()
  })

  it("gives up rather than letting a stalled database block task creation", async () => {
    // Creating a task used to touch only the scheduler's own database. A slow
    // or absent main database must not be able to stop it.
    const hang = () => new Promise<string>(() => {})
    await expect(
      resolveTaskWorkspace(
        { createdBy: { kind: "agent", sessionId: "s1" } },
        deps({ sessionWorkspace: hang, activeWorkspace: hang, timeoutMs: 20 })
      )
    ).resolves.toBeUndefined()
  })

  it("has a budget short enough to be invisible and long enough to succeed", () => {
    expect(WORKSPACE_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0)
    expect(WORKSPACE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})

describe("taskVisibleInWorkspace", () => {
  it("shows a task from the workspace being viewed", () => {
    expect(taskVisibleInWorkspace({ projectId: "w1" }, "w1")).toBe(true)
  })

  it("hides a task owned by another workspace", () => {
    expect(taskVisibleInWorkspace({ projectId: "w2" }, "w1")).toBe(false)
  })

  it("shows an unattributed task everywhere", () => {
    // A row that predates the column is unattributed, not foreign. Hiding it
    // would make it invisible in every workspace at once, which is how a
    // schedule silently stops being maintained.
    expect(taskVisibleInWorkspace({}, "w1")).toBe(true)
    expect(taskVisibleInWorkspace({ projectId: undefined }, "w1")).toBe(true)
  })

  it("shows everything when no workspace is being viewed", () => {
    expect(taskVisibleInWorkspace({ projectId: "w2" }, null)).toBe(true)
    expect(taskVisibleInWorkspace({ projectId: "w2" }, undefined)).toBe(true)
  })
})

describe("workspaceScopeForSchedulerHost", () => {
  it("scopes to the active workspace when the schedules are this device's", () => {
    expect(workspaceScopeForSchedulerHost("local", "ws_a")).toBe("ws_a")
  })

  it("does not scope a paired host's schedules by a local workspace id", () => {
    // `projects` is absent from COMPANION_SYNC_TABLES and `activeProjectId` is
    // `desktop-only`, so the local id names nothing over there. Passing it
    // matched no binding and hid every attributed schedule on the host.
    expect(workspaceScopeForSchedulerHost("paired", "ws_a")).toBeUndefined()
  })

  it("is undefined when this device has no active workspace", () => {
    expect(workspaceScopeForSchedulerHost("local", null)).toBeUndefined()
    expect(workspaceScopeForSchedulerHost("local", undefined)).toBeUndefined()
  })

  it("composes with taskVisibleInWorkspace so a host's bindings survive the round trip", () => {
    const hostTask = { projectId: "ws_on_the_host" }
    const scope = workspaceScopeForSchedulerHost("paired", "ws_local")
    expect(taskVisibleInWorkspace(hostTask, scope)).toBe(true)
    // ...and the same task is correctly hidden when both sides are local.
    expect(
      taskVisibleInWorkspace(hostTask, workspaceScopeForSchedulerHost("local", "ws_local"))
    ).toBe(false)
  })
})
