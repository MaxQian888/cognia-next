// The Dexie layer is mocked rather than driven through fake-indexeddb: the
// driver's whole job is the decision sequence (guard → complete → advance →
// finish), and an in-memory row store keeps that legible and fast. `./steps`
// and `./prompts` stay REAL so the tests pin the actual next-step selection and
// the actual dispatched text.

jest.mock("@/lib/db/plans", () => ({
  getPlan: jest.fn(),
  updatePlan: jest.fn(),
  appendPlanEvent: jest.fn(),
}))
jest.mock("./notify", () => ({ emitPlanStatus: jest.fn() }))
jest.mock("./runtime", () => ({ getPlanRuntime: jest.fn() }))

import { getPlan, updatePlan, appendPlanEvent } from "@/lib/db/plans"
import { getPlanRuntime } from "./runtime"
import { advancePlanToNextStep, currentInProgressStep, handlePlanTurnComplete } from "./turn-driver"
import type { AgentPlan, PlanStep, PlanStepStatus } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

const getPlanMock = getPlan as jest.Mock
const updatePlanMock = updatePlan as jest.Mock
const appendPlanEventMock = appendPlanEvent as jest.Mock
const getPlanRuntimeMock = getPlanRuntime as jest.Mock

const finishPlanRun = jest.fn()

const GEN = "gen-1"

function step(i: number, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: `s${i}`,
    title: `step ${i}`,
    kind: "agent_turn",
    status: "pending",
    order: i,
    dependencies: i > 0 ? [`s${i - 1}`] : [],
    ...over,
  }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? [step(0), step(1), step(2)]
  return {
    id: "p1",
    sessionId: "ses_a",
    title: "Ship v2",
    source: "manual",
    executionMode: "in_session",
    steps,
    status: "executing",
    totalSteps: steps.length,
    completedSteps: steps.filter((s) => s.status === "completed").length,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: GEN,
    createdAt: 0,
    updatedAt: 1_000,
    ...over,
  }
}

/**
 * Back `getPlan` with a mutable row that `updatePlan` patches, so the driver's
 * re-reads observe its own writes (as they do against Dexie).
 */
function seed(row: AgentPlan): { current: () => AgentPlan } {
  let live = row
  getPlanMock.mockImplementation(async () => live)
  updatePlanMock.mockImplementation(async (_id: string, patch: Partial<AgentPlan>) => {
    live = { ...live, ...patch }
  })
  return { current: () => live }
}

function statuses(row: AgentPlan): PlanStepStatus[] {
  return [...row.steps].sort((a, b) => a.order - b.order).map((s) => s.status)
}

beforeEach(() => {
  jest.clearAllMocks()
  finishPlanRun.mockResolvedValue(undefined)
  getPlanRuntimeMock.mockReturnValue({ finishPlanRun })
  appendPlanEventMock.mockResolvedValue(undefined)
})

describe("currentInProgressStep", () => {
  it("prefers the explicit cursor", () => {
    const steps = [step(0, { status: "in_progress" }), step(1, { status: "in_progress" })]
    expect(currentInProgressStep(steps, "s1")?.id).toBe("s1")
  })

  it("falls back to the first in-progress step when the cursor is stale", () => {
    const steps = [step(0, { status: "completed" }), step(1, { status: "in_progress" })]
    expect(currentInProgressStep(steps, "s0")?.id).toBe("s1")
  })

  it("returns undefined when nothing is running", () => {
    expect(currentInProgressStep([step(0)], undefined)).toBeUndefined()
  })
})

describe("advancePlanToNextStep", () => {
  it("starts the first runnable step and returns its turn text", async () => {
    const store = seed(plan())
    const out = await advancePlanToNextStep("p1", GEN)

    expect(out).toMatchObject({ kind: "continue", stepId: "s0", stepTitle: "step 0" })
    expect(statuses(store.current())).toEqual(["in_progress", "pending", "pending"])
    expect(store.current().currentStepId).toBe("s0")
    expect(appendPlanEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "step_started" })
    )
    if (out.kind !== "continue") throw new Error("expected continue")
    // The dispatched text carries the step as DATA and pins its position.
    expect(out.userMessage).toContain("Step 1 of 3")
    expect(out.userMessage).toContain("<step>")
    expect(out.userMessage).toContain("step 0")
  })

  it("skips a step whose dependency has not completed", async () => {
    // s1 depends on s0; s0 failed ⇒ nothing is runnable.
    const store = seed(plan({ steps: [step(0, { status: "failed" }), step(1)] }))
    const out = await advancePlanToNextStep("p1", GEN)
    expect(out).toEqual({
      kind: "exit",
      status: "failed",
      reason: "a step failed and the remaining steps depend on it",
    })
    expect(finishPlanRun).toHaveBeenCalledWith("p1", "failed", expect.any(String))
    expect(statuses(store.current())).toEqual(["failed", "pending"])
  })

  it("completes the plan when every step is terminal", async () => {
    seed(
      plan({
        steps: [step(0, { status: "completed" }), step(1, { status: "skipped" })],
      })
    )
    const out = await advancePlanToNextStep("p1", GEN)
    expect(out).toEqual({
      kind: "exit",
      status: "completed",
      reason: "every plan step completed",
    })
    expect(finishPlanRun).toHaveBeenCalledWith("p1", "completed", "every plan step completed")
  })

  it("reports no_plan for a missing row", async () => {
    getPlanMock.mockResolvedValue(undefined)
    expect(await advancePlanToNextStep("ghost", GEN)).toEqual({ kind: "no_plan" })
  })

  it("refuses to advance a rotated generation", async () => {
    seed(plan({ generationId: "gen-2" }))
    expect(await advancePlanToNextStep("p1", GEN)).toEqual({
      kind: "stale",
      reason: "generationId rotated before advancing",
    })
    expect(updatePlanMock).not.toHaveBeenCalled()
  })
})

describe("handlePlanTurnComplete", () => {
  it("completes the running step, stores the result, and starts the next", async () => {
    const store = seed(
      plan({ steps: [step(0, { status: "in_progress" }), step(1), step(2)], currentStepId: "s0" })
    )
    const out = await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "  wrote the changelog  ",
      capturedGenerationId: GEN,
    })

    expect(out).toMatchObject({ kind: "continue", stepId: "s1" })
    expect(statuses(store.current())).toEqual(["completed", "in_progress", "pending"])
    expect(store.current().steps[0].result).toBe("wrote the changelog")
    expect(store.current().completedSteps).toBe(1)
    const kinds = appendPlanEventMock.mock.calls.map((c) => c[0].kind)
    expect(kinds).toEqual(["step_completed", "step_started"])
  })

  it("truncates an over-long response into the step result", async () => {
    const store = seed(plan({ steps: [step(0, { status: "in_progress" })], currentStepId: "s0" }))
    await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "x".repeat(900),
      capturedGenerationId: GEN,
    })
    expect(store.current().steps[0].result).toHaveLength(500)
  })

  it("omits an empty result rather than storing a blank string", async () => {
    const store = seed(plan({ steps: [step(0, { status: "in_progress" })], currentStepId: "s0" }))
    await handlePlanTurnComplete({ planId: "p1", lastResponse: "   ", capturedGenerationId: GEN })
    expect(store.current().steps[0].result).toBeUndefined()
  })

  it("exits when the last step completes", async () => {
    seed(
      plan({
        steps: [step(0, { status: "completed" }), step(1, { status: "in_progress" })],
        currentStepId: "s1",
      })
    )
    const out = await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "done",
      capturedGenerationId: GEN,
    })
    expect(out).toMatchObject({ kind: "exit", status: "completed" })
    expect(finishPlanRun).toHaveBeenCalledWith("p1", "completed", "every plan step completed")
  })

  it("advances even when no step was marked in progress", async () => {
    const store = seed(plan())
    const out = await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "hello",
      capturedGenerationId: GEN,
    })
    expect(out).toMatchObject({ kind: "continue", stepId: "s0" })
    expect(appendPlanEventMock.mock.calls.map((c) => c[0].kind)).toEqual(["step_started"])
    expect(statuses(store.current())).toEqual(["in_progress", "pending", "pending"])
  })

  it("reports no_plan for a missing row", async () => {
    getPlanMock.mockResolvedValue(undefined)
    expect(
      await handlePlanTurnComplete({ planId: "x", lastResponse: "", capturedGenerationId: GEN })
    ).toEqual({ kind: "no_plan" })
  })

  it.each([
    ["draft" as const, "plan status is draft"],
    ["paused" as const, "plan status is paused"],
    ["cancelled" as const, "plan status is cancelled"],
  ])("refuses to drive a %s plan", async (status, reason) => {
    seed(plan({ status }))
    expect(
      await handlePlanTurnComplete({ planId: "p1", lastResponse: "x", capturedGenerationId: GEN })
    ).toEqual({ kind: "stale", reason })
    expect(updatePlanMock).not.toHaveBeenCalled()
  })

  it("refuses when the generation rotated mid-turn (pause / cancel / refine)", async () => {
    seed(plan({ generationId: "gen-9" }))
    expect(
      await handlePlanTurnComplete({ planId: "p1", lastResponse: "x", capturedGenerationId: GEN })
    ).toEqual({ kind: "stale", reason: "generationId rotated since turn start" })
    expect(updatePlanMock).not.toHaveBeenCalled()
  })

  it("returns aborted without touching the row", async () => {
    seed(plan())
    const ac = new AbortController()
    ac.abort()
    expect(
      await handlePlanTurnComplete({
        planId: "p1",
        lastResponse: "x",
        capturedGenerationId: GEN,
        signal: ac.signal,
      })
    ).toEqual({ kind: "aborted" })
    expect(updatePlanMock).not.toHaveBeenCalled()
  })

  // The post-commit re-check: a pause / cancel landing while the step was being
  // written owns what happens next, so the driver must not start another step.
  it("stops when the generation rotates AFTER the step commit", async () => {
    const store = seed(plan({ steps: [step(0, { status: "in_progress" }), step(1)] }))
    updatePlanMock.mockImplementationOnce(async (_id: string, patch: Partial<AgentPlan>) => {
      Object.assign(store.current(), patch, { generationId: "gen-rotated" })
    })
    const out = await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "done",
      capturedGenerationId: GEN,
    })
    expect(out).toEqual({ kind: "stale", reason: "generationId rotated after step commit" })
    expect(statuses(store.current())).toEqual(["completed", "pending"])
  })

  it("stops when the row disappears after the step commit", async () => {
    seed(plan({ steps: [step(0, { status: "in_progress" }), step(1)] }))
    getPlanMock.mockImplementationOnce(async () =>
      plan({ steps: [step(0, { status: "in_progress" }), step(1)], currentStepId: "s0" })
    )
    getPlanMock.mockImplementation(async () => undefined)
    expect(
      await handlePlanTurnComplete({ planId: "p1", lastResponse: "x", capturedGenerationId: GEN })
    ).toEqual({ kind: "no_plan" })
  })

  it("returns aborted when the signal fires during the step commit", async () => {
    const store = seed(plan({ steps: [step(0, { status: "in_progress" }), step(1)] }))
    const ac = new AbortController()
    updatePlanMock.mockImplementationOnce(async (_id: string, patch: Partial<AgentPlan>) => {
      Object.assign(store.current(), patch)
      ac.abort()
    })
    expect(
      await handlePlanTurnComplete({
        planId: "p1",
        lastResponse: "done",
        capturedGenerationId: GEN,
        signal: ac.signal,
      })
    ).toEqual({ kind: "aborted" })
    // The finished step is still recorded — only the ADVANCE is abandoned.
    expect(statuses(store.current())).toEqual(["completed", "pending"])
  })
})

describe("advancePlanToNextStep — degraded reads", () => {
  it("renders the turn text from the pre-write snapshot when the re-read misses", async () => {
    // `getPlan` succeeds for the guard, then returns undefined for the
    // post-write refresh; the message must still name the right step.
    const row = plan()
    getPlanMock.mockImplementationOnce(async () => row)
    getPlanMock.mockImplementation(async () => undefined)
    updatePlanMock.mockResolvedValue(undefined)

    const out = await advancePlanToNextStep("p1", GEN)
    expect(out).toMatchObject({ kind: "continue", stepId: "s0" })
    if (out.kind !== "continue") throw new Error("expected continue")
    expect(out.userMessage).toContain("Step 1 of 3")
  })
})

describe("lifecycle hooks around a plan step", () => {
  /** A firer that records every event and can block one of them. */
  function recordingFirer(block?: { event: string; reason: string }, context?: string) {
    const fired: { event: string; agentKind?: string; agentRef?: string; payload?: unknown }[] = []
    const firer = jest.fn(
      async (
        event: string,
        ctx: { agentKind?: string; agentRef?: string },
        opts?: { payload?: Record<string, unknown> }
      ) => {
        fired.push({
          event,
          ...(ctx.agentKind ? { agentKind: ctx.agentKind } : {}),
          ...(ctx.agentRef ? { agentRef: ctx.agentRef } : {}),
          payload: opts?.payload,
        })
        if (block && block.event === event) return { block: block.reason, warnings: [] }
        if (context && event === "UserPromptSubmit")
          return { block: null, additionalContext: context, warnings: [] }
        return { block: null, warnings: [] }
      }
    )
    return { fired, firer: firer as never }
  }

  beforeEach(() => {
    getPlanRuntimeMock.mockReturnValue({ finishPlanRun })
  })

  it("brackets the dispatched step with SessionStart + UserPromptSubmit", async () => {
    seed(plan())
    const { fired, firer } = recordingFirer()

    const outcome = await advancePlanToNextStep("p1", GEN, { firer })

    expect(outcome.kind).toBe("continue")
    expect(fired.map((f) => f.event)).toEqual(["SessionStart", "UserPromptSubmit"])
    // The identity is what makes an `agents: "plan-step"` selector work — the
    // whole reason this seam exists.
    expect(fired[0]!.agentKind).toBe("plan-step")
    expect(fired[0]!.agentRef).toBe("s0")
    expect(fired[1]!.payload).toMatchObject({
      phase: "plan-step",
      planId: "p1",
      stepId: "s0",
      stepTitle: "step 0",
    })
  })

  it("appends a hook's additionalContext to the dispatched step message", async () => {
    seed(plan())
    const { firer } = recordingFirer(undefined, "Remember: repo is read-only today.")

    const outcome = await advancePlanToNextStep("p1", GEN, { firer })

    expect(outcome.kind).toBe("continue")
    if (outcome.kind !== "continue") throw new Error("unreachable")
    expect(outcome.userMessage).toContain("Remember: repo is read-only today.")
    // Injected, not replaced — the step instructions must survive.
    expect(outcome.userMessage).toContain("step 0")
  })

  it("PAUSES the plan when a hook blocks, rather than failing it", async () => {
    const row = seed(plan())
    const { firer } = recordingFirer({ event: "UserPromptSubmit", reason: "budget exhausted" })

    const outcome = await advancePlanToNextStep("p1", GEN, { firer })

    expect(outcome).toEqual({ kind: "exit", status: "paused", reason: "budget exhausted" })
    // Paused, not failed: the plan is fine, a policy said "not now", and the
    // user can fix the hook and resume from the tracker dock.
    expect(row.current().status).toBe("paused")
    expect(appendPlanEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "p1",
        kind: "exit",
        payload: { kind: "exit", status: "paused", reason: "budget exhausted" },
      })
    )
  })

  it("fires Stop for the finished step before advancing", async () => {
    seed(plan({ steps: [step(0, { status: "in_progress" }), step(1)], currentStepId: "s0" }))
    const { fired, firer } = recordingFirer()

    await handlePlanTurnComplete({
      planId: "p1",
      lastResponse: "done",
      capturedGenerationId: GEN,
      firer,
    })

    // Stop closes the bracket for s0; the next step then opens its own.
    const stop = fired.find((f) => f.event === "Stop")
    expect(stop).toBeDefined()
    expect(stop!.agentRef).toBe("s0")
  })

  it("is a silent no-op when no firer is injected", async () => {
    seed(plan())
    // Every pre-existing caller passes nothing — behaviour must be unchanged.
    const outcome = await advancePlanToNextStep("p1", GEN)
    expect(outcome.kind).toBe("continue")
  })
})
