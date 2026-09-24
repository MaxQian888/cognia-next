import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createPlan as insertPlan, getPlan, listPlanEvents } from "@/lib/db/plans"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { __resetPlanRuntimeForTesting } from "./runtime"
import { PLAN_RENDERER_BOOT_ID } from "./step-halt"
import {
  __resetPlanStepRecoveryForTesting,
  ensurePlanStepRecovery,
  recoverOrphanedInSessionSteps,
} from "./step-recovery"

// The watchdog needs the chat store; recovery only relies on the runtime
// disarming, which is pinned in runtime.test.ts.
jest.mock("./step-watchdog", () => ({
  armPlanStepWatch: jest.fn().mockResolvedValue(undefined),
  disarmPlanStepWatch: jest.fn(),
}))
// Same reason as runtime.test.ts: a real scheduler opens its own database and
// hangs the next fixture restore.
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: jest.fn().mockResolvedValue(undefined),
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetPlanRuntimeForTesting()
  __resetPlanStepRecoveryForTesting()
}, 30_000)
afterAll(dbFixture.dispose)

function step(id: string, order: number, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `step ${id}`,
    kind: "agent_turn",
    status: "pending",
    order,
    dependencies: order > 0 ? [`s${order - 1}`] : [],
    ...over,
  }
}

async function seed(over: Partial<AgentPlan> = {}): Promise<AgentPlan> {
  const steps = over.steps ?? [step("s0", 0, { status: "in_progress" }), step("s1", 1)]
  return insertPlan({
    id: over.id ?? crypto.randomUUID(),
    sessionId: over.sessionId ?? "ses_a",
    title: "Ship",
    source: "manual",
    executionMode: over.executionMode ?? "auto",
    steps,
    status: over.status ?? "executing",
    currentStepId: over.currentStepId ?? "s0",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: over.generationId ?? "gen-old",
    ...(over.turnDispatch ? { turnDispatch: over.turnDispatch } : {}),
  })
}

/** Every row seeded "now" counts as written before a boot one second ahead. */
const later = () => ({ bootedAt: Date.now() + 1_000 })

describe("recoverOrphanedInSessionSteps", () => {
  it("halts a step a previous renderer left running, as interrupted", async () => {
    const plan = await seed({
      turnDispatch: { stepId: "s0", bootId: "previous-load", dispatchedAt: 1 },
    })
    expect(await recoverOrphanedInSessionSteps(later())).toBe(1)

    const row = await getPlan(plan.id)
    expect(row?.status).toBe("paused")
    expect(row?.steps[0].status).toBe("failed")
    expect(row?.stepHalt).toMatchObject({ stepId: "s0", cause: "interrupted" })
    const kinds = (await listPlanEvents(plan.id)).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(["step_failed", "exit"]))
  })

  it("treats an unstamped executing row (written before stamps existed) as orphaned", async () => {
    const plan = await seed()
    expect(await recoverOrphanedInSessionSteps(later())).toBe(1)
    expect((await getPlan(plan.id))?.status).toBe("paused")
  })

  it("halts between steps when the orphan had no step in progress", async () => {
    const plan = await seed({
      steps: [step("s0", 0, { status: "completed" }), step("s1", 1)],
      currentStepId: "s1",
    })
    await recoverOrphanedInSessionSteps(later())
    const row = await getPlan(plan.id)
    expect(row?.status).toBe("paused")
    expect(row?.stepHalt?.stepId).toBeUndefined()
    expect(row?.stepHalt?.cause).toBe("interrupted")
  })

  it("leaves a step that a still-open window or tab dispatched", async () => {
    const plan = await seed({
      turnDispatch: { stepId: "s0", bootId: "other-tab", dispatchedAt: 1 },
    })
    const liveBootIds = jest.fn(async () => new Set(["other-tab"]))
    expect(await recoverOrphanedInSessionSteps({ ...later(), liveBootIds })).toBe(0)
    expect(liveBootIds).toHaveBeenCalled()
    expect((await getPlan(plan.id))?.status).toBe("executing")
  })

  it("still halts a foreign dispatch when its renderer is gone", async () => {
    const plan = await seed({
      turnDispatch: { stepId: "s0", bootId: "closed-tab", dispatchedAt: 1 },
    })
    const liveBootIds = async () => new Set(["other-tab"])
    expect(await recoverOrphanedInSessionSteps({ ...later(), liveBootIds })).toBe(1)
    expect((await getPlan(plan.id))?.status).toBe("paused")
  })

  it("leaves a step this renderer dispatched to the watchdog", async () => {
    const plan = await seed({
      turnDispatch: { stepId: "s0", bootId: PLAN_RENDERER_BOOT_ID, dispatchedAt: 1 },
    })
    expect(await recoverOrphanedInSessionSteps(later())).toBe(0)
    expect((await getPlan(plan.id))?.status).toBe("executing")
  })

  it("leaves a row this renderer touched after booting", async () => {
    const plan = await seed()
    expect(await recoverOrphanedInSessionSteps({ bootedAt: 0 })).toBe(0)
    expect((await getPlan(plan.id))?.status).toBe("executing")
  })

  it("leaves orchestrated and non-executing plans alone", async () => {
    const orchestrated = await seed({ executionMode: "orchestrated" })
    const paused = await seed({ sessionId: "ses_b", status: "paused" })
    expect(await recoverOrphanedInSessionSteps(later())).toBe(0)
    expect((await getPlan(orchestrated.id))?.status).toBe("executing")
    expect((await getPlan(paused.id))?.stepHalt).toBeUndefined()
  })
})

describe("ensurePlanStepRecovery", () => {
  it("runs the sweep once per renderer load", async () => {
    const first = ensurePlanStepRecovery()
    const second = ensurePlanStepRecovery()
    expect(second).toBe(first)
    await expect(first).resolves.toBe(0)
  })
})
