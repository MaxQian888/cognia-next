import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AgentPlan, PlanRefinementRequest, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import {
  decomposeIntoPlan,
  PLAN_DECOMPOSE_PROMPT,
  PLAN_DECOMPOSE_REQUEST_PROMPT,
  PLAN_REFINE_PROMPT,
  refinePlanSteps,
} from "./planner"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { PromptScope } from "@/lib/prompts/types"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function publish(
  promptId: string,
  scope: PromptScope,
  targetId: string,
  revisionId: string,
  body: string
): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      { bindingId: "pob", promptId, scope, targetId, revisionId, body, contractVersion: 1 },
    ])
  )
}

function systemOf(c: LlmClient): string | undefined {
  return ((c.complete as jest.Mock).mock.calls[0][1] as { system?: string }).system
}

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

describe("planner prompts in the Prompt Center", () => {
  const DECOMPOSE_OVERRIDE = 'Plan it. Reply {"title":"...","steps":["..."]}'

  it("sends the shipped prompts when nothing is published", async () => {
    const c = client('{"steps":["a"]}')
    await decomposeIntoPlan({ objective: "Ship", sessionId: "ses", client: c })
    expect(systemOf(c)).toBe(PLAN_DECOMPOSE_PROMPT.defaultBody)
    expect((c.complete as jest.Mock).mock.calls[0][0]).toBe(
      PLAN_DECOMPOSE_REQUEST_PROMPT.defaultBody.replace("{{objective}}", "Ship")
    )
  })

  it("decomposes with a workspace override only inside that workspace", async () => {
    publish(
      PLAN_DECOMPOSE_PROMPT.id,
      "workspace",
      "ws-1",
      "por-plan-decompose-ws",
      DECOMPOSE_OVERRIDE
    )
    const inside = client('{"steps":["a"]}')
    await decomposeIntoPlan({
      objective: "x",
      sessionId: "ses",
      workspaceId: "ws-1",
      client: inside,
    })
    expect(systemOf(inside)).toBe(DECOMPOSE_OVERRIDE)

    const outside = client('{"steps":["a"]}')
    await decomposeIntoPlan({ objective: "x", sessionId: "ses", client: outside })
    expect(systemOf(outside)).toBe(PLAN_DECOMPOSE_PROMPT.defaultBody)
  })

  it("refines with the override published for the plan's session", async () => {
    const body = 'Revise. Reply {"steps":["..."],"reasoning":"..."}'
    publish(PLAN_REFINE_PROMPT.id, "session", "ses", "por-plan-refine-session", body)
    const c = client('{"steps":["x"],"reasoning":"r"}')
    await refinePlanSteps(
      plan([step("a")]),
      { planId: "p1", refinementType: "optimize", trigger: "manual" },
      c
    )
    expect(systemOf(c)).toBe(body)
  })

  it("does not call the model when the run was aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const c = client('{"steps":["a"]}')
    expect(
      await decomposeIntoPlan({ objective: "x", sessionId: "ses", client: c, signal: ac.signal })
    ).toBeNull()
    expect(c.complete).not.toHaveBeenCalled()
  })
})
