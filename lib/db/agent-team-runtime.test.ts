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
  markAgentTeamCheckpoint,
  purgeAgentTeamRun,
  purgeAgentTeam,
  putAgentTeamContent,
  renewAgentTeamDispatchLease,
  settleAgentTeamDispatchLease,
  updateAgentTeamSteeringReceipt,
  updateAgentTeamChildRun,
  updateAgentTeamChildRunIfCurrent,
} from "./agent-team-runtime"

describe("durable AgentTeam runtime persistence", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    await indexedDB.deleteDatabase(LEGACY_COGNIA_DB_NAME)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
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
    expect(await settleAgentTeamDispatchLease("child-lease", "lease-b", 23)).toBe(false)
    expect(await settleAgentTeamDispatchLease("child-lease", "lease-a", 23)).toBe(true)
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
