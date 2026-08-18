import type { SDKMessage } from "@cognia/agent-config-types"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import {
  applyPlanToolCalls,
  findPlanToolCalls,
  planInputFromCreateTool,
  planStepsFromToolInput,
  resolveStepId,
} from "./agent-tool-capture"

const createPlan = jest.fn()
const updatePlanDraft = jest.fn()
const setStepStatus = jest.fn()
const getPlan = jest.fn()
const getOpenPlanForSession = jest.fn()

jest.mock("./runtime", () => ({
  getPlanRuntime: () => ({
    createPlan: (...a: unknown[]) => createPlan(...a),
    updatePlanDraft: (...a: unknown[]) => updatePlanDraft(...a),
    setStepStatus: (...a: unknown[]) => setStepStatus(...a),
    getPlan: (...a: unknown[]) => getPlan(...a),
    getOpenPlanForSession: (...a: unknown[]) => getOpenPlanForSession(...a),
  }),
}))

const loadPlanConfigDefaults = jest.fn()
jest.mock("./plan-settings", () => ({
  loadPlanConfigDefaults: () => loadPlanConfigDefaults(),
}))

function toolEvent(name: string, input: unknown): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name, input }] },
  } as unknown as SDKMessage
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Plan",
    source: "agent_tool",
    executionMode: "auto",
    steps: [
      {
        id: "s1",
        title: "one",
        kind: "agent_turn",
        status: "pending",
        order: 0,
        dependencies: [],
      },
      {
        id: "s2",
        title: "two",
        kind: "agent_turn",
        status: "pending",
        order: 1,
        dependencies: ["s1"],
      },
    ],
    status: "awaiting_approval",
    totalSteps: 2,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as AgentPlan
}

beforeEach(() => {
  jest.clearAllMocks()
  loadPlanConfigDefaults.mockResolvedValue(undefined)
  createPlan.mockImplementation(async (input) => plan({ title: input.title }))
  updatePlanDraft.mockResolvedValue(plan())
  setStepStatus.mockResolvedValue(plan())
  getPlan.mockResolvedValue(plan())
  getOpenPlanForSession.mockResolvedValue(plan())
})

describe("findPlanToolCalls", () => {
  it("matches the snake_case, PascalCase and namespaced spellings", () => {
    for (const name of ["create_plan", "CreatePlan", "mcp__cognia-tools__create_plan"]) {
      expect(findPlanToolCalls(toolEvent(name, { title: "x" }))[0]?.tool).toBe("create")
    }
    for (const name of ["update_plan", "UpdatePlan", "mcp__cognia-tools__update_plan"]) {
      expect(findPlanToolCalls(toolEvent(name, {}))[0]?.tool).toBe("update")
    }
  })

  it("ignores unrelated tools and non-assistant events", () => {
    expect(findPlanToolCalls(toolEvent("Read", { path: "a" }))).toEqual([])
    expect(findPlanToolCalls({ type: "system" } as unknown as SDKMessage)).toEqual([])
  })
})

describe("planStepsFromToolInput", () => {
  it("builds a linear agent_turn chain from bare titles", () => {
    const steps = planStepsFromToolInput(["a", "b"])
    expect(steps.map((s) => s.kind)).toEqual(["agent_turn", "agent_turn"])
    expect(steps[1].dependsOn).toEqual([0])
  })

  it("honours kind, description and an explicit dependsOn", () => {
    const steps = planStepsFromToolInput([
      { title: "a" },
      { title: "b", kind: "approval_gate", description: "check", dependsOn: [] },
    ])
    expect(steps[1]).toMatchObject({ kind: "approval_gate", description: "check" })
    // An explicit empty list detaches the step — it must not fall back to the
    // implicit predecessor edge.
    expect(steps[1].dependsOn).toEqual([])
  })

  it("keeps params only when they satisfy the executor's contract", () => {
    const steps = planStepsFromToolInput([
      { title: "delegate", kind: "teammate_dispatch", params: { teamId: "t1" } },
      { title: "broken", kind: "sub_workflow", params: { nope: 1 } },
    ])
    expect(steps[0].params).toEqual({ kind: "teammate_dispatch", teamId: "t1" })
    // Kind survives so the dispatcher raises a precise "requires workflowId".
    expect(steps[1]).toMatchObject({ kind: "sub_workflow" })
    expect(steps[1].params).toBeUndefined()
  })

  it("drops forward and self references in dependsOn", () => {
    const steps = planStepsFromToolInput([{ title: "a" }, { title: "b", dependsOn: [0, 1, 5] }])
    expect(steps[1].dependsOn).toEqual([0])
  })

  it("returns nothing for a non-array or title-less payload", () => {
    expect(planStepsFromToolInput("nope")).toEqual([])
    expect(planStepsFromToolInput([{ description: "no title" }])).toEqual([])
  })
})

describe("planInputFromCreateTool", () => {
  it("stamps the agent_tool provenance and defaults the mode to auto", () => {
    const input = planInputFromCreateTool(
      { title: "Ship", steps: ["a"] },
      { sessionId: "ses", characterId: "c1" }
    )
    expect(input).toMatchObject({
      sessionId: "ses",
      characterId: "c1",
      source: "agent_tool",
      executionMode: "auto",
    })
  })

  it("accepts a valid executionMode and rejects an invalid one", () => {
    expect(
      planInputFromCreateTool(
        { title: "t", steps: ["a"], executionMode: "orchestrated" },
        { sessionId: "s" }
      )?.executionMode
    ).toBe("orchestrated")
    expect(
      planInputFromCreateTool(
        { title: "t", steps: ["a"], executionMode: "sideways" },
        { sessionId: "s" }
      )?.executionMode
    ).toBe("auto")
  })

  it("returns null without a title or without steps", () => {
    expect(planInputFromCreateTool({ steps: ["a"] }, { sessionId: "s" })).toBeNull()
    expect(planInputFromCreateTool({ title: "t", steps: [] }, { sessionId: "s" })).toBeNull()
  })
})

describe("resolveStepId", () => {
  it("resolves an ordered index or a literal id", () => {
    expect(resolveStepId(plan(), 1)).toBe("s2")
    expect(resolveStepId(plan(), "s1")).toBe("s1")
  })

  it("rejects an out-of-range index or unknown id", () => {
    expect(resolveStepId(plan(), 9)).toBeNull()
    expect(resolveStepId(plan(), "nope")).toBeNull()
  })
})

describe("applyPlanToolCalls", () => {
  it("is a no-op when the event carries no plan tool call", async () => {
    expect(await applyPlanToolCalls(toolEvent("Read", {}), "ses")).toBeNull()
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("creates a plan with the user's plan defaults merged in", async () => {
    loadPlanConfigDefaults.mockResolvedValue({ requireApproval: false })
    const res = await applyPlanToolCalls(
      toolEvent("create_plan", { title: "Ship", steps: ["a", "b"] }),
      "ses",
      "char_1"
    )
    expect(createPlan).toHaveBeenCalledTimes(1)
    expect(createPlan.mock.calls[0][0]).toMatchObject({
      source: "agent_tool",
      config: { requireApproval: false },
      characterId: "char_1",
    })
    expect(res?.created).toBeTruthy()
  })

  it("routes an update without planId to the session's open plan", async () => {
    await applyPlanToolCalls(toolEvent("update_plan", { title: "Renamed" }), "ses")
    expect(getOpenPlanForSession).toHaveBeenCalledWith("ses")
    expect(updatePlanDraft).toHaveBeenCalledWith("p1", { title: "Renamed" })
  })

  it("applies step progress updates by index and by id", async () => {
    const res = await applyPlanToolCalls(
      toolEvent("update_plan", {
        stepUpdates: [
          { step: 0, status: "completed", result: "done" },
          { step: "s2", status: "in_progress" },
        ],
      }),
      "ses"
    )
    expect(setStepStatus).toHaveBeenNthCalledWith(1, "p1", "s1", "completed", { result: "done" })
    expect(setStepStatus).toHaveBeenNthCalledWith(2, "p1", "s2", "in_progress", {})
    expect(res?.stepUpdates).toBe(2)
  })

  it("ignores an unknown status or unresolvable step instead of throwing", async () => {
    const res = await applyPlanToolCalls(
      toolEvent("update_plan", {
        stepUpdates: [
          { step: 0, status: "banana" },
          { step: 42, status: "completed" },
        ],
      }),
      "ses"
    )
    expect(setStepStatus).not.toHaveBeenCalled()
    expect(res?.stepUpdates).toBe(0)
  })

  it("no-ops when there is no plan to update", async () => {
    getOpenPlanForSession.mockResolvedValue(undefined)
    const res = await applyPlanToolCalls(toolEvent("update_plan", { title: "x" }), "ses")
    expect(updatePlanDraft).not.toHaveBeenCalled()
    expect(res).toEqual({ stepUpdates: 0 })
  })
})
