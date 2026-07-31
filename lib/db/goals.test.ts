/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { liveQuery } from "dexie"
import type { Goal, GoalConfig } from "@/types/goal"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  __TESTING__,
  appendGoalEvent,
  countGoalEvents,
  createGoal,
  deleteGoal,
  deleteGoalsForSession,
  getActiveGoalForSession,
  getGoal,
  getOpenGoalForSession,
  listAllGoals,
  listGoalEvents,
  listGoalsBySession,
  updateGoal,
} from "./goals"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Parameters<typeof createGoal>[0] {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? "ses_a",
    characterId: overrides.characterId,
    rawObjective: overrides.rawObjective ?? "write a haiku about winter",
    safeObjective: overrides.safeObjective ?? "write a haiku about winter",
    redactionMapEnc: overrides.redactionMapEnc ?? "",
    status: overrides.status ?? "active",
    turnsUsed: overrides.turnsUsed ?? 0,
    tokensUsed: overrides.tokensUsed ?? 0,
    judgeFailureCount: overrides.judgeFailureCount ?? 0,
    config: overrides.config ?? SAMPLE_CONFIG,
    generationId: overrides.generationId ?? crypto.randomUUID(),
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("chatGoals CRUD", () => {
  it("createGoal inserts the row and stamps createdAt/updatedAt", async () => {
    const before = Date.now()
    const row = await createGoal(buildGoal({ id: "g1" }))
    const after = Date.now()
    expect(row.id).toBe("g1")
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.createdAt).toBeLessThanOrEqual(after)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.endedAt).toBeUndefined()
    const stored = await getGoal("g1")
    expect(stored?.rawObjective).toBe("write a haiku about winter")
  })

  it("getGoal returns undefined for missing ids", async () => {
    expect(await getGoal("g_missing")).toBeUndefined()
  })

  it("getActiveGoalForSession returns the active row only", async () => {
    await createGoal(buildGoal({ id: "g_paused", sessionId: "ses_a", status: "paused" }))
    await createGoal(buildGoal({ id: "g_done", sessionId: "ses_a", status: "completed" }))
    const empty = await getActiveGoalForSession("ses_a")
    expect(empty).toBeUndefined()
    await createGoal(buildGoal({ id: "g_active", sessionId: "ses_a", status: "active" }))
    const found = await getActiveGoalForSession("ses_a")
    expect(found?.id).toBe("g_active")
  })

  it("getOpenGoalForSession prefers active, falls back to paused", async () => {
    await createGoal(buildGoal({ id: "g_paused", sessionId: "ses_a", status: "paused" }))
    const paused = await getOpenGoalForSession("ses_a")
    expect(paused?.id).toBe("g_paused")
    await createGoal(buildGoal({ id: "g_active", sessionId: "ses_a", status: "active" }))
    const active = await getOpenGoalForSession("ses_a")
    expect(active?.id).toBe("g_active")
  })

  it("getOpenGoalForSession returns undefined when no row matches", async () => {
    await createGoal(buildGoal({ id: "g_done", sessionId: "ses_a", status: "completed" }))
    expect(await getOpenGoalForSession("ses_a")).toBeUndefined()
  })

  it("listGoalsBySession returns rows newest-first", async () => {
    await createGoal(buildGoal({ id: "old", sessionId: "ses_a" }))
    await new Promise((r) => setTimeout(r, 2))
    await createGoal(buildGoal({ id: "mid", sessionId: "ses_a" }))
    await new Promise((r) => setTimeout(r, 2))
    await createGoal(buildGoal({ id: "new", sessionId: "ses_a" }))
    const rows = await listGoalsBySession("ses_a")
    expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"])
  })

  it("listGoalsBySession isolates by session", async () => {
    await createGoal(buildGoal({ id: "ga", sessionId: "ses_a" }))
    await createGoal(buildGoal({ id: "gb", sessionId: "ses_b" }))
    const a = await listGoalsBySession("ses_a")
    expect(a.map((r) => r.id)).toEqual(["ga"])
    const b = await listGoalsBySession("ses_b")
    expect(b.map((r) => r.id)).toEqual(["gb"])
  })

  it("listAllGoals respects the limit and newest-first order", async () => {
    for (let i = 0; i < 5; i++) {
      await createGoal(buildGoal({ id: `g${i}` }))
      await new Promise((r) => setTimeout(r, 1))
    }
    const top3 = await listAllGoals(3)
    expect(top3).toHaveLength(3)
    expect(top3[0]!.id).toBe("g4")
    expect(top3[2]!.id).toBe("g2")
  })

  it("keeps default-scope resolution read-only inside a liveQuery", async () => {
    const emissions: Goal[][] = []
    const errors: unknown[] = []
    const subscription = liveQuery(() => listAllGoals()).subscribe({
      next: (rows) => emissions.push(rows),
      error: (error) => errors.push(error),
    })

    await waitUntil(() => emissions.length > 0 || errors.length > 0)
    subscription.unsubscribe()

    expect(errors).toEqual([])
    expect(emissions).toEqual([[]])
  })

  it("updateGoal patches fields and bumps updatedAt", async () => {
    const g = await createGoal(buildGoal({ id: "g1" }))
    const t0 = g.updatedAt
    await new Promise((r) => setTimeout(r, 2))
    await updateGoal("g1", { turnsUsed: 3, tokensUsed: 1234 })
    const after = await getGoal("g1")
    expect(after?.turnsUsed).toBe(3)
    expect(after?.tokensUsed).toBe(1234)
    expect(after!.updatedAt).toBeGreaterThan(t0)
  })

  it("updateGoal back-fills endedAt when transitioning into a terminal status", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await updateGoal("g1", { status: "completed" })
    const after = await getGoal("g1")
    expect(after?.status).toBe("completed")
    expect(after?.endedAt).toBeGreaterThan(0)
  })

  it("updateGoal honours an explicit endedAt when supplied", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await updateGoal("g1", { status: "stopped", endedAt: 12345 })
    const after = await getGoal("g1")
    expect(after?.endedAt).toBe(12345)
  })

  it("updateGoal does not stamp endedAt on non-terminal transitions", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await updateGoal("g1", { status: "paused" })
    expect((await getGoal("g1"))?.endedAt).toBeUndefined()
  })

  it("deleteGoal cascades event deletion", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await appendGoalEvent({
      goalId: "g1",
      kind: "goal_created",
      payload: { kind: "goal_created", safeObjective: "x", config: SAMPLE_CONFIG },
    })
    expect(await countGoalEvents("g1")).toBe(1)
    await deleteGoal("g1")
    expect(await getGoal("g1")).toBeUndefined()
    expect(await countGoalEvents("g1")).toBe(0)
  })

  it("deleteGoalsForSession is a no-op when nothing matches", async () => {
    await expect(deleteGoalsForSession("ses_missing")).resolves.toBeUndefined()
  })

  it("deleteGoalsForSession drops every goal + events for one session", async () => {
    await createGoal(buildGoal({ id: "g_a1", sessionId: "ses_a" }))
    await createGoal(buildGoal({ id: "g_a2", sessionId: "ses_a", status: "paused" }))
    await createGoal(buildGoal({ id: "g_b1", sessionId: "ses_b" }))
    await appendGoalEvent({
      goalId: "g_a1",
      kind: "goal_created",
      payload: { kind: "goal_created", safeObjective: "x", config: SAMPLE_CONFIG },
    })
    await appendGoalEvent({
      goalId: "g_b1",
      kind: "goal_created",
      payload: { kind: "goal_created", safeObjective: "y", config: SAMPLE_CONFIG },
    })
    await deleteGoalsForSession("ses_a")
    expect(await getGoal("g_a1")).toBeUndefined()
    expect(await getGoal("g_a2")).toBeUndefined()
    expect(await getGoal("g_b1")).toBeDefined()
    expect(await countGoalEvents("g_a1")).toBe(0)
    expect(await countGoalEvents("g_b1")).toBe(1)
  })
})

describe("chatGoalEvents", () => {
  it("appendGoalEvent writes a row with auto-generated id+ts", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const ev = await appendGoalEvent({
      goalId: "g1",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 1 },
    })
    expect(ev.id).toMatch(/^[0-9a-f]{8}-/)
    expect(ev.ts).toBeGreaterThan(0)
    expect(ev.goalId).toBe("g1")
    expect(ev.kind).toBe("turn_started")
  })

  it("appendGoalEvent honours caller-supplied id+ts", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const ev = await appendGoalEvent({
      goalId: "g1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
      id: "ev_fixed",
      ts: 999,
    })
    expect(ev.id).toBe("ev_fixed")
    expect(ev.ts).toBe(999)
  })

  it("listGoalEvents returns events newest-first scoped to the goal", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await createGoal(buildGoal({ id: "g2", sessionId: "ses_b" }))
    await appendGoalEvent({
      goalId: "g1",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 1 },
      ts: 10,
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 2 },
      ts: 20,
    })
    await appendGoalEvent({
      goalId: "g2",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 1 },
      ts: 30,
    })
    const events = await listGoalEvents("g1")
    expect(events.map((e) => e.ts)).toEqual([20, 10])
  })

  it("listGoalEvents respects the limit", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    for (let i = 0; i < 5; i++) {
      await appendGoalEvent({
        goalId: "g1",
        kind: "turn_started",
        payload: { kind: "turn_started", turnNumber: i },
        ts: i,
      })
    }
    const limited = await listGoalEvents("g1", 2)
    expect(limited).toHaveLength(2)
    expect(limited[0]!.ts).toBe(4)
    expect(limited[1]!.ts).toBe(3)
  })

  it("countGoalEvents counts only this goal's events", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await createGoal(buildGoal({ id: "g2", sessionId: "ses_b" }))
    await appendGoalEvent({
      goalId: "g1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "user_resumed",
      payload: { kind: "user_resumed" },
    })
    await appendGoalEvent({
      goalId: "g2",
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    expect(await countGoalEvents("g1")).toBe(2)
    expect(await countGoalEvents("g2")).toBe(1)
  })

  it("pruneEventsForGoal caps a single goal's events at the configured size", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    // The cap is 5000; we test the prune helper directly with a smaller keep.
    for (let i = 0; i < 10; i++) {
      await appendGoalEvent({
        goalId: "g1",
        kind: "turn_started",
        payload: { kind: "turn_started", turnNumber: i },
        ts: i,
      })
    }
    await __TESTING__.pruneEventsForGoal("g1", 4)
    const remaining = await listGoalEvents("g1", 100)
    expect(remaining).toHaveLength(4)
    expect(remaining.map((e) => e.ts).sort((a, b) => a - b)).toEqual([6, 7, 8, 9])
  })

  it("pruneEventsForGoal is a no-op when count <= keep", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await appendGoalEvent({
      goalId: "g1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
    })
    await __TESTING__.pruneEventsForGoal("g1", 100)
    expect(await countGoalEvents("g1")).toBe(1)
  })

  it("exports EVENTS_PER_GOAL_CAP as 5000", () => {
    expect(__TESTING__.EVENTS_PER_GOAL_CAP).toBe(5000)
  })
})

describe("workspace (project) scoping", () => {
  it("createGoal inherits the session's project; listAllGoals filters by workspace", async () => {
    // Two sessions in different workspaces.
    await getDb().sessions.bulkPut([
      { id: "ses_a", projectId: "proj-A", title: "a", updatedAt: 1, createdAt: 1 },
      { id: "ses_b", projectId: "proj-B", title: "b", updatedAt: 1, createdAt: 1 },
    ] as never)
    const gA = await createGoal(buildGoal({ sessionId: "ses_a" }))
    const gB = await createGoal(buildGoal({ sessionId: "ses_b" }))
    expect(gA.projectId).toBe("proj-A")
    expect(gB.projectId).toBe("proj-B")

    const inA = await listAllGoals(500, "proj-A")
    expect(inA.map((g) => g.id)).toEqual([gA.id])
    const inB = await listAllGoals(500, "proj-B")
    expect(inB.map((g) => g.id)).toEqual([gB.id])
  })

  it("createGoal honours an explicit projectId override", async () => {
    const g = await createGoal({ ...buildGoal({ sessionId: "ses_x" }), projectId: "proj-forced" })
    expect(g.projectId).toBe("proj-forced")
  })
})
