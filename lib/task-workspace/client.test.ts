const call = jest.fn()
const subscribe = jest.fn()
const recordOutcome = jest.fn()

jest.mock("@/lib/code-adoption/outcome", () => ({
  recordTaskWorkspaceOutcome: (...args: unknown[]) => recordOutcome(...args),
}))

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
  onTauriEvent: (...args: unknown[]) => subscribe(...args),
}))

import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  applyTaskWorkspace,
  beginTaskWorkspaceTurn,
  exportTaskResourceManifest,
  getTaskResourceSummary,
  listTaskResourceEvents,
  recordTaskResourceToolEvent,
  listTaskWorkspaces,
  listManagedWorkspaces,
  listWorkspaceBundles,
  getWorkspaceLifecyclePolicy,
  setWorkspaceLifecyclePolicy,
  pinManagedWorkspace,
  resolveTaskWorkspaceConflict,
  runIdForTurn,
  settleTaskWorkspaceTurn,
  restoreTaskWorkspaceSnapshot,
  taskIdForMessage,
} from "./client"

describe("task workspace client", () => {
  beforeEach(() => {
    call.mockReset()
    subscribe.mockReset()
    recordOutcome.mockReset()
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
