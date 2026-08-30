import type { ChatSession } from "@cognia/agent-config-types"
import type { ProjectMiningRun } from "@/types/memory/governance"
import {
  BACKFILL_PENDING_JOB_CEILING,
  BACKFILL_SESSION_BATCH,
  estimateProjectMiningBackfill,
  stepProjectMiningBackfill,
  type ProjectMiningBackfillDeps,
} from "./project-mining-backfill"

function run(over: Partial<ProjectMiningRun> = {}): ProjectMiningRun {
  return {
    id: "r1",
    projectId: "p1",
    status: "running",
    estimate: { sessions: 10, messages: 100, windows: 9, estimatedInputTokens: 22_000 },
    createdAt: 1,
    updatedAt: 1,
    sessionsScanned: 0,
    jobsEnqueued: 0,
    claimsProduced: 0,
    ...over,
  }
}

function session(id: string, createdAt: number): ChatSession {
  return { id, projectId: "p1", title: id, createdAt, updatedAt: createdAt } as ChatSession
}

function makeDeps(over: Partial<ProjectMiningBackfillDeps> = {}): ProjectMiningBackfillDeps {
  return {
    pageSessions: async () => [session("s1", 300), session("s2", 200)],
    loadTranscript: async () => [{ id: "m1", role: "user", text: "hi" }],
    enqueueForSession: async () => 2,
    countPendingJobs: async () => 0,
    claimRun: async () => run(),
    advanceRun: async () => run(),
    finishRun: async () => undefined,
    workerId: "w1",
    ...over,
  }
}

describe("one backfill step", () => {
  it("does nothing when another window holds the lease", async () => {
    const enqueueForSession = jest.fn()
    const outcome = await stepProjectMiningBackfill(
      "r1",
      makeDeps({ claimRun: async () => undefined, enqueueForSession })
    )
    expect(outcome).toEqual({ kind: "idle" })
    expect(enqueueForSession).not.toHaveBeenCalled()
  })

  it("declines to enqueue while the previous batch is still draining", async () => {
    // The memory worker drains twenty jobs per tick. A sweep that ran ahead of
    // it would bury a live turn's own extraction behind historical windows.
    const enqueueForSession = jest.fn()
    const outcome = await stepProjectMiningBackfill(
      "r1",
      makeDeps({
        countPendingJobs: async () => BACKFILL_PENDING_JOB_CEILING,
        enqueueForSession,
      })
    )
    expect(outcome).toEqual({ kind: "throttled", pending: BACKFILL_PENDING_JOB_CEILING })
    expect(enqueueForSession).not.toHaveBeenCalled()
  })

  it("hands every session in the page to the shared miner", async () => {
    const enqueueForSession = jest.fn(async () => 2)
    const outcome = await stepProjectMiningBackfill("r1", makeDeps({ enqueueForSession }))
    expect(enqueueForSession).toHaveBeenCalledTimes(2)
    expect(enqueueForSession.mock.calls[0][0]).toMatchObject({ runId: "r1" })
    expect(outcome).toEqual({ kind: "advanced", sessionsScanned: 2, jobsEnqueued: 4 })
  })

  it("asks for one batch at a time, from the run's own cursor", async () => {
    const pageSessions = jest.fn(async () => [session("s1", 300)])
    await stepProjectMiningBackfill(
      "r1",
      makeDeps({
        pageSessions,
        claimRun: async () => run({ cursorCreatedAt: 500, cursorSessionId: "s0" }),
      })
    )
    expect(pageSessions).toHaveBeenCalledWith({
      projectId: "p1",
      beforeCreatedAt: 500,
      beforeSessionId: "s0",
      limit: BACKFILL_SESSION_BATCH,
    })
  })

  it("moves the watermark to the OLDEST session in the page", async () => {
    const advanceRun = jest.fn(async () => run())
    await stepProjectMiningBackfill("r1", makeDeps({ advanceRun }))
    expect(advanceRun).toHaveBeenCalledWith("r1", {
      cursorCreatedAt: 200,
      cursorSessionId: "s2",
      sessionsScanned: 2,
      jobsEnqueued: 4,
    })
  })

  it("advances on CHECKED, not on produced, so a barren stretch cannot loop", async () => {
    const advanceRun = jest.fn(async () => run())
    const outcome = await stepProjectMiningBackfill(
      "r1",
      makeDeps({ advanceRun, enqueueForSession: async () => 0 })
    )
    expect(outcome).toEqual({ kind: "advanced", sessionsScanned: 2, jobsEnqueued: 0 })
    expect(advanceRun.mock.calls[0][1].sessionsScanned).toBe(2)
  })

  it("counts an unreadable session as checked rather than revisiting it forever", async () => {
    const advanceRun = jest.fn(async () => run())
    await stepProjectMiningBackfill(
      "r1",
      makeDeps({
        advanceRun,
        loadTranscript: async (id) => {
          if (id === "s1") throw new Error("row is corrupt")
          return [{ id: "m1", role: "user", text: "hi" }]
        },
      })
    )
    expect(advanceRun.mock.calls[0][1].sessionsScanned).toBe(2)
    expect(advanceRun.mock.calls[0][1].jobsEnqueued).toBe(2)
  })

  it("skips an empty conversation without queueing anything for it", async () => {
    const enqueueForSession = jest.fn(async () => 2)
    await stepProjectMiningBackfill(
      "r1",
      makeDeps({ enqueueForSession, loadTranscript: async () => [] })
    )
    expect(enqueueForSession).not.toHaveBeenCalled()
  })

  it("finishes the run when there is nothing older left", async () => {
    const finishRun = jest.fn(async () => undefined)
    const advanceRun = jest.fn()
    const outcome = await stepProjectMiningBackfill(
      "r1",
      makeDeps({ pageSessions: async () => [], finishRun, advanceRun })
    )
    expect(outcome).toEqual({ kind: "finished" })
    expect(finishRun).toHaveBeenCalledWith("r1")
    expect(advanceRun).not.toHaveBeenCalled()
  })

  it("never throws, so a failed step cannot strand the lease", async () => {
    await expect(
      stepProjectMiningBackfill(
        "r1",
        makeDeps({
          pageSessions: async () => {
            throw new Error("dexie closed")
          },
        })
      )
    ).resolves.toEqual({ kind: "idle" })
    await expect(
      stepProjectMiningBackfill(
        "r1",
        makeDeps({
          claimRun: async () => {
            throw new Error("dexie closed")
          },
        })
      )
    ).resolves.toEqual({ kind: "idle" })
  })
})

describe("the preconsent count", () => {
  it("asks only for counts, never for bodies", async () => {
    const countSessions = jest.fn(async () => 4)
    const countMessages = jest.fn(async () => 48)
    const estimate = await estimateProjectMiningBackfill("p1", { countSessions, countMessages })
    expect(countSessions).toHaveBeenCalledWith("p1")
    expect(countMessages).toHaveBeenCalledWith("p1")
    expect(estimate).toMatchObject({ sessions: 4, messages: 48, windows: 4 })
  })
})
