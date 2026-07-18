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
})
