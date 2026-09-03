const call = jest.fn()
const subscribe = jest.fn()
const recordOutcome = jest.fn()
const userAction = jest.fn(
  (_command: string, operation: () => Promise<unknown>) => operation() as Promise<unknown>
)

// The real seam short-circuits on a native host and mints a lease on a
// companion. Both are exercised in `user-action.test.ts`; here the point is
// only that the settle goes THROUGH it rather than calling the Host bare.
jest.mock("./user-action", () => {
  const actual = jest.requireActual("./user-action")
  return {
    ...actual,
    runWorkspaceUserAction: (...args: unknown[]) =>
      userAction(...(args as [string, () => Promise<unknown>])),
  }
})

jest.mock("@/lib/code-adoption/outcome", () => ({
  recordTaskWorkspaceOutcome: (...args: unknown[]) => recordOutcome(...args),
}))

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
  onTauriEvent: (...args: unknown[]) => subscribe(...args),
}))

const reclaim = jest.fn(async () => [] as string[])
const remember = jest.fn()
const forget = jest.fn()
jest.mock("./abandoned-turns", () => ({
  reclaimAbandonedBundleTurns: (...args: unknown[]) =>
    reclaim(...(args as [])) as Promise<string[]>,
  rememberOpenBundleTurn: (...args: unknown[]) => remember(...args),
  forgetOpenBundleTurn: (...args: unknown[]) => forget(...args),
}))

import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  acquireWorkspaceBundle,
  archiveManagedWorkspace,
  applyTaskWorkspace,
  applyWorkspaceBundle,
  beginTaskWorkspaceTurn,
  beginTaskWorkspaceBundleTurn,
  beginWorkspaceBundleTurn,
  adoptManagedWorkspace,
  adoptWorkspaceEnvironment,
  exportTaskResourceManifest,
  getBundleHandoffOutcome,
  getBundleHandoffUndoOutcome,
  getTaskResourceSummary,
  listTaskResourceEvents,
  recordTaskResourceToolEvent,
  reconcileManagedWorkspaces,
  retryWorkspaceBundleHandoff,
  undoWorkspaceBundleHandoff,
  listTaskWorkspaces,
  listManagedWorkspaces,
  listWorkspaceEnvironments,
  listWorkspaceBundles,
  getWorkspaceLifecyclePolicy,
  deleteManagedWorkspace,
  createWorkspaceBranch,
  makeManagedWorkspacePermanent,
  setWorkspaceLifecyclePolicy,
  runWorkspaceMaintenance,
  listWorkspaceMaintenanceEvents,
  pinManagedWorkspace,
  resolveTaskWorkspaceConflict,
  runIdForTurn,
  settleTaskWorkspaceTurn,
  restoreTaskWorkspaceSnapshot,
  restoreManagedWorkspace,
  settleWorkspaceBundleTurn,
  taskIdForMessage,
} from "./client"

describe("task workspace client", () => {
  beforeEach(() => {
    call.mockReset()
    subscribe.mockReset()
    recordOutcome.mockReset()
    reclaim.mockReset().mockResolvedValue([])
    remember.mockReset()
    forget.mockReset()
    useTaskWorkspaceStore.getState().clear()
  })

  it("normalizes task and run ids for the Rust boundary", () => {
    expect(taskIdForMessage("message / 1")).toBe("task:message___1")
    expect(runIdForTurn("session / 1", 2)).toMatch(/^run:session___1:2:[a-z0-9]+$/)
  })

  /**
   * The chat store's turn counter is slice-only and restarts at 0 on every
   * reload, so without an epoch two turns in two page loads of one conversation
   * minted the same id. The host then refused the second with "runId is already
   * owned by another task run" whenever the first had not settled, which wedged
   * the conversation with no way out from the UI.
   */
  it("gives the same turn number in two page loads two different ids", async () => {
    const first = runIdForTurn("session", 0)
    jest.resetModules()
    const reloaded = await import("./client")
    // A different module instance is a different page load.
    expect(reloaded.runIdForTurn("session", 0)).not.toBe(first)
    // Same load, same answer: anything deriving it twice still agrees.
    expect(runIdForTurn("session", 0)).toBe(first)
  })

  it("activates the isolated execution root and starts watching", async () => {
    call.mockResolvedValueOnce({
      taskId: "task:message",
      runId: "run:session:1",
      executionRoot: "/isolated",
      state: "running",
    })
    const run = await beginTaskWorkspaceTurn({
      taskId: "task:message",
      sessionId: "session",
      runId: "run:session:1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/repo",
      base: { kind: "gitRef", gitRef: "origin/dev" },
    })

    expect(run?.executionRoot).toBe("/isolated")
    expect(call).toHaveBeenNthCalledWith(1, "task_workspace_begin", {
      input: expect.objectContaining({
        workspaceRoot: "/repo",
        base: { kind: "gitRef", gitRef: "origin/dev" },
      }),
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  // Settles the run the session actually has open. The caller's turn counter
  // used to gate this and vetoed real settles, because a bundle run's id
  // carries a per-workspace suffix and the counter had often already moved on.
  it("settles the session's open chat run", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task:message",
      runId: runIdForTurn("session", 3),
      sessionId: "session",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    call.mockResolvedValueOnce([]).mockResolvedValueOnce(null)

    await expect(settleTaskWorkspaceTurn("session", 3)).resolves.toEqual([])
    expect(call).toHaveBeenCalledWith("task_workspace_settle", {
      runId: runIdForTurn("session", 3),
      finalState: "ready",
    })
  })

  it("does not create a fake complete run when tracking is unavailable", async () => {
    call.mockRejectedValueOnce(new Error("unknown.command"))
    await expect(
      beginTaskWorkspaceTurn({
        taskId: "task:message",
        sessionId: "unavailable-session",
        runId: "run:unavailable:1",
        agentId: "built-in",
        agentKind: "in-app",
        workspaceRoot: "/repo",
      })
    ).resolves.toBeNull()
    expect(useTaskWorkspaceStore.getState().activeBySession["unavailable-session"]).toBeUndefined()
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
      allowIrreversible: false,
    })
  })

  it("exposes Registry inventory and lifecycle policy through the shared transport", async () => {
    const policy = { activeDirectoryCap: 15, snapshotRetentionDays: 30, blobBudgetBytes: 1 << 30 }
    call
      .mockResolvedValueOnce([{ workspaceId: "ws-1" }])
      .mockResolvedValueOnce([{ bundleId: "bundle-1" }])
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce({ workspaceId: "ws-1", pinned: true })

    await listManagedWorkspaces()
    await listWorkspaceBundles()
    await getWorkspaceLifecyclePolicy()
    await setWorkspaceLifecyclePolicy(policy)
    await pinManagedWorkspace("ws-1", true)

    expect(call.mock.calls).toEqual([
      ["task_workspace_managed_list"],
      ["task_workspace_bundle_list"],
      ["task_workspace_policy_get"],
      ["task_workspace_policy_set", { policy }],
      ["task_workspace_managed_pin", { workspaceId: "ws-1", pinned: true }],
    ])
  })

  it("loads the canonical ownership-aware environment inventory from the host", async () => {
    call.mockResolvedValueOnce([
      {
        environmentId: "manual:/repo/.worktrees/feature",
        workspaceId: null,
        path: "/repo/.worktrees/feature",
        sourceRoot: "/repo",
        ownership: "manual",
        ownerType: null,
        ownerRef: null,
        state: null,
        branch: "feature",
        head: "abc123",
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        base: null,
        pinned: false,
        allowedActions: ["open", "remove"],
      },
    ])

    await expect(listWorkspaceEnvironments("/repo")).resolves.toHaveLength(1)

    expect(call).toHaveBeenCalledWith("task_workspace_environment_list", {
      rootDir: "/repo",
    })
  })

  it("acquires all writable roots through the canonical bundle command", async () => {
    const input = {
      ownerType: "session" as const,
      ownerRef: "session-1",
      environmentKind: "managed" as const,
      base: { kind: "workingState" as const },
      roots: [
        { logicalRootId: "primary", role: "primary" as const, sourceRoot: "/repo" },
        { logicalRootId: "notes", role: "additional" as const, sourceRoot: "/notes" },
      ],
    }
    call.mockResolvedValueOnce({ bundleId: "bundle-1", leases: [] })

    await acquireWorkspaceBundle(input)

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_acquire", { input })
  })

  it("begins tracking inside a Registry bundle lease without reprovisioning", async () => {
    const input = {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/isolated/repo",
    }
    call.mockResolvedValueOnce({
      taskId: "task-1",
      runId: "run-1",
      executionRoot: "/isolated/repo",
      state: "running",
    })

    await beginTaskWorkspaceBundleTurn("bundle-1", "primary", input)

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_begin", {
      bundleId: "bundle-1",
      logicalRootId: "primary",
      input,
    })
  })

  describe("a conversation whose working copy is still held", () => {
    const input = {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/isolated/repo",
    }
    const lease = {
      bundleTurnId: "turn-2",
      bundleId: "bundle-1",
      primaryLogicalRootId: "primary",
      primaryAlias: "/isolated/repo",
      additionalAliases: [],
      runs: [
        {
          workspaceId: "ws-primary",
          logicalRootIds: ["primary"],
          run: {
            taskId: "task-primary",
            runId: "run-primary",
            executionRoot: "/isolated/repo",
            state: "running",
          },
        },
      ],
      state: "running",
      createdAt: 1,
      settledAt: null,
    }

    // The reload case. A turn nothing is driving any more held the execution
    // root, and before this the conversation was refused for good.
    it("releases what this browser abandoned, then begins", async () => {
      call
        .mockRejectedValueOnce(new Error("pipeline workspace is already active: session-1"))
        .mockResolvedValueOnce(lease)
      reclaim.mockResolvedValue(["turn-1"])

      await expect(
        beginWorkspaceBundleTurn("bundle-1", { primaryLogicalRootId: "primary", run: input })
      ).resolves.toMatchObject({ bundleTurnId: "turn-2" })
      expect(reclaim).toHaveBeenCalledWith("session-1")
      expect(call).toHaveBeenCalledTimes(2)
    })

    // Nothing was released, so the turn holding the root is live somewhere and
    // the refusal was right. Retrying would only refuse again, and swallowing
    // it would send a turn with no working copy.
    it("keeps the refusal when nothing was abandoned", async () => {
      call.mockRejectedValue(new Error("pipeline workspace is already active: session-1"))
      reclaim.mockResolvedValue([])

      await expect(
        beginWorkspaceBundleTurn("bundle-1", { primaryLogicalRootId: "primary", run: input })
      ).rejects.toThrow("already active")
      expect(call).toHaveBeenCalledTimes(1)
    })

    // Only this one refusal is retried. Any other failure is the host saying
    // something a second identical call cannot change.
    it("does not retry a different failure", async () => {
      call.mockRejectedValue(new Error("workspace is not a directory: /isolated/repo"))
      await expect(
        beginWorkspaceBundleTurn("bundle-1", { primaryLogicalRootId: "primary", run: input })
      ).rejects.toThrow("not a directory")
      expect(reclaim).not.toHaveBeenCalled()
      expect(call).toHaveBeenCalledTimes(1)
    })

    // A host that defers the whole plane still answers null rather than
    // throwing, which is what lets a turn run unmanaged.
    it("still defers to a host that will not run the plane", async () => {
      call.mockRejectedValue(new Error("remote control is not authorized"))
      await expect(
        beginWorkspaceBundleTurn("bundle-1", { primaryLogicalRootId: "primary", run: input })
      ).resolves.toBeNull()
      expect(reclaim).not.toHaveBeenCalled()
    })

    it("records the turn it opened so a later page can release it", async () => {
      call.mockResolvedValueOnce(lease)
      await beginWorkspaceBundleTurn("bundle-1", { primaryLogicalRootId: "primary", run: input })
      expect(remember).toHaveBeenCalledWith(
        expect.objectContaining({ bundleTurnId: "turn-2", sessionId: "session-1" })
      )
    })
  })

  it("begins and settles a persisted multi-root bundle turn as one host transaction", async () => {
    const input = {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/isolated/repo",
    }
    call
      .mockResolvedValueOnce({
        bundleTurnId: "turn-1",
        bundleId: "bundle-1",
        primaryLogicalRootId: "primary",
        primaryAlias: "/isolated/repo",
        additionalAliases: ["/isolated/notes"],
        runs: [
          {
            workspaceId: "ws-primary",
            logicalRootIds: ["primary"],
            run: {
              taskId: "task-primary",
              runId: "run-primary",
              executionRoot: "/isolated/repo",
              state: "running",
            },
          },
          {
            workspaceId: "ws-notes",
            logicalRootIds: ["notes"],
            run: {
              taskId: "task-notes",
              runId: "run-notes",
              executionRoot: "/isolated/notes",
              state: "running",
            },
          },
        ],
        state: "running",
        createdAt: 1,
        settledAt: null,
      })
      .mockResolvedValueOnce({
        bundleTurnId: "turn-1",
        bundleId: "bundle-1",
        state: "ready",
        runs: [
          {
            workspaceId: "ws-primary",
            logicalRootIds: ["primary"],
            runId: "run-primary",
            state: "ready",
            resources: [],
          },
          {
            workspaceId: "ws-notes",
            logicalRootIds: ["notes"],
            runId: "run-notes",
            state: "ready",
            resources: [],
          },
        ],
        resources: [],
        settledAt: 2,
      })

    await beginWorkspaceBundleTurn("bundle-1", {
      primaryLogicalRootId: "primary",
      run: input,
    })
    await settleWorkspaceBundleTurn("turn-1", "ready")

    expect(Object.keys(useTaskWorkspaceStore.getState().activeByRun).sort()).toEqual([
      "run-notes",
      "run-primary",
    ])
    expect(useTaskWorkspaceStore.getState().activeBySession["session-1"].runId).toBe("run-primary")
    expect(useTaskWorkspaceStore.getState().activeByRun["run-notes"].state).toBe("ready")

    expect(call.mock.calls).toEqual([
      [
        "task_workspace_bundle_turn_begin",
        {
          bundleId: "bundle-1",
          request: { primaryLogicalRootId: "primary", run: input },
        },
      ],
      [
        "task_workspace_bundle_turn_settle",
        {
          bundleTurnId: "turn-1",
          finalState: "ready",
        },
      ],
    ])
  })

  it("routes protected environment lifecycle actions through the Registry", async () => {
    call
      .mockResolvedValueOnce({ workspaceId: "ws-1", environmentKind: "permanent" })
      .mockResolvedValueOnce({ workspaceId: "ws-2", state: "archived" })
      .mockResolvedValueOnce({ workspaceId: "ws-2", state: "active" })
      .mockResolvedValueOnce(undefined)

    await makeManagedWorkspacePermanent("ws-1")
    await archiveManagedWorkspace("ws-2")
    await restoreManagedWorkspace("ws-2")
    await deleteManagedWorkspace("ws-2")

    expect(call.mock.calls).toEqual([
      ["task_workspace_managed_permanent", { workspaceId: "ws-1" }],
      ["task_workspace_managed_archive", { workspaceId: "ws-2" }],
      ["task_workspace_managed_restore", { workspaceId: "ws-2" }],
      ["task_workspace_managed_delete", { workspaceId: "ws-2" }],
    ])
  })

  it("creates a promotion branch through the ownership-validated host command", async () => {
    call.mockResolvedValueOnce({ workspaceId: "ws-1", branch: "feature/review" })

    await createWorkspaceBranch("ws-1", "feature/review")

    expect(call).toHaveBeenCalledWith("task_workspace_environment_create_branch", {
      workspaceId: "ws-1",
      branch: "feature/review",
    })
  })

  it("adopts imported environments only through the explicit Registry command", async () => {
    call.mockResolvedValueOnce({ workspaceId: "ws-imported", environmentKind: "managed" })

    await adoptManagedWorkspace("ws-imported")

    expect(call).toHaveBeenCalledWith("task_workspace_managed_adopt", {
      workspaceId: "ws-imported",
    })
  })

  it("adopts a selected manual worktree only after host identity revalidation", async () => {
    call.mockResolvedValueOnce({ workspaceId: "ws-adopted", environmentKind: "managed" })

    await adoptWorkspaceEnvironment("git:manual-id", "/repo", "/repo/.worktrees/feature")

    expect(call).toHaveBeenCalledWith("task_workspace_environment_adopt", {
      environmentId: "git:manual-id",
      sourceRoot: "/repo",
      path: "/repo/.worktrees/feature",
    })
  })

  it("reconciles signed and imported worktrees through the host", async () => {
    call.mockResolvedValueOnce({ reclaimed: ["ws-1"], orphaned: [], imported: [] })

    await reconcileManagedWorkspaces()

    expect(call).toHaveBeenCalledWith("task_workspace_reconcile")
  })

  it("exposes host-owned maintenance execution and durable history", async () => {
    call
      .mockResolvedValueOnce({
        startedAt: 1,
        finishedAt: 2,
        reconcile: { reclaimed: [], orphaned: [], imported: [] },
        reclaimedWorkspaceIds: [],
        expiredSnapshotTaskIds: [],
        removedBlobCount: 0,
        reclaimedBytes: 0,
        events: [],
      })
      .mockResolvedValueOnce([{ eventId: "event-1", kind: "reconciled" }])

    await runWorkspaceMaintenance()
    await listWorkspaceMaintenanceEvents(100)

    expect(call.mock.calls).toEqual([
      ["task_workspace_maintenance_run", { request: { now: null } }],
      ["task_workspace_maintenance_events", { limit: 100 }],
    ])
  })

  it("restores a historical content-addressed snapshot", async () => {
    call.mockResolvedValueOnce({ runId: "run:session:1", executionRoot: "/isolated" })
    await expect(restoreTaskWorkspaceSnapshot("run:session:1")).resolves.toEqual(
      expect.objectContaining({ executionRoot: "/isolated" })
    )
    expect(call).toHaveBeenCalledWith("task_workspace_restore_snapshot", {
      runId: "run:session:1",
    })
  })

  it("forwards the one-shot irreversible apply override", async () => {
    call
      .mockResolvedValueOnce({ state: "applied", revision: 2, conflicts: [] })
      .mockResolvedValueOnce({ runId: "run:session:1", state: "applied" })

    await applyTaskWorkspace("run:session:1", [], true)

    expect(call).toHaveBeenCalledWith("task_workspace_apply", {
      runId: "run:session:1",
      selection: [],
      allowIrreversible: true,
    })
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run:session:1" }),
      "apply"
    )
  })

  it("applies a multi-root handoff through one persisted Bundle transaction", async () => {
    const request = {
      bundleTurnId: "turn-1",
      selections: [
        {
          workspaceId: "ws-1",
          logicalRootId: "primary",
          selection: [{ path: "src/app.ts", hunkIds: ["h1"] }],
        },
      ],
      allowIrreversible: false,
    }
    call.mockResolvedValueOnce({
      bundleTurnId: "turn-1",
      outcome: {
        bundleId: "bundle-1",
        applied: ["ws-1"],
        rolledBack: [],
        conflicts: [],
        state: "active",
      },
    })

    await applyWorkspaceBundle("bundle-1", request)

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_apply", {
      bundleId: "bundle-1",
      request,
    })
  })

  it("recovers the persisted outcome of a multi-root handoff", async () => {
    call.mockResolvedValueOnce({ bundleTurnId: "turn-1", outcome: { state: "applied" } })

    await getBundleHandoffOutcome("turn-1")

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_handoff_get", {
      bundleTurnId: "turn-1",
    })
  })

  it("retries only the persisted conflicted Bundle handoff request", async () => {
    const request = {
      bundleTurnId: "turn-1",
      selections: [],
      allowIrreversible: false,
    }
    call.mockResolvedValueOnce({ bundleTurnId: "turn-1", request, outcome: { state: "applied" } })

    await retryWorkspaceBundleHandoff("bundle-1", request)

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_handoff_retry", {
      bundleId: "bundle-1",
      request,
    })
  })

  it("undoes and recovers the persisted Bundle handoff as one transaction", async () => {
    call
      .mockResolvedValueOnce({ bundleTurnId: "turn-1", bundleId: "bundle-1", state: "active" })
      .mockResolvedValueOnce({ bundleTurnId: "turn-1", bundleId: "bundle-1", state: "active" })

    await undoWorkspaceBundleHandoff("bundle-1", "turn-1")
    await getBundleHandoffUndoOutcome("turn-1")

    expect(call.mock.calls).toEqual([
      ["task_workspace_bundle_handoff_undo", { bundleId: "bundle-1", bundleTurnId: "turn-1" }],
      ["task_workspace_bundle_handoff_undo_get", { bundleTurnId: "turn-1" }],
    ])
  })

  it("exposes durable resource timeline, summary, and manifest commands", async () => {
    call
      .mockResolvedValueOnce([{ eventId: "event-1", seq: 8 }])
      .mockResolvedValueOnce({ runId: "run:session:1", eventCount: 1 })
      .mockResolvedValueOnce({ schemaVersion: 1, events: [] })

    await expect(listTaskResourceEvents("run:session:1", 7, 25)).resolves.toEqual([
      { eventId: "event-1", seq: 8 },
    ])
    await getTaskResourceSummary("run:session:1")
    await exportTaskResourceManifest("task:message", "run:session:1")

    expect(call).toHaveBeenNthCalledWith(1, "task_workspace_list_resource_events", {
      runId: "run:session:1",
      cursor: 7,
      limit: 25,
    })
    expect(call).toHaveBeenNthCalledWith(2, "task_workspace_get_resource_summary", {
      runId: "run:session:1",
    })
    expect(call).toHaveBeenNthCalledWith(3, "task_workspace_export_resource_manifest", {
      taskId: "task:message",
      runId: "run:session:1",
    })
  })

  it("records tool evidence as a provisional causal hint", async () => {
    call.mockResolvedValueOnce({ eventId: "event-tool", evidence: "tool" })
    await recordTaskResourceToolEvent({
      runId: "run:session:1",
      path: "src/a.ts",
      kind: "modified",
      toolCallId: "tool-1",
    })
    expect(call).toHaveBeenCalledWith("task_workspace_record_tool_event", {
      runId: "run:session:1",
      path: "src/a.ts",
      kind: "modified",
      toolCallId: "tool-1",
    })
  })
})

describe("settling a bundle turn", () => {
  // The defect: a bundle turn's run id is `run:<session>:<n>:<workspace>`, and
  // the guard compared it against the unsuffixed `runIdForTurn`. It never
  // matched, so no managed chat turn ever settled, the run stayed `running`,
  // and the session's NEXT turn was refused with "pipeline workspace is already
  // active" for good.
  it("recognises a turn whose run id carries a per-workspace suffix", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-workspace:session",
      runId: `${runIdForTurn("session", 4)}:ws-a`,
      executionRunId: runIdForTurn("session", 4),
      bundleTurnId: "turn-1",
      sessionId: "session",
      workspaceRoot: "/repo",
      executionRoot: "/isolated/a",
      state: "running",
    })
    call.mockResolvedValueOnce({
      bundleTurnId: "turn-1",
      runs: [{ runId: `${runIdForTurn("session", 4)}:ws-a`, resources: [] }],
    })

    await expect(settleTaskWorkspaceTurn("session", 4, "failed")).resolves.toEqual([])
    expect(call).toHaveBeenCalledWith("task_workspace_bundle_turn_settle", {
      bundleTurnId: "turn-1",
      finalState: "failed",
    })
  })

  // One turn owns one run per distinct physical workspace, and only the last
  // activation survives in `activeBySession`. Settling that run alone would
  // strand every additional root's run.
  it("settles the turn rather than the one run it happens to be holding", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-workspace:session",
      runId: `${runIdForTurn("session", 5)}:ws-primary`,
      executionRunId: runIdForTurn("session", 5),
      bundleTurnId: "turn-2",
      sessionId: "session",
      workspaceRoot: "/repo",
      executionRoot: "/isolated/primary",
      state: "running",
    })
    call.mockResolvedValueOnce({
      bundleTurnId: "turn-2",
      runs: [
        { runId: `${runIdForTurn("session", 5)}:ws-a`, resources: [] },
        { runId: `${runIdForTurn("session", 5)}:ws-b`, resources: [] },
      ],
    })

    await settleTaskWorkspaceTurn("session", 5)

    expect(call).not.toHaveBeenCalledWith("task_workspace_settle", expect.anything())
    expect(call).toHaveBeenCalledWith("task_workspace_bundle_turn_settle", {
      bundleTurnId: "turn-2",
      finalState: "ready",
    })
  })

  // The chat store's per-session counter has already moved on by the time some
  // settle edges fire, so a derived turn id disagreed with the live run and the
  // settle was skipped. `activeBySession` is by construction the one run this
  // session has open, so the counter must not be able to veto it.
  it("settles the session's open run whatever the caller's turn counter says", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-workspace:session",
      runId: `${runIdForTurn("session", 6)}:ws-a`,
      executionRunId: runIdForTurn("session", 6),
      bundleTurnId: "turn-3",
      sessionId: "session",
      workspaceRoot: "/repo",
      executionRoot: "/isolated/a",
      state: "running",
    })
    call.mockResolvedValueOnce({ bundleTurnId: "turn-3", runs: [] })

    await settleTaskWorkspaceTurn("session", 7)

    expect(call).toHaveBeenCalledWith("task_workspace_bundle_turn_settle", {
      bundleTurnId: "turn-3",
      finalState: "ready",
    })
  })

  it("has nothing to settle for a session with no open run", async () => {
    await expect(settleTaskWorkspaceTurn("session-with-none", 1)).resolves.toBeNull()
  })
})

describe("the lookups that answer null", () => {
  /**
   * Six task-workspace getters are `T | null` in TypeScript and `Option` in
   * Rust, and the client is built around that: `getWorkspaceBundle` answering
   * null is exactly how `ensureSessionExecutionBundle` learns to acquire a
   * fresh bundle. Typing them as a bare object in the response contract turned
   * that ordinary answer into a `contract_output_violation` 500, which every
   * companion hit after a host-side workspace reset or GC.
   */
  it("keeps null in the response contract for every nullable getter", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), "protocol/companion-response-schemas.json"), "utf8")
    ) as {
      $defs: Record<string, { type?: unknown }>
      commands: Record<string, { $ref?: string }>
    }

    for (const command of [
      "task_workspace_bundle_get",
      "task_workspace_get",
      "task_workspace_managed_get",
      "task_workspace_bundle_turn_get",
      "task_workspace_bundle_handoff_get",
      "task_workspace_bundle_handoff_undo_get",
    ]) {
      const ref = contract.commands[command]?.$ref
      expect(ref).toBe("#/$defs/NullableLegacyRecord")
    }
    expect(contract.$defs.NullableLegacyRecord.type).toEqual(["object", "null"])
  })
})

describe("the settle carries its own approval", () => {
  /**
   * The settle is driven by the chat status edge, not by
   * `openWorkspaceBundleTurnLease`, so the turn scope that covered the rest of
   * the turn is closed by then and no one-shot lease is parked. Called bare it
   * was answered `interactive_approval_required`, the `catch` swallowed the
   * refusal, and the run stayed `running` after a turn that had completed
   * perfectly, wedging the session's next turn.
   */
  it("wraps the bundle settle so a companion is not refused", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-workspace:approved",
      runId: `${runIdForTurn("approved", 1)}:ws-a`,
      executionRunId: runIdForTurn("approved", 1),
      bundleTurnId: "turn-approved",
      sessionId: "approved",
      workspaceRoot: "/repo",
      executionRoot: "/isolated/a",
      state: "running",
    })
    call.mockResolvedValueOnce({ bundleTurnId: "turn-approved", runs: [] })

    await settleTaskWorkspaceTurn("approved", 1)

    expect(userAction).toHaveBeenCalledWith(
      "task_workspace_bundle_turn_settle",
      expect.any(Function)
    )
  })

  it("wraps the legacy settle for the same reason", async () => {
    useTaskWorkspaceStore.getState().activate({
      taskId: "task-workspace:legacy",
      runId: runIdForTurn("legacy", 2),
      sessionId: "legacy",
      workspaceRoot: "/repo",
      executionRoot: "/isolated",
      state: "running",
    })
    call.mockResolvedValueOnce([]).mockResolvedValueOnce(null)

    await settleTaskWorkspaceTurn("legacy", 2)

    expect(userAction).toHaveBeenCalledWith("task_workspace_settle", expect.any(Function))
  })
})

describe("the settle request contract", () => {
  /**
   * Both settles hand the Host a terminal `RunState`, which is a camelCase
   * string on the wire. The bundle variant declared `finalState` as an object,
   * so every settle of a bundle turn was refused 422 and the run stayed
   * `running` after a turn that had completed, wedging the session's next turn.
   */
  it("declares finalState the same way for both settles", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), "protocol/companion-request-schemas.json"), "utf8")
    ) as {
      commands: Record<string, { properties: { finalState?: { type?: string; enum?: string[] } } }>
    }

    const legacy = contract.commands.task_workspace_settle.properties.finalState
    const bundle = contract.commands.task_workspace_bundle_turn_settle.properties.finalState
    expect(bundle?.type).toBe("string")
    expect(bundle?.enum).toEqual(legacy?.enum)
    expect(bundle?.enum).toEqual(["ready", "failed", "cancelled"])
  })
})
