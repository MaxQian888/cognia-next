import Dexie from "dexie"
import type { Goal, GoalConfig } from "@/types/goal"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  __TESTING__,
  appendGoalEvent,
  countGoalEvents,
  createGoal,
  deleteGoal,
  deleteGoalEventsForGoals,
  deleteGoalsForSession,
  EVENTS_PER_GOAL_CAP,
  getActiveGoalForSession,
  getGoal,
  countAllGoals,
  getOpenGoalForSession,
  latestJudgeReasons,
  listAllGoals,
  listGoalEvents,
  listGoalsBySession,
  listGoalsForSessions,
  listOpenGoals,
  pruneGoalEvents,
  updateGoal,
} from "./goals"
import { saveSettings } from "./settings"

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

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const subscription = Dexie.liveQuery(() => listAllGoals()).subscribe({
      next: (rows) => emissions.push(rows),
      error: (error) => errors.push(error),
    })

    await waitUntil(() => emissions.length > 0 || errors.length > 0)
    subscription.unsubscribe()

    expect(errors).toEqual([])
    expect(emissions).toEqual([[]])
  })

  it("observes goal changes after resolving the current project settings", async () => {
    await createGoal(buildGoal({ id: "live-goal" }))
    const statuses: string[] = []
    const subscription = Dexie.liveQuery(() => listAllGoals()).subscribe((rows) => {
      const goal = rows.find((row) => row.id === "live-goal")
      if (goal) statuses.push(goal.status)
    })
    try {
      await waitUntil(() => statuses.includes("active"))
      await updateGoal("live-goal", { status: "paused" })
      await waitUntil(() => statuses.includes("paused"))
      await updateGoal("live-goal", { status: "stopped" })
      await waitUntil(() => statuses.includes("stopped"))
    } finally {
      subscription.unsubscribe()
    }
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

  it("deleteGoal records a `goals` sync tombstone for paired clients", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    await deleteGoal("g1")
    const tombstones = await getDb().syncTombstones.where("table").equals("goals").toArray()
    expect(tombstones).toEqual([
      expect.objectContaining({ table: "goals", id: "g1", deletedAt: expect.any(Number) }),
    ])
  })

  it("deleteGoalsForSession tombstones only the session's goals", async () => {
    await createGoal(buildGoal({ id: "g_a1", sessionId: "ses_a" }))
    await createGoal(buildGoal({ id: "g_a2", sessionId: "ses_a", status: "paused" }))
    await createGoal(buildGoal({ id: "g_b1", sessionId: "ses_b" }))
    await deleteGoalsForSession("ses_a")
    const tombstones = await getDb().syncTombstones.where("table").equals("goals").toArray()
    expect(tombstones.map((row) => row.id).sort()).toEqual(["g_a1", "g_a2"])
  })

  it("deleteGoalsForSession writes no tombstone when nothing matches", async () => {
    await deleteGoalsForSession("ses_missing")
    expect(await getDb().syncTombstones.where("table").equals("goals").count()).toBe(0)
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

  it("keeps implicit timestamps monotonic when events land in the same millisecond", async () => {
    await createGoal(buildGoal({ id: "g1" }))
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      const first = await appendGoalEvent({
        goalId: "g1",
        kind: "verification_passed",
        payload: { kind: "verification_passed", attempt: 1, summary: "Verified" },
      })
      const second = await appendGoalEvent({
        goalId: "g1",
        kind: "acceptance_requested",
        payload: { kind: "acceptance_requested", turnNumber: 1 },
      })
      expect(second.ts).toBe(first.ts + 1)
    } finally {
      now.mockRestore()
    }
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
    expect(EVENTS_PER_GOAL_CAP).toBe(__TESTING__.EVENTS_PER_GOAL_CAP)
  })

  it("pruneGoalEvents trims every listed goal (once each) and leaves the rest", async () => {
    for (const goalId of ["g1", "g2", "g3"]) {
      for (let i = 0; i < 5; i++) {
        await appendGoalEvent({
          goalId,
          kind: "turn_started",
          payload: { kind: "turn_started", turnNumber: i },
          ts: i,
        })
      }
    }
    await pruneGoalEvents(["g1", "g2", "g1"], 2)
    expect((await listGoalEvents("g1", 0)).map((e) => e.ts)).toEqual([4, 3])
    expect((await listGoalEvents("g2", 0)).map((e) => e.ts)).toEqual([4, 3])
    expect(await countGoalEvents("g3")).toBe(5)
    await pruneGoalEvents([])
    expect(await countGoalEvents("g3")).toBe(5)
  })

  it("deleteGoalEventsForGoals removes the listed goals' events only", async () => {
    for (const goalId of ["g1", "g2", "g3"]) {
      await appendGoalEvent({ goalId, kind: "user_paused", payload: { kind: "user_paused" } })
    }
    await deleteGoalEventsForGoals(["g1", "g3"])
    await deleteGoalEventsForGoals([])
    expect(await countGoalEvents("g1")).toBe(0)
    expect(await countGoalEvents("g2")).toBe(1)
    expect(await countGoalEvents("g3")).toBe(0)
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

/** A stored row with explicit timestamps and workspace, bypassing createGoal. */
function storedGoal(overrides: Partial<Goal> & { id: string; createdAt: number }): Goal {
  return {
    ...buildGoal(overrides),
    projectId: overrides.projectId ?? "proj-A",
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
    ...(overrides.endedAt !== undefined ? { endedAt: overrides.endedAt } : {}),
    ...(overrides.awaitingAcceptance !== undefined
      ? { awaitingAcceptance: overrides.awaitingAcceptance }
      : {}),
  }
}

describe("listOpenGoals", () => {
  it("lists active and paused goals of one workspace, newest first", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "a-old", status: "active", createdAt: 100 }),
      storedGoal({ id: "a-paused", status: "paused", createdAt: 300, awaitingAcceptance: true }),
      storedGoal({ id: "a-new", status: "active", createdAt: 500 }),
      storedGoal({ id: "a-done", status: "completed", createdAt: 600, endedAt: 700 }),
      storedGoal({ id: "a-stopped", status: "stopped", createdAt: 650, endedAt: 700 }),
      storedGoal({ id: "b-open", status: "active", createdAt: 800, projectId: "proj-B" }),
    ])
    const open = await listOpenGoals("proj-A")
    expect(open.map((g) => g.id)).toEqual(["a-new", "a-paused", "a-old"])
    expect((await listOpenGoals("proj-B")).map((g) => g.id)).toEqual(["b-open"])
    expect(await listOpenGoals("proj-empty")).toEqual([])
  })

  it("defaults to the active workspace from settings", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "in-a", status: "active", createdAt: 1, projectId: "proj-A" }),
      storedGoal({ id: "in-b", status: "paused", createdAt: 2, projectId: "proj-B" }),
    ])
    await saveSettings({ activeProjectId: "proj-B" })
    expect((await listOpenGoals()).map((g) => g.id)).toEqual(["in-b"])
    await saveSettings({ activeProjectId: "proj-A" })
    expect((await listOpenGoals()).map((g) => g.id)).toEqual(["in-a"])
  })

  it("keeps an old open goal that falls outside listAllGoals' newest window", async () => {
    const rows: Goal[] = [storedGoal({ id: "ancient-open", status: "active", createdAt: 1 })]
    for (let i = 0; i < 5; i++) {
      rows.push(
        storedGoal({ id: `done-${i}`, status: "completed", createdAt: 100 + i, endedAt: 200 + i })
      )
    }
    await getDb().chatGoals.bulkPut(rows)
    const window = await listAllGoals(3, "proj-A")
    expect(window.map((g) => g.id)).not.toContain("ancient-open")
    expect((await listOpenGoals("proj-A")).map((g) => g.id)).toEqual(["ancient-open"])
  })
})

describe("countAllGoals", () => {
  it("counts every goal in one workspace regardless of status", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "a1", status: "active", createdAt: 1 }),
      storedGoal({ id: "a2", status: "completed", createdAt: 2, endedAt: 3 }),
      storedGoal({ id: "a3", status: "paused", createdAt: 4 }),
      storedGoal({ id: "b1", status: "active", createdAt: 5, projectId: "proj-B" }),
    ])
    expect(await countAllGoals("proj-A")).toBe(3)
    expect(await countAllGoals("proj-B")).toBe(1)
    expect(await countAllGoals("proj-none")).toBe(0)
  })

  it("defaults to the active workspace from settings", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "a1", status: "active", createdAt: 1 }),
      storedGoal({ id: "b1", status: "active", createdAt: 2, projectId: "proj-B" }),
      storedGoal({ id: "b2", status: "stopped", createdAt: 3, projectId: "proj-B" }),
    ])
    await saveSettings({ activeProjectId: "proj-B" })
    expect(await countAllGoals()).toBe(2)
  })
})

describe("listGoalsForSessions", () => {
  it("returns [] for no session ids", async () => {
    await getDb().chatGoals.put(storedGoal({ id: "g", createdAt: 1 }))
    expect(await listGoalsForSessions([])).toEqual([])
  })

  it("returns every goal of the given sessions across workspaces, newest first", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "s1-old", sessionId: "s1", status: "completed", createdAt: 10 }),
      storedGoal({ id: "s2", sessionId: "s2", createdAt: 20, projectId: "proj-B" }),
      storedGoal({ id: "s1-new", sessionId: "s1", status: "active", createdAt: 30 }),
      storedGoal({ id: "s3", sessionId: "s3", createdAt: 40 }),
    ])
    const rows = await listGoalsForSessions(["s1", "s2"])
    expect(rows.map((g) => g.id)).toEqual(["s1-new", "s2", "s1-old"])
  })
})

describe("latestJudgeReasons", () => {
  it("maps each goal to its newest judge_evaluated reason and omits goals without one", async () => {
    await getDb().chatGoals.bulkPut([
      storedGoal({ id: "g1", createdAt: 1 }),
      storedGoal({ id: "g2", createdAt: 2 }),
      storedGoal({ id: "g3", createdAt: 3 }),
    ])
    const judged = (reason: string) => ({
      kind: "judge_evaluated" as const,
      done: false,
      reason,
      judgeTokens: 10,
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "judge_evaluated",
      payload: judged("first"),
      ts: 100,
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "judge_evaluated",
      payload: judged("latest"),
      ts: 200,
    })
    // A newer non-judge event must not hide the latest verdict.
    await appendGoalEvent({
      goalId: "g1",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 3 },
      ts: 300,
    })
    await appendGoalEvent({
      goalId: "g2",
      kind: "judge_evaluated",
      payload: judged("only"),
      ts: 50,
    })
    await appendGoalEvent({
      goalId: "g3",
      kind: "user_paused",
      payload: { kind: "user_paused" },
      ts: 60,
    })

    const reasons = await latestJudgeReasons(["g1", "g2", "g3", "g-missing"])
    expect(reasons.get("g1")).toBe("latest")
    expect(reasons.get("g2")).toBe("only")
    expect(reasons.has("g3")).toBe(false)
    expect(reasons.has("g-missing")).toBe(false)
    expect(reasons.size).toBe(2)
  })

  it("returns an empty map for no goals", async () => {
    expect((await latestJudgeReasons([])).size).toBe(0)
  })
})
