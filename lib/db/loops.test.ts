import "fake-indexeddb/auto"
import type { LoopCreateInput } from "./loops"
import {
  __TESTING__,
  appendLoopEvent,
  createLoop,
  deleteLoop,
  deleteLoopsForSession,
  getActiveLoopForSession,
  getLoop,
  getLoopByScheduledTask,
  getOpenLoopForSession,
  listLoopEvents,
  listLoopsBySession,
  updateLoop,
} from "./loops"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

function buildLoop(overrides: Partial<LoopCreateInput> = {}): LoopCreateInput {
  return {
    id: overrides.id ?? "lp_1",
    sessionId: overrides.sessionId ?? "ses_a",
    mode: overrides.mode ?? "self_paced",
    rawPrompt: overrides.rawPrompt ?? "summarize progress",
    safePrompt: overrides.safePrompt ?? "summarize progress",
    redactionMapEnc: overrides.redactionMapEnc ?? "",
    isSlashCommand: overrides.isSlashCommand ?? false,
    commandName: overrides.commandName,
    status: overrides.status ?? "active",
    iterations: overrides.iterations ?? 0,
    tokensUsed: overrides.tokensUsed ?? 0,
    generationId: overrides.generationId ?? "gen-1",
    config: overrides.config ?? {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: overrides.parseFailureCount ?? 0,
    scheduledTaskId: overrides.scheduledTaskId,
    intervalMs: overrides.intervalMs,
    expiresAt: overrides.expiresAt,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("loop CRUD", () => {
  it("creates and reads back a loop with timestamps", async () => {
    const row = await createLoop(buildLoop())
    expect(row.createdAt).toBeGreaterThan(0)
    expect((await getLoop("lp_1"))?.sessionId).toBe("ses_a")
  })

  it("getActiveLoopForSession matches only active rows", async () => {
    await createLoop(buildLoop({ id: "lp_a", status: "paused" }))
    expect(await getActiveLoopForSession("ses_a")).toBeUndefined()
    await createLoop(buildLoop({ id: "lp_b" }))
    expect((await getActiveLoopForSession("ses_a"))?.id).toBe("lp_b")
  })

  it("getOpenLoopForSession prefers active over paused", async () => {
    await createLoop(buildLoop({ id: "lp_a", status: "paused" }))
    expect((await getOpenLoopForSession("ses_a"))?.id).toBe("lp_a")
    await createLoop(buildLoop({ id: "lp_b" }))
    expect((await getOpenLoopForSession("ses_a"))?.id).toBe("lp_b")
  })

  it("getLoopByScheduledTask reverse-looks-up interval loops", async () => {
    await createLoop(buildLoop({ id: "lp_i", mode: "interval", scheduledTaskId: "task_9" }))
    expect((await getLoopByScheduledTask("task_9"))?.id).toBe("lp_i")
    expect(await getLoopByScheduledTask("task_none")).toBeUndefined()
  })

  it("listLoopsBySession returns newest first", async () => {
    await createLoop(buildLoop({ id: "lp_1", status: "stopped" }))
    await new Promise((r) => setTimeout(r, 5))
    await createLoop(buildLoop({ id: "lp_2" }))
    const rows = await listLoopsBySession("ses_a")
    expect(rows.map((r) => r.id)).toEqual(["lp_2", "lp_1"])
  })

  it("updateLoop bumps updatedAt and back-fills endedAt on terminal status", async () => {
    const row = await createLoop(buildLoop())
    await updateLoop("lp_1", { status: "completed" })
    const updated = await getLoop("lp_1")
    expect(updated?.status).toBe("completed")
    expect(updated?.endedAt).toBeGreaterThan(0)
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt)
  })

  it("updateLoop does NOT set endedAt for non-terminal transitions", async () => {
    await createLoop(buildLoop())
    await updateLoop("lp_1", { status: "paused" })
    expect((await getLoop("lp_1"))?.endedAt).toBeUndefined()
  })

  it("deleteLoop cascades its events", async () => {
    await createLoop(buildLoop())
    await appendLoopEvent({
      loopId: "lp_1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    await deleteLoop("lp_1")
    expect(await getLoop("lp_1")).toBeUndefined()
    expect(await listLoopEvents("lp_1")).toHaveLength(0)
  })

  it("deleteLoopsForSession drops every loop + events and returns the rows", async () => {
    await createLoop(buildLoop({ id: "lp_1", status: "stopped" }))
    await createLoop(buildLoop({ id: "lp_2" }))
    await createLoop(buildLoop({ id: "lp_other", sessionId: "ses_b" }))
    await appendLoopEvent({
      loopId: "lp_1",
      kind: "user_stopped",
      payload: { kind: "user_stopped" },
    })
    const deleted = await deleteLoopsForSession("ses_a")
    expect(deleted.map((r) => r.id).sort()).toEqual(["lp_1", "lp_2"])
    expect(await listLoopsBySession("ses_a")).toHaveLength(0)
    expect(await listLoopEvents("lp_1")).toHaveLength(0)
    expect((await getLoop("lp_other"))?.id).toBe("lp_other")
  })

  it("deleteLoopsForSession is a no-op for unknown sessions", async () => {
    await expect(deleteLoopsForSession("ses_missing")).resolves.toEqual([])
  })
})

describe("loop event log", () => {
  it("appends with generated id/ts and lists newest first", async () => {
    await createLoop(buildLoop())
    await appendLoopEvent({
      loopId: "lp_1",
      kind: "iteration_completed",
      payload: { kind: "iteration_completed", iteration: 1, tokensDelta: 10 },
      ts: 1,
    })
    await appendLoopEvent({
      loopId: "lp_1",
      kind: "delay_decided",
      payload: { kind: "delay_decided", delayMs: 60_000, reason: "waiting" },
      ts: 2,
    })
    const events = await listLoopEvents("lp_1")
    expect(events.map((e) => e.kind)).toEqual(["delay_decided", "iteration_completed"])
    expect(events[0]?.id).toMatch(/^[0-9a-f]{8}-/)
  })

  it("prunes oldest events past the per-loop cap", async () => {
    await createLoop(buildLoop())
    const { pruneEventsForLoop } = __TESTING__
    for (let i = 0; i < 5; i++) {
      await appendLoopEvent({
        loopId: "lp_1",
        kind: "iteration_completed",
        payload: { kind: "iteration_completed", iteration: i, tokensDelta: 0 },
        ts: i,
      })
    }
    await pruneEventsForLoop("lp_1", 2)
    const events = await listLoopEvents("lp_1")
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.ts)).toEqual([4, 3])
  })
})

describe("workspace (project) scoping", () => {
  it("createLoop inherits the session's project", async () => {
    await getDb().sessions.put({
      id: "ses_a",
      projectId: "proj-A",
      title: "a",
      updatedAt: 1,
      createdAt: 1,
    } as never)
    const lp = await createLoop(buildLoop({ id: "lp_scope", sessionId: "ses_a" }))
    expect(lp.projectId).toBe("proj-A")
  })

  it("createLoop honours an explicit projectId override", async () => {
    const lp = await createLoop({ ...buildLoop({ id: "lp_forced" }), projectId: "proj-forced" })
    expect(lp.projectId).toBe("proj-forced")
  })
})
