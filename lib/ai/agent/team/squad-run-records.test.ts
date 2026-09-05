/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  LIVE_SQUAD_RUN_STATUSES,
  TERMINAL_SQUAD_RUN_STATUSES,
  createSquadRunRecords,
  findLiveSquadRun,
  isLiveSquadRunStatus,
  isTerminalSquadRunStatus,
  type SquadRunSeed,
} from "./squad-run-records"

const seed: SquadRunSeed = {
  runId: "run_team_abc",
  teamId: "team-1",
  projectId: "ws-1",
  sessionId: "s-1",
  objective: "Ship the thing",
  origin: "chat",
  priority: 2,
  environmentVersionId: "env:v3",
  startedAt: 1_000,
}

describe("createSquadRunRecords", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("creates the durable run and the execution run together, with the opening event", async () => {
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(true)
    expect(result.executionRunId).toBe("execution:team:run_team_abc")

    const run = await getDb().agentTeamRuns.get("run_team_abc")
    expect(run).toMatchObject({
      teamId: "team-1",
      projectId: "ws-1",
      objective: "Ship the thing",
      status: "queued",
      priority: 2,
      environmentVersionId: "env:v3",
      queueEnteredAt: 1_000,
    })

    const execution = await getDb().executionRuns.get("execution:team:run_team_abc")
    expect(execution).toMatchObject({
      kind: "team",
      sourceId: "run_team_abc",
      sessionId: "s-1",
      projectId: "ws-1",
      title: "Ship the thing",
      status: "running",
      currentRevision: 1,
    })
    const events = await getDb().executionRunEvents.where("runId").equals(execution!.id).toArray()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: { teamId: "team-1", origin: "chat" },
    })
  })

  /** An idempotency key that is replayed must find the run, never fork it. */
  it("is idempotent for the same run id", async () => {
    const first = await createSquadRunRecords(seed)
    const second = await createSquadRunRecords({ ...seed, startedAt: 9_999 })
    expect(second.created).toBe(false)
    expect(second.run).toEqual(first.run)
    expect(await getDb().agentTeamRuns.count()).toBe(1)
    expect(await getDb().executionRuns.count()).toBe(1)
    expect(await getDb().executionRunEvents.count()).toBe(1)
  })

  it("converges when only one of the two rows already exists", async () => {
    await getDb().agentTeamRuns.add({
      id: seed.runId,
      teamId: seed.teamId,
      objective: "older",
      status: "running",
      priority: 0,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(true)
    expect(result.run.objective).toBe("older")
    expect(await getDb().executionRuns.get(result.executionRunId)).toBeDefined()
  })

  it("refuses to attach a run id that belongs to another Squad", async () => {
    await createSquadRunRecords(seed)
    await expect(createSquadRunRecords({ ...seed, teamId: "team-2" })).rejects.toThrow(
      /belongs to another Squad/
    )
    expect(await getDb().executionRuns.count()).toBe(1)
  })

  it("links a replacement to the run it replaces", async () => {
    const result = await createSquadRunRecords({ ...seed, parentRunId: "execution:team:old" })
    expect(result.executionRun.parentRunId).toBe("execution:team:old")
  })

  /**
   * Fail closed: when the transaction cannot commit, neither row exists. A
   * caller that gets a throw starts nothing.
   */
  it("leaves nothing behind when the transaction fails", async () => {
    await getDb().executionRuns.add({
      id: "execution:team:run_team_abc",
      kind: "team",
      sourceId: "run_team_abc",
      title: "settled",
      status: "completed",
      currentRevision: 3,
      startedAt: 1,
      updatedAt: 2,
    })
    // The execution row exists and is terminal, so the durable row is created
    // and no event is appended: converge, do not throw.
    const result = await createSquadRunRecords(seed)
    expect(result.created).toBe(true)

    // Now force a real failure: a broken table write.
    const spy = jest
      .spyOn(getDb().agentTeamRuns, "add")
      .mockRejectedValueOnce(new Error("quota exceeded"))
    await getDb().agentTeamRuns.clear()
    await getDb().executionRuns.clear()
    await getDb().executionRunEvents.clear()
    await expect(createSquadRunRecords(seed)).rejects.toThrow(/quota exceeded/)
    expect(await getDb().executionRuns.count()).toBe(0)
    spy.mockRestore()
  })
})

describe("findLiveSquadRun", () => {
  let disableDbRuntime: (() => void) | undefined
  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("returns the newest live run and ignores terminal ones", async () => {
    const base = { teamId: "t", objective: "o", priority: 0, decisionVersion: 0, createdAt: 1 }
    await getDb().agentTeamRuns.bulkAdd([
      { ...base, id: "done", status: "completed", updatedAt: 50 },
      { ...base, id: "old-paused", status: "paused", updatedAt: 10 },
      { ...base, id: "live", status: "running", updatedAt: 20 },
    ])
    expect((await findLiveSquadRun("t"))?.id).toBe("live")
    expect(await findLiveSquadRun("other")).toBeUndefined()
  })

  it("partitions every status into live or terminal", () => {
    for (const status of LIVE_SQUAD_RUN_STATUSES) {
      expect(isLiveSquadRunStatus(status)).toBe(true)
      expect(isTerminalSquadRunStatus(status)).toBe(false)
    }
    for (const status of TERMINAL_SQUAD_RUN_STATUSES) {
      expect(isTerminalSquadRunStatus(status)).toBe(true)
      expect(isLiveSquadRunStatus(status)).toBe(false)
    }
  })
})
