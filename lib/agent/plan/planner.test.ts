import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AgentPlan, PlanRefinementRequest, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { decomposeIntoPlan, refinePlanSteps } from "./planner"

function client(reply: string | (() => Promise<string>)): LlmClient {
  return {
    complete: jest.fn(async () => (typeof reply === "function" ? reply() : reply)),
  } as unknown as LlmClient
}

describe("decomposeIntoPlan", () => {
  const base = { objective: "Ship the widget", sessionId: "ses", characterId: "c1" }

  it("builds a linear agent_turn planner_llm plan from JSON steps", async () => {
    const input = await decomposeIntoPlan({
      ...base,
      client: client('{"title":"Widget plan","steps":["design","build","test"]}'),
    })
    expect(input).not.toBeNull()
    expect(input!.source).toBe("planner_llm")
    expect(input!.title).toBe("Widget plan")
    expect(input!.characterId).toBe("c1")
    expect(input!.steps.map((s) => s.title)).toEqual(["design", "build", "test"])
    expect(input!.steps[2].dependsOn).toEqual([1])
  })

  it("accepts object-form steps and dedupes/caps", async () => {
    const input = await decomposeIntoPlan({
      ...base,
      client: client('{"steps":[{"title":"a"},{"content":"a"},{"description":"b"}]}'),
    })
    expect(input!.steps.map((s) => s.title)).toEqual(["a", "b"])
  })

  it("falls back to the first step as the title when title missing", async () => {
    const input = await decomposeIntoPlan({ ...base, client: client('{"steps":["only step"]}') })
    expect(input!.title).toBe("only step")
  })

  it("returns null on abort, LLM throw, bad JSON, and empty steps", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await decomposeIntoPlan({ ...base, client: client("{}"), signal: ac.signal })).toBeNull()
    expect(
      await decomposeIntoPlan({
        ...base,
        client: client(() => Promise.reject(new Error("net"))),
      })
    ).toBeNull()
    expect(await decomposeIntoPlan({ ...base, client: client("not json") })).toBeNull()
    expect(await decomposeIntoPlan({ ...base, client: client('{"steps":[]}') })).toBeNull()
  })
})

function plan(steps: PlanStep[], over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: over.title ?? "My plan",
    source: "manual",
    executionMode: "auto",
    steps,
    status: "failed",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: over.title ?? id,
    kind: "agent_turn",
    status: over.status ?? "pending",
    order: over.order ?? 0,
    dependencies: [],
    error: over.error,
  }
}

describe("refinePlanSteps", () => {
  it("returns revised titles + reasoning", async () => {
    const c = client('{"steps":["x","y"],"reasoning":"split step"}')
    const res = await refinePlanSteps(
      plan([step("a", { title: "big step", status: "failed", error: "oops" })]),
      { planId: "p1", refinementType: "repair", trigger: "step_failure", failedStepId: "a" },
      c
    )
    expect(res).toEqual({ titles: ["x", "y"], reasoning: "split step" })
    // The failed step title + error are surfaced to the model.
    const prompt = (c.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("big step")
    expect(prompt).toContain("oops")
  })

  it("includes custom instructions in the prompt", async () => {
    const c = client('{"steps":["x"]}')
    await refinePlanSteps(
      plan([step("a")]),
      {
        planId: "p1",
        refinementType: "optimize",
        trigger: "manual",
        customInstructions: "make it parallel",
      },
      c
    )
    expect((c.complete as jest.Mock).mock.calls[0][0]).toContain("make it parallel")
  })

  it("fails OPEN to null on abort / throw / bad JSON / empty", async () => {
    const req: PlanRefinementRequest = { planId: "p1", refinementType: "repair", trigger: "manual" }
    const ac = new AbortController()
    ac.abort()
    expect(await refinePlanSteps(plan([step("a")]), req, client("{}"), ac.signal)).toBeNull()
    expect(
      await refinePlanSteps(
        plan([step("a")]),
        req,
        client(() => Promise.reject(new Error("x")))
      )
    ).toBeNull()
    expect(await refinePlanSteps(plan([step("a")]), req, client("nope"))).toBeNull()
    expect(await refinePlanSteps(plan([step("a")]), req, client('{"steps":[]}'))).toBeNull()
  })
})
