import "fake-indexeddb/auto"

import {
  __enableDbRuntimeForTesting,
  __resetDbForTesting,
  getDb,
  LEGACY_COGNIA_DB_NAME,
} from "./schema"
import {
  appendAgentTeamTrajectory,
  advanceAgentTeamRemoteEvent,
  aggregateAgentTeamRunUsage,
  claimAgentTeamDispatchLease,
  createAgentTeamChildRun,
  createAgentTeamRun,
  createAgentTeamSteeringReceipt,
  getAgentTeamChildRun,
  getAgentTeamRun,
  listAgentTeamRecoveryCandidates,
  listAgentTeamRuns,
  listAgentTeamTrajectory,
  listAgentTeamEvidence,
  markAgentTeamCheckpoint,
  purgeAgentTeamRun,
  purgeAgentTeam,
  putAgentTeamContent,
  putAgentTeamEvidenceContent,
  renewAgentTeamDispatchLease,
  settleAgentTeamDispatchLease,
  updateAgentTeamSteeringReceipt,
  updateAgentTeamChildRun,
  updateAgentTeamChildRunIfCurrent,
  updateAgentTeamRunIfCurrent,
} from "./agent-team-runtime"

const mockAgentInvoke = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => mockAgentInvoke(...args),
}))

describe("durable AgentTeam runtime persistence", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    mockAgentInvoke.mockReset().mockResolvedValue(undefined)
    disableDbRuntime = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    await indexedDB.deleteDatabase(LEGACY_COGNIA_DB_NAME)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("scopes evidence to a run, child, task and attempt in creation order", async () => {
    for (const row of [
      { id: "old", runId: "run", childRunId: "child", taskId: "task", attempt: 1, createdAt: 1 },
      { id: "newer", runId: "run", childRunId: "child", taskId: "task", attempt: 2, createdAt: 4 },
      {
        id: "earlier",
        runId: "run",
        childRunId: "child",
        taskId: "task",
        attempt: 2,
        createdAt: 3,
      },
      {
        id: "other-child",
        runId: "run",
        childRunId: "other",
        taskId: "task",
        attempt: 2,
        createdAt: 2,
      },
      {
        id: "other-task",
        runId: "run",
        childRunId: "child",
        taskId: "other-task",
        attempt: 2,
        createdAt: 5,
      },
      {
        id: "other-run",
        runId: "other-run",
        childRunId: "child",
        taskId: "task",
        attempt: 2,
        createdAt: 6,
      },
    ])
      await putAgentTeamEvidenceContent({ ...row, kind: "activity", title: row.id })
    expect(
      (await listAgentTeamEvidence("run", { childRunId: "child", taskId: "task", attempt: 2 })).map(
        (row) => row.id
      )
    ).toEqual(["earlier", "newer"])
    expect(
      (await listAgentTeamEvidence("run", { taskId: "task", attempt: 2 })).map((row) => row.id)
    ).toEqual(["other-child", "earlier", "newer"])
    expect((await listAgentTeamEvidence("run")).map((row) => row.id)).toEqual([
      "old",
      "other-child",
      "earlier",
      "newer",
      "other-task",
    ])
  })

  it("persists a recoverable child trajectory with monotonic checkpoints", async () => {
    await createAgentTeamRun({
      id: "run-1",
      teamId: "team-1",
      projectId: "project-1",
      objective: "Ship the durable runtime",
      decisionVersion: 0,
      environmentVersionId: "env-v1",
      priority: 3,
      status: "running",
      createdAt: 10,
      updatedAt: 10,
    })
    await createAgentTeamChildRun({
      id: "child-1",
      runId: "run-1",
      teamId: "team-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      attempt: 1,
      status: "running",
      createdAt: 11,
      updatedAt: 11,
      resourceUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        wallTimeMs: 0,
        toolTimeMs: 0,
        attempts: 1,
        failures: 0,
      },
    })

    const first = await appendAgentTeamTrajectory({
      runId: "run-1",
      childRunId: "child-1",
      kind: "model_turn_started",
      correlationId: "turn-1",
      createdAt: 12,
      payload: { prompt: "redacted prompt" },
    })
    const second = await appendAgentTeamTrajectory({
      runId: "run-1",
      childRunId: "child-1",
      kind: "tool_result",
      correlationId: "tool-1",
      createdAt: 13,
      payload: { ok: true },
    })
    const checkpoint = await markAgentTeamCheckpoint({
      runId: "run-1",
      childRunId: "child-1",
      trajectorySequence: second.sequence,
      decisionVersion: 0,
      replay: "safe",
      sideEffects: [],
      createdAt: 14,
    })

    expect([first.sequence, second.sequence]).toEqual([1, 2])
    expect((await listAgentTeamTrajectory("run-1")).map((event) => event.sequence)).toEqual([1, 2])
    expect((await getAgentTeamChildRun("child-1"))?.lastCheckpointId).toBe(checkpoint.id)
    expect((await listAgentTeamRecoveryCandidates()).map((run) => run.id)).toEqual(["run-1"])
  })

  it("tracks queued steering independently from live delivery", async () => {
    await createAgentTeamRun({
      id: "run-2",
      teamId: "team-1",
      objective: "Steer safely",
      decisionVersion: 0,
      priority: 1,
      status: "paused",
      createdAt: 20,
      updatedAt: 20,
    })
    const queued = await createAgentTeamSteeringReceipt({
      id: "steer-1",
      runId: "run-2",
      childRunId: "child-2",
      message: "Check the migration",
      status: "queued",
      createdAt: 21,
      updatedAt: 21,
    })
    expect(queued.status).toBe("queued")

    await updateAgentTeamSteeringReceipt("steer-1", "delivered", 22)
    expect((await getDb().agentTeamSteeringReceipts.get("steer-1"))?.status).toBe("delivered")
  })

  it("uses the child row for lease CAS, renewal, settlement, and event dedupe", async () => {
    await createAgentTeamRun({
      id: "run-lease",
      teamId: "team-1",
      objective: "Dispatch once",
      decisionVersion: 0,
      priority: 1,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    })
    await createAgentTeamChildRun({
      id: "child-lease",
      runId: "run-lease",
      teamId: "team-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      attempt: 1,
      status: "queued",
      resourceUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        wallTimeMs: 0,
        toolTimeMs: 0,
        attempts: 1,
        failures: 0,
      },
      createdAt: 1,
      updatedAt: 1,
    })

    expect(
      await claimAgentTeamDispatchLease({
        childRunId: "child-lease",
        leaseId: "lease-a",
        hostRef: "device:a",
        now: 10,
      })
    ).toMatchObject({ dispatchLeaseId: "lease-a", dispatchLeaseExpiresAt: 60_010 })
    expect(
      await claimAgentTeamDispatchLease({
        childRunId: "child-lease",
        leaseId: "lease-b",
        hostRef: "device:b",
        now: 11,
      })
    ).toBeUndefined()
    expect(await renewAgentTeamDispatchLease("child-lease", "lease-b", 20)).toBe(false)
    expect(await renewAgentTeamDispatchLease("child-lease", "lease-a", 20)).toBe(true)
    expect(await advanceAgentTeamRemoteEvent("child-lease", undefined, "event-1", 21)).toBe(true)
    expect(await advanceAgentTeamRemoteEvent("child-lease", undefined, "event-1", 22)).toBe(false)
    await expect(
      advanceAgentTeamRemoteEvent("child-lease", "event-1", "event-2", 23, {
        runId: "wrong-run",
        event: { text: "no" },
      })
    ).rejects.toThrow("another run")
    expect((await getAgentTeamChildRun("child-lease"))?.lastRemoteEventId).toBe("event-1")
    const envelope = { type: "delta", text: "x".repeat(9000) }
    expect(
      await advanceAgentTeamRemoteEvent("child-lease", "event-1", "event-2", 24, {
        runId: "run-lease",
        event: envelope,
      })
    ).toBe(true)
    expect(
      await advanceAgentTeamRemoteEvent("child-lease", "event-1", "event-2", 25, {
        runId: "run-lease",
        event: envelope,
      })
    ).toBe(false)
    const events = await listAgentTeamTrajectory("run-lease")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: "remote_event", correlationId: "event-2" })
    expect(await getDb().agentTeamContentObjects.get(events[0]!.contentHash!)).toMatchObject({
      byteLength: 9026,
    })
    expect(await settleAgentTeamDispatchLease("child-lease", "lease-b", 23)).toBe(false)
    expect(await settleAgentTeamDispatchLease("child-lease", "lease-a", 23)).toBe(true)
  })

  it("rolls content back when evidence reference insertion fails", async () => {
    const fail = () => {
      throw new Error("reference rejected")
    }
    const db = getDb()
    db.agentTeamEvidence.hook("creating", fail)
    try {
      await expect(
        putAgentTeamEvidenceContent(
          {
            id: "evidence",
            runId: "run",
            taskId: "task",
            kind: "outcome",
            title: "result",
            createdAt: 1,
          },
          "payload"
        )
      ).rejects.toThrow("reference rejected")
      expect(await db.agentTeamContentObjects.count()).toBe(0)
    } finally {
      db.agentTeamEvidence.hook("creating").unsubscribe(fail)
    }
  })

  it("atomically retains other runs' shared content while deleting only owned orphans", async () => {
    const row = { taskId: "task", kind: "outcome" as const, title: "result", createdAt: 1 }
    const shared = await putAgentTeamEvidenceContent(
      { ...row, id: "a", runId: "removed" },
      "shared"
    )
    await putAgentTeamEvidenceContent({ ...row, id: "b", runId: "live" }, "shared")
    const owned = await putAgentTeamEvidenceContent({ ...row, id: "c", runId: "removed" }, "owned")
    const inFlight = await putAgentTeamContent("not yet referenced", "text/plain", 1)
    await purgeAgentTeamRun("removed")
    expect(await getDb().agentTeamContentObjects.get(shared.contentHash!)).toBeDefined()
    expect(await getDb().agentTeamContentObjects.get(owned.contentHash!)).toBeUndefined()
    expect(await getDb().agentTeamContentObjects.get(inFlight.hash)).toBeDefined()
  })

  it("stores trajectory bytes and reference in one transaction", async () => {
    const event = await appendAgentTeamTrajectory(
      { runId: "run", kind: "model_turn_completed", createdAt: 1 },
      { data: "result", mimeType: "text/plain" }
    )
    expect(event.contentHash).toMatch(/^sha256:/)
    expect(await getDb().agentTeamContentObjects.get(event.contentHash!)).toMatchObject({
      byteLength: 6,
    })
  })

  it("recovers only runs interrupted during active execution", async () => {
    for (const [index, status] of [
      "queued",
      "running",
      "pausing",
      "paused",
      "sleeping",
      "recovering",
      "needs_input",
    ].entries()) {
      await createAgentTeamRun({
        id: `run-${status}`,
        teamId: "team-recovery",
        objective: "Preserve deliberate runtime states",
        decisionVersion: 0,
        priority: 1,
        status: status as Parameters<typeof createAgentTeamRun>[0]["status"],
        createdAt: 30 + index,
        updatedAt: 30 + index,
      })
    }

    expect((await listAgentTeamRecoveryCandidates()).map((run) => run.id).sort()).toEqual([
      "run-pausing",
      "run-recovering",
      "run-running",
    ])
  })

  it("deduplicates content by digest and purges a complete run graph", async () => {
    await createAgentTeamRun({
      id: "run-3",
      teamId: "team-1",
      objective: "Collect evidence",
      decisionVersion: 0,
      priority: 1,
      status: "completed",
      createdAt: 30,
      updatedAt: 31,
    })
    const first = await putAgentTeamContent("same evidence", "text/plain", 32)
    const second = await putAgentTeamContent("same evidence", "text/plain", 33)
    expect(second.hash).toBe(first.hash)
    expect(await getDb().agentTeamContentObjects.count()).toBe(1)

    await purgeAgentTeamRun("run-3")
    expect(await getAgentTeamRun("run-3")).toBeUndefined()
  })

  it("aggregates real child usage without inventing a synthetic unit", async () => {
    await createAgentTeamRun({
      id: "run-usage",
      teamId: "team-1",
      objective: "Measure work",
      decisionVersion: 0,
      priority: 1,
      status: "running",
      createdAt: 40,
      updatedAt: 40,
    })
    for (const [index, totalTokens] of [30, 70].entries()) {
      await createAgentTeamChildRun({
        id: `child-usage-${index}`,
        runId: "run-usage",
        teamId: "team-1",
        teammateId: `mate-${index}`,
        taskId: `task-${index}`,
        repositoryId: "primary",
        attempt: 1,
        status: "running",
        createdAt: 41 + index,
        updatedAt: 41 + index,
        resourceUsage: {
          promptTokens: totalTokens - 10,
          completionTokens: 10,
          totalTokens,
          wallTimeMs: 100 + index * 50,
          toolTimeMs: 20,
          attempts: 1,
          failures: 0,
        },
      })
      await updateAgentTeamChildRun(`child-usage-${index}`, { status: "completed" })
    }

    const usage = await aggregateAgentTeamRunUsage("run-usage", 50)
    expect(usage).toMatchObject({ totalTokens: 100, wallTimeMs: 150, toolTimeMs: 40, attempts: 2 })
    expect(usage).not.toHaveProperty("acu")
    expect((await getAgentTeamRun("run-usage"))?.resourceUsage).toEqual(usage)
  })

  it("conditionally updates a child only while status and version are current", async () => {
    await createAgentTeamRun({
      id: "run-cas",
      teamId: "team-1",
      objective: "Protect terminal state",
      decisionVersion: 0,
      priority: 1,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    })
    await createAgentTeamChildRun({
      id: "child-cas",
      runId: "run-cas",
      teamId: "team-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      attempt: 1,
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      resourceUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        wallTimeMs: 0,
        toolTimeMs: 0,
        attempts: 1,
        failures: 0,
      },
    })

    await expect(
      updateAgentTeamChildRunIfCurrent(
        "child-cas",
        { status: "running", updatedAt: 2 },
        { status: "pausing", updatedAt: 3 }
      )
    ).resolves.toBe(true)
    await expect(
      updateAgentTeamChildRunIfCurrent(
        "child-cas",
        { status: "running", updatedAt: 2 },
        { status: "paused", updatedAt: 4 }
      )
    ).resolves.toBe(false)
    await expect(
      updateAgentTeamChildRunIfCurrent(
        "child-cas",
        { status: "pausing", updatedAt: 2 },
        { status: "paused", updatedAt: 4 }
      )
    ).resolves.toBe(false)
    expect(await getAgentTeamChildRun("child-cas")).toMatchObject({
      status: "pausing",
      updatedAt: 3,
    })
  })

  it("does not let a stale recovery update overwrite a run's terminal state", async () => {
    await createAgentTeamRun({
      id: "run-terminal",
      teamId: "team",
      objective: "Protect terminal state",
      decisionVersion: 0,
      priority: 1,
      status: "running",
      createdAt: 1,
      updatedAt: 2,
    })
    const expected = { status: "running" as const, updatedAt: 2 }
    const results = await Promise.all([
      updateAgentTeamRunIfCurrent("run-terminal", expected, { status: "terminated", updatedAt: 3 }),
      updateAgentTeamRunIfCurrent("run-terminal", expected, { status: "recovering", updatedAt: 4 }),
    ])
    expect(results).toEqual([true, false])
    await expect(
      updateAgentTeamRunIfCurrent(
        "run-terminal",
        { status: "terminated", updatedAt: 2 },
        { status: "running" }
      )
    ).resolves.toBe(false)
    await expect(
      updateAgentTeamRunIfCurrent("missing", expected, { status: "running" })
    ).resolves.toBe(false)
    expect(await getAgentTeamRun("run-terminal")).toMatchObject({
      status: "terminated",
      updatedAt: 3,
    })
  })

  it("cleans managed native history before deleting rows and retains all team runs on failure", async () => {
    for (const suffix of ["a", "b"]) {
      await createAgentTeamRun({
        id: `run-${suffix}`,
        teamId: "managed-team",
        objective: "Cleanup",
        decisionVersion: 0,
        priority: 1,
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      })
      await createAgentTeamChildRun({
        id: `child-${suffix}`,
        runId: `run-${suffix}`,
        teamId: "managed-team",
        teammateId: `mate-${suffix}`,
        taskId: `task-${suffix}`,
        repositoryId: "primary",
        attempt: 1,
        status: "completed",
        sessionId: `cognia-gateway:gateway-${suffix}:native`,
        createdAt: 1,
        updatedAt: 1,
        resourceUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          wallTimeMs: 0,
          toolTimeMs: 0,
          attempts: 1,
          failures: 0,
        },
      })
    }
    mockAgentInvoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("native task is active"))
    await expect(purgeAgentTeam("managed-team")).rejects.toThrow("native task is active")
    expect(await listAgentTeamRuns("managed-team")).toHaveLength(2)
    expect(await getAgentTeamChildRun("child-a")).toBeDefined()
    expect(await getAgentTeamChildRun("child-b")).toBeDefined()
    await purgeAgentTeam("managed-team")
    expect(mockAgentInvoke).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
      taskId: "gateway-a",
    })
    expect(mockAgentInvoke).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
      taskId: "gateway-b",
    })
    expect(await listAgentTeamRuns("managed-team")).toEqual([])
  })

  it.each(["run", "team"])(
    "retains changed gateway links during %s deletion for retry",
    async (scope) => {
      await createAgentTeamRun({
        id: "run-race",
        teamId: "managed-team",
        objective: "Cleanup",
        decisionVersion: 0,
        priority: 1,
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      })
      await createAgentTeamChildRun({
        id: "child-race",
        runId: "run-race",
        teamId: "managed-team",
        teammateId: "mate",
        taskId: "task",
        repositoryId: "primary",
        attempt: 1,
        status: "completed",
        sessionId: "cognia-gateway:old-task:native",
        createdAt: 1,
        updatedAt: 1,
        resourceUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          wallTimeMs: 0,
          toolTimeMs: 0,
          attempts: 1,
          failures: 0,
        },
      })
      const purge = () =>
        scope === "run" ? purgeAgentTeamRun("run-race") : purgeAgentTeam("managed-team")
      mockAgentInvoke.mockImplementationOnce(async () => {
        await getDb().agentTeamChildRuns.update("child-race", {
          sessionId: "cognia-gateway:new-task:native",
        })
      })
      await expect(purge()).rejects.toThrow("tasks changed")
      expect(await getAgentTeamRun("run-race")).toBeDefined()
      expect(await getAgentTeamChildRun("child-race")).toMatchObject({
        sessionId: "cognia-gateway:new-task:native",
      })
      await purge()
      expect(mockAgentInvoke).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
        taskId: "new-task",
      })
      expect(await getAgentTeamRun("run-race")).toBeUndefined()
    }
  )

  it("deduplicates managed task cleanup across resumed child attempts", async () => {
    await createAgentTeamRun({
      id: "run-dedup",
      teamId: "managed-team",
      objective: "Cleanup",
      decisionVersion: 0,
      priority: 1,
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })
    for (const suffix of ["a", "b"])
      await createAgentTeamChildRun({
        id: `child-${suffix}`,
        runId: "run-dedup",
        teamId: "managed-team",
        teammateId: "mate",
        taskId: "task",
        repositoryId: "primary",
        attempt: 1,
        status: "completed",
        sessionId: "cognia-gateway:shared-task:native",
        createdAt: 1,
        updatedAt: 1,
        resourceUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          wallTimeMs: 0,
          toolTimeMs: 0,
          attempts: 1,
          failures: 0,
        },
      })
    await purgeAgentTeamRun("run-dedup")
    expect(mockAgentInvoke).toHaveBeenCalledTimes(1)
    expect(await getAgentTeamRun("run-dedup")).toBeUndefined()
  })

  it("purges every durable run for an explicitly deleted team", async () => {
    for (const id of ["run-team-a", "run-team-b"]) {
      await createAgentTeamRun({
        id,
        teamId: "team-delete",
        objective: "Delete explicitly",
        decisionVersion: 0,
        priority: 1,
        status: "completed",
        createdAt: 60,
        updatedAt: 60,
      })
    }
    await purgeAgentTeam("team-delete")
    expect(await listAgentTeamRuns("team-delete")).toEqual([])
  })
})
