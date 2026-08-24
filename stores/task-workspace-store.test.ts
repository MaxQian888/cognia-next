import { useTaskWorkspaceStore } from "./task-workspace-store"

describe("task workspace store", () => {
  beforeEach(() => useTaskWorkspaceStore.getState().clear())

  it("tracks provisional events until authoritative reconcile", () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    useTaskWorkspaceStore.getState().ingestEvent({
      taskId: "task-1",
      runId: "run-1",
      revision: 1,
      changes: [{ path: "src/a.ts", kind: "modified" }],
      overflow: false,
      resyncRequired: false,
    })
    expect(useTaskWorkspaceStore.getState().provisionalByRun["run-1"]).toBeDefined()

    useTaskWorkspaceStore.getState().reconcile("session-1", [])
    expect(useTaskWorkspaceStore.getState().provisionalByRun["run-1"]).toBeUndefined()
    expect(useTaskWorkspaceStore.getState().activeBySession["session-1"].state).toBe("ready")
  })

  it("ignores stale watcher revisions", () => {
    const state = useTaskWorkspaceStore.getState()
    state.ingestEvent({
      taskId: "task-1",
      runId: "run-1",
      revision: 2,
      changes: [{ path: "new.ts", kind: "created" }],
      overflow: false,
      resyncRequired: false,
    })
    state.ingestEvent({
      taskId: "task-1",
      runId: "run-1",
      revision: 1,
      changes: [{ path: "old.ts", kind: "created" }],
      overflow: false,
      resyncRequired: false,
    })
    expect(useTaskWorkspaceStore.getState().provisionalByRun["run-1"].changes[0].path).toBe(
      "new.ts"
    )

    state.ingestEvent({
      taskId: "task-1",
      runId: "run-1",
      revision: 3,
      changes: [{ path: "newest.ts", kind: "modified" }],
      overflow: true,
      resyncRequired: true,
    })
    expect(useTaskWorkspaceStore.getState().provisionalByRun["run-1"].revision).toBe(3)
  })

  it("leaves state unchanged when reconciling an inactive session", () => {
    const before = useTaskWorkspaceStore.getState()
    before.reconcile("missing", [])
    expect(useTaskWorkspaceStore.getState().activeBySession).toEqual({})
    expect(useTaskWorkspaceStore.getState().resourcesByTask).toEqual({})
  })

  it("binds a late-created trace span to the active workspace run", () => {
    const state = useTaskWorkspaceStore.getState()
    state.activate({
      taskId: "task-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    state.bindTrace("session-1", "trace-1", "span-1")
    expect(useTaskWorkspaceStore.getState().activeBySession["session-1"]).toEqual(
      expect.objectContaining({ traceId: "trace-1", traceSpanId: "span-1" })
    )
    expect(useTaskWorkspaceStore.getState().activeByRun["run-1"]).toEqual(
      expect.objectContaining({ traceId: "trace-1", traceSpanId: "span-1" })
    )
  })

  it("retains metadata for parallel runs in one session", () => {
    const state = useTaskWorkspaceStore.getState()
    for (const runId of ["run-1", "run-2"]) {
      state.activate({
        taskId: "task-1",
        runId,
        sessionId: "session-1",
        workspaceRoot: "/repo",
        executionRoot: `/isolated/${runId}`,
        state: "running",
      })
    }
    expect(Object.keys(useTaskWorkspaceStore.getState().activeByRun)).toEqual(["run-1", "run-2"])
  })

  it("reconciles a grouped member by run without replacing the primary session run", () => {
    const state = useTaskWorkspaceStore.getState()
    for (const runId of ["run-additional", "run-primary"]) {
      state.activate({
        taskId: `task-${runId}`,
        runId,
        sessionId: "session-1",
        workspaceRoot: "/repo",
        executionRoot: `/isolated/${runId}`,
        state: "running",
      })
    }
    state.ingestEvent({
      taskId: "task-run-additional",
      runId: "run-additional",
      revision: 1,
      changes: [{ path: "docs.md", kind: "modified" }],
      overflow: false,
      resyncRequired: false,
    })

    useTaskWorkspaceStore.getState().reconcileRun("run-additional", [])

    expect(useTaskWorkspaceStore.getState().activeByRun["run-additional"].state).toBe("ready")
    expect(useTaskWorkspaceStore.getState().activeBySession["session-1"].runId).toBe("run-primary")
    expect(useTaskWorkspaceStore.getState().provisionalByRun["run-additional"]).toBeUndefined()
  })

  it("ignores reconciliation for a run that is no longer active", () => {
    const before = useTaskWorkspaceStore.getState()

    before.reconcileRun("missing-run", [])

    expect(useTaskWorkspaceStore.getState()).toBe(before)
  })

  it("reconciles the session projection when the grouped run is primary", () => {
    const state = useTaskWorkspaceStore.getState()
    state.activate({
      taskId: "task-primary",
      runId: "run-primary",
      sessionId: "session-primary",
      workspaceRoot: "/repo",
      executionRoot: "/isolated/primary",
      state: "running",
    })

    useTaskWorkspaceStore.getState().reconcileRun("run-primary", [])

    expect(useTaskWorkspaceStore.getState().activeBySession["session-primary"].state).toBe("ready")
  })
})
