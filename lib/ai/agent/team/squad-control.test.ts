/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const controlDurableRun = jest.fn(async (_runId: string, _action: string) => undefined)
jest.mock("./durable-control", () => ({
  controlDurableRun: (runId: string, action: string) => controlDurableRun(runId, action),
}))
const abortTeam = jest.fn((_teamId: string, _reason?: unknown) => true)
jest.mock("../agent-team-runtime", () => ({
  abortTeam: (teamId: string, reason?: unknown) => abortTeam(teamId, reason),
}))
const setTeamStatus = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => ({ setTeamStatus }) },
}))

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createRunInterrupt } from "@/lib/execution/run-control"
import type { AgentTeamCheckpoint, AgentTeamChildRun } from "@/types/agent/agent-team-runtime"
import { assessSquadRunReplay, controlSquadRun, controlSquadTeam } from "./squad-control"
import { createSquadRunRecords } from "./squad-run-records"

const RUN = "run_team_ctl01"
const EXECUTION = `execution:team:${RUN}`

async function seedRun(status: "queued" | "running" | "paused" | "completed" | "needs_input") {
  await createSquadRunRecords({
    runId: RUN,
    teamId: "team-1",
    objective: "o",
    origin: "chat",
    startedAt: 1_000,
  })
  await getDb().agentTeamRuns.update(RUN, { status })
}

function child(id: string, status: AgentTeamChildRun["status"]): AgentTeamChildRun {
  return {
    id,
    runId: RUN,
    teamId: "team-1",
    teammateId: "m1",
    taskId: `task-${id}`,
    repositoryId: "primary",
    status,
    attempt: 1,
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
  }
}

function checkpoint(
  childRunId: string,
  replay: "safe" | "needs_input",
  sideEffects: AgentTeamCheckpoint["sideEffects"] = []
): AgentTeamCheckpoint {
  return {
    id: `cp-${childRunId}-${replay}`,
    runId: RUN,
    childRunId,
    trajectorySequence: 1,
    decisionVersion: 0,
    replay,
    sideEffects,
    createdAt: 2,
  }
}

async function events() {
  return (await getDb().executionRunEvents.where("runId").equals(EXECUTION).toArray()).map(
    (event) => event.type
  )
}

describe("controlSquadRun legacy history", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("never resumes a backfilled legacy run, even when its status looks resumable", async () => {
    await seedRun("needs_input")
    await getDb().agentTeamRuns.update(RUN, { recoveryReason: "legacy_run_not_resumable" })
    const result = await controlSquadRun(RUN, "resume", { isLive: () => false })
    expect(result).toEqual({ ok: false, reason: "not_resumable", status: "needs_input" })
    expect(controlDurableRun).not.toHaveBeenCalled()
    expect(await events()).not.toContain("run.resumed")
  })

  it("still lets a backfilled legacy run stop", async () => {
    await seedRun("needs_input")
    await getDb().agentTeamRuns.update(RUN, { recoveryReason: "legacy_run_not_resumable" })
    const result = await controlSquadRun(RUN, "stop")
    expect(result).toEqual({ ok: true, status: "cancelled" })
    expect(await events()).toContain("run.cancelled")
  })
})

describe("controlSquadRun", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("refuses an unknown run and a settled one", async () => {
    expect(await controlSquadRun("nope", "pause")).toEqual({ ok: false, reason: "run_not_found" })
    await seedRun("completed")
    expect(await controlSquadRun(RUN, "stop")).toEqual({
      ok: false,
      reason: "already_terminal",
      status: "completed",
    })
    expect(controlDurableRun).not.toHaveBeenCalled()
  })

  it("pauses cooperatively through the coordinator and journals run.paused", async () => {
    await seedRun("running")
    const result = await controlSquadRun(RUN, "pause", { now: () => 5_000 })
    expect(result).toEqual({ ok: true, status: "paused" })
    expect(controlDurableRun).toHaveBeenCalledWith(RUN, "pause")
    expect((await events()).sort()).toEqual(["run.paused", "run.started"])
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "paused")
    expect((await getDb().executionRuns.get(EXECUTION))?.status).toBe("paused")
  })

  it("refuses to pause a run that is not running", async () => {
    await seedRun("paused")
    expect(await controlSquadRun(RUN, "pause")).toEqual({
      ok: false,
      reason: "not_pausable",
      status: "paused",
    })
  })

  it("resumes a live lifecycle by unpausing the coordinator", async () => {
    await seedRun("paused")
    const reenter = jest.fn(async () => undefined)
    const result = await controlSquadRun(RUN, "resume", {
      isLive: () => true,
      reenter,
      now: () => 5_000,
    })
    expect(result).toEqual({ ok: true, status: "running" })
    expect(controlDurableRun).toHaveBeenCalledWith(RUN, "resume")
    expect(reenter).not.toHaveBeenCalled()
    expect(await events()).toContain("run.resumed")
  })

  it("re-enters an exited lifecycle from a verified safe checkpoint", async () => {
    await seedRun("paused")
    await getDb().agentTeamChildRuns.add(child("c1", "paused"))
    await getDb().agentTeamCheckpoints.add(checkpoint("c1", "safe"))
    const reenter = jest.fn(async () => undefined)
    const result = await controlSquadRun(RUN, "resume", { isLive: () => false, reenter })
    expect(result).toEqual({ ok: true, status: "running" })
    expect(reenter).toHaveBeenCalledWith({ teamId: "team-1", runId: RUN })
    expect(controlDurableRun).not.toHaveBeenCalled()
    expect((await getDb().agentTeamRuns.get(RUN))?.status).toBe("running")
  })

  /** Never silently replay ambiguous side effects. */
  it("parks an uncertain resume on a recovery decision instead of replaying", async () => {
    await seedRun("paused")
    await getDb().agentTeamChildRuns.add(child("c1", "running"))
    await getDb().agentTeamCheckpoints.add(
      checkpoint("c1", "safe", [{ id: "e1", kind: "Bash", state: "unknown", replay: "unknown" }])
    )
    const reenter = jest.fn(async () => undefined)
    const result = await controlSquadRun(RUN, "resume", { isLive: () => false, reenter })
    expect(result).toEqual({ ok: false, reason: "recovery_required", status: "needs_input" })
    expect(reenter).not.toHaveBeenCalled()
    expect(await getDb().agentTeamRuns.get(RUN)).toMatchObject({
      status: "needs_input",
      recoveryReason: "uncertain_side_effect",
    })
    expect(await events()).toContain("run.waiting")
  })

  it("stops for good: aborts the lifecycle, cascades, denies pending reviews, journals", async () => {
    await seedRun("running")
    await createRunInterrupt({
      id: "action-review:squad-review:run_team_ctl01:plan:revision-0",
      runId: EXECUTION,
      type: "plan_approval",
      status: "pending",
      title: "plan",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      reviewKind: "plan",
    })
    const result = await controlSquadRun(RUN, "stop", { now: () => 9_000 })
    expect(result).toEqual({ ok: true, status: "cancelled" })
    expect(abortTeam).toHaveBeenCalledWith("team-1", expect.any(Error))
    expect(controlDurableRun).toHaveBeenCalledWith(RUN, "stop")
    const interrupt = await getDb().executionRunInterrupts.get(
      "action-review:squad-review:run_team_ctl01:plan:revision-0"
    )
    expect(interrupt?.status).toBe("expired")
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "cancelled")
    expect((await getDb().executionRuns.get(EXECUTION))?.status).toBe("cancelled")
  })

  it("addresses a team through its live run", async () => {
    await seedRun("running")
    expect(await controlSquadTeam("team-1", "pause")).toEqual({ ok: true, status: "paused" })
    expect(await controlSquadTeam("team-x", "pause")).toEqual({
      ok: false,
      reason: "run_not_found",
    })
  })
})

describe("assessSquadRunReplay", () => {
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

  it("is safe with no children, with settled children, and with never-started ones", async () => {
    expect(await assessSquadRunReplay(RUN)).toEqual({ safe: true, uncertainChildIds: [] })
    await getDb().agentTeamChildRuns.bulkAdd([child("done", "completed"), child("fresh", "queued")])
    expect(await assessSquadRunReplay(RUN)).toEqual({ safe: true, uncertainChildIds: [] })
  })

  it("names every child whose last checkpoint cannot be trusted", async () => {
    await getDb().agentTeamChildRuns.bulkAdd([
      child("no-cp", "running"),
      child("needs", "paused"),
      child("intent", "running"),
      child("ok", "paused"),
    ])
    await getDb().agentTeamCheckpoints.bulkAdd([
      checkpoint("needs", "needs_input"),
      checkpoint("intent", "safe", [{ id: "e", kind: "Write", state: "intent", replay: "unsafe" }]),
      checkpoint("ok", "safe", [{ id: "e", kind: "Read", state: "completed", replay: "safe" }]),
    ])
    const assessment = await assessSquadRunReplay(RUN)
    expect(assessment.safe).toBe(false)
    expect([...assessment.uncertainChildIds].sort()).toEqual(["intent", "needs", "no-cp"])
  })
})
