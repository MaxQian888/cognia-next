import "fake-indexeddb/auto"
import type { AgentPlan, PlanConfig } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  __TESTING__,
  appendPlanEvent,
  countPlanEvents,
  createPlan,
  deletePlan,
  deletePlansForSession,
  getExecutingPlanForSession,
  getOpenPlanForSession,
  getPlan,
  listAllPlans,
  listPlanEvents,
  listPlansBySession,
  updatePlan,
} from "./plans"

const CONFIG: PlanConfig = DEFAULT_PLAN_CONFIG

function buildPlan(over: Partial<AgentPlan> = {}): Parameters<typeof createPlan>[0] {
  return {
    id: over.id ?? crypto.randomUUID(),
    sessionId: over.sessionId ?? "ses_a",
    characterId: over.characterId,
    title: over.title ?? "Ship the feature",
    description: over.description,
    source: over.source ?? "manual",
    executionMode: over.executionMode ?? "auto",
    steps: over.steps ?? [],
    status: over.status ?? "draft",
    currentStepId: over.currentStepId,
    totalSteps: over.totalSteps ?? 0,
    completedSteps: over.completedSteps ?? 0,
    config: over.config ?? CONFIG,
    refinementCount: over.refinementCount ?? 0,
    generationId: over.generationId ?? crypto.randomUUID(),
    metadata: over.metadata,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("agentPlans CRUD", () => {
  it("createPlan inserts the row and stamps createdAt/updatedAt", async () => {
    const before = Date.now()
    const row = await createPlan(buildPlan({ id: "p1" }))
    const after = Date.now()
    expect(row.id).toBe("p1")
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.createdAt).toBeLessThanOrEqual(after)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.endedAt).toBeUndefined()
    expect((await getPlan("p1"))?.title).toBe("Ship the feature")
  })

  it("getPlan returns undefined for missing ids", async () => {
    expect(await getPlan("nope")).toBeUndefined()
  })

  it("getOpenPlanForSession finds the first open plan across statuses", async () => {
    await createPlan(buildPlan({ id: "p_done", status: "completed" }))
    expect(await getOpenPlanForSession("ses_a")).toBeUndefined()
    await createPlan(buildPlan({ id: "p_paused", status: "paused" }))
    expect((await getOpenPlanForSession("ses_a"))?.id).toBe("p_paused")
  })

  it("getExecutingPlanForSession matches only executing", async () => {
    await createPlan(buildPlan({ id: "p_appr", status: "approved" }))
    expect(await getExecutingPlanForSession("ses_a")).toBeUndefined()
    await createPlan(buildPlan({ id: "p_exec", status: "executing" }))
    expect((await getExecutingPlanForSession("ses_a"))?.id).toBe("p_exec")
  })

  it("listPlansBySession is newest-first", async () => {
    await createPlan(buildPlan({ id: "p1", sessionId: "ses_a" }))
    await new Promise((r) => setTimeout(r, 2))
    await createPlan(buildPlan({ id: "p2", sessionId: "ses_a" }))
    const list = await listPlansBySession("ses_a")
    expect(list.map((p) => p.id)).toEqual(["p2", "p1"])
  })

  it("listAllPlans spans sessions newest-first", async () => {
    await createPlan(buildPlan({ id: "p1", sessionId: "ses_a" }))
    await new Promise((r) => setTimeout(r, 2))
    await createPlan(buildPlan({ id: "p2", sessionId: "ses_b" }))
    expect((await listAllPlans()).map((p) => p.id)).toEqual(["p2", "p1"])
  })

  it("updatePlan bumps updatedAt and back-fills endedAt on terminal status", async () => {
    await createPlan(buildPlan({ id: "p1" }))
    await updatePlan("p1", { status: "completed" })
    const row = await getPlan("p1")
    expect(row?.status).toBe("completed")
    expect(row?.endedAt).toBeGreaterThan(0)
    expect(row?.updatedAt).toBe(row?.endedAt)
  })

  it("updatePlan does not back-fill endedAt for non-terminal status", async () => {
    await createPlan(buildPlan({ id: "p1" }))
    await updatePlan("p1", { status: "executing" })
    expect((await getPlan("p1"))?.endedAt).toBeUndefined()
  })
})

describe("cascade delete", () => {
  it("deletePlan drops the plan and its events", async () => {
    await createPlan(buildPlan({ id: "p1" }))
    await appendPlanEvent({ planId: "p1", kind: "approved", payload: { kind: "approved" } })
    await deletePlan("p1")
    expect(await getPlan("p1")).toBeUndefined()
    expect(await countPlanEvents("p1")).toBe(0)
  })

  it("deletePlansForSession removes every plan + events for the session only", async () => {
    await createPlan(buildPlan({ id: "p1", sessionId: "ses_a" }))
    await createPlan(buildPlan({ id: "p2", sessionId: "ses_a" }))
    await createPlan(buildPlan({ id: "p3", sessionId: "ses_b" }))
    await appendPlanEvent({ planId: "p1", kind: "approved", payload: { kind: "approved" } })
    await deletePlansForSession("ses_a")
    expect(await getPlan("p1")).toBeUndefined()
    expect(await getPlan("p2")).toBeUndefined()
    expect(await getPlan("p3")).toBeDefined()
    expect(await countPlanEvents("p1")).toBe(0)
  })

  it("deletePlansForSession is a no-op for an empty session", async () => {
    await expect(deletePlansForSession("ghost")).resolves.toBeUndefined()
  })
})

describe("agentPlanEvents log", () => {
  it("appendPlanEvent stores and lists newest-first", async () => {
    await appendPlanEvent({
      planId: "p1",
      kind: "plan_created",
      payload: { kind: "plan_created", source: "manual", totalSteps: 0, executionMode: "auto" },
      ts: 1,
    })
    await appendPlanEvent({ planId: "p1", kind: "approved", payload: { kind: "approved" }, ts: 2 })
    const events = await listPlanEvents("p1")
    expect(events.map((e) => e.kind)).toEqual(["approved", "plan_created"])
  })

  it("respects the per-plan event cap", async () => {
    const cap = __TESTING__.EVENTS_PER_PLAN_CAP
    // Prove the prune path with a tiny synthetic cap to avoid 2000 inserts.
    for (let i = 0; i < 5; i++) {
      await appendPlanEvent({ planId: "p1", kind: "resumed", payload: { kind: "resumed" }, ts: i })
    }
    await __TESTING__.pruneEventsForPlan("p1", 3)
    expect(await countPlanEvents("p1")).toBe(3)
    // The cap constant is the real ceiling used by appendPlanEvent.
    expect(cap).toBeGreaterThan(100)
  })

  it("listPlanEvents honors limit", async () => {
    for (let i = 0; i < 4; i++) {
      await appendPlanEvent({ planId: "p1", kind: "resumed", payload: { kind: "resumed" }, ts: i })
    }
    expect(await listPlanEvents("p1", 2)).toHaveLength(2)
  })
})
