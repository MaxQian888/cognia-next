/**
 * `ctx.plans` — the plugin surface for the ADR-0045 plan hub. `ctx.goals` and
 * `ctx.team` shipped with the other two decompose-and-drive engines; this one
 * did not, so a plugin could start a goal or a team but never see, approve, or
 * run the plan those engines project into.
 */
const runtime = {
  createPlan: jest.fn(),
  updatePlanDraft: jest.fn(),
  approvePlan: jest.fn(),
  rejectPlan: jest.fn(),
  startPlan: jest.fn(),
  runPlan: jest.fn(),
  pausePlan: jest.fn(),
  resumePlan: jest.fn(),
  cancelPlan: jest.fn(),
  setStepStatus: jest.fn(),
  refinePlan: jest.fn(),
  deletePlan: jest.fn(),
  getOpenPlanForSession: jest.fn(),
  getExecutingPlanForSession: jest.fn(),
}
jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: () => runtime }))

const getPlan = jest.fn()
const listAllPlans = jest.fn()
const listPlanEvents = jest.fn()
const listPlansBySession = jest.fn()
jest.mock("@/lib/db/plans", () => ({
  getPlan: (...a: unknown[]) => getPlan(...a),
  listAllPlans: (...a: unknown[]) => listAllPlans(...a),
  listPlanEvents: (...a: unknown[]) => listPlanEvents(...a),
  listPlansBySession: (...a: unknown[]) => listPlansBySession(...a),
}))

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => ({ id: "ses" })) }))

const buildRendererLlmClient = jest.fn()
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (...a: unknown[]) => buildRendererLlmClient(...a),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}))

// Identity guard: permission enforcement has its own suite; here we assert the
// mapping is complete, not that the proxy works.
const guarded = jest.fn()
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  createGuardedAPI: (_id: string, api: unknown, map: Record<string, string>) => {
    guarded(map)
    return api
  },
}))

import { NoPlannerModelError, createPlanAPI } from "./plan-api"

beforeEach(() => {
  jest.clearAllMocks()
  buildRendererLlmClient.mockReturnValue({ complete: jest.fn() })
})

describe("createPlanAPI", () => {
  it("gates every method, reads on plan:read and mutations on plan:write", () => {
    const api = createPlanAPI("p")
    const map = guarded.mock.calls[0][0] as Record<string, string>
    // Nothing may ship ungated: a missing entry is an unguarded capability.
    expect(Object.keys(map).sort()).toEqual(Object.keys(api).sort())
    expect(map.get).toBe("plan:read")
    expect(map.listAll).toBe("plan:read")
    expect(map.run).toBe("plan:write")
    expect(map.delete).toBe("plan:write")
  })

  it("routes reads to the Dexie layer", async () => {
    getPlan.mockResolvedValue({ id: "p1" })
    listPlansBySession.mockResolvedValue([])
    listAllPlans.mockResolvedValue([])
    listPlanEvents.mockResolvedValue([])
    const api = createPlanAPI("p")
    expect(await api.get("p1")).toEqual({ id: "p1" })
    await api.listBySession("ses")
    await api.listAll(10)
    await api.getEvents("p1", 5)
    expect(listPlansBySession).toHaveBeenCalledWith("ses")
    expect(listAllPlans).toHaveBeenCalledWith(10)
    expect(listPlanEvents).toHaveBeenCalledWith("p1", 5)
  })

  it("normalises a missing plan to null instead of undefined", async () => {
    getPlan.mockResolvedValue(undefined)
    runtime.getOpenPlanForSession.mockResolvedValue(undefined)
    runtime.getExecutingPlanForSession.mockResolvedValue(undefined)
    const api = createPlanAPI("p")
    expect(await api.get("nope")).toBeNull()
    expect(await api.getOpenForSession("ses")).toBeNull()
    expect(await api.getExecutingForSession("ses")).toBeNull()
  })

  it("routes mutations through the runtime, never the db layer", async () => {
    const api = createPlanAPI("p")
    await api.create({ sessionId: "ses", title: "t", source: "manual", steps: [] })
    await api.approve("p1")
    await api.reject("p1", "no")
    await api.pause("p1")
    await api.resume("p1")
    await api.cancel("p1")
    await api.run("p1")
    await api.delete("p1")
    expect(runtime.createPlan).toHaveBeenCalled()
    expect(runtime.approvePlan).toHaveBeenCalledWith("p1")
    expect(runtime.rejectPlan).toHaveBeenCalledWith("p1", "no")
    expect(runtime.pausePlan).toHaveBeenCalledWith("p1")
    expect(runtime.resumePlan).toHaveBeenCalledWith("p1")
    expect(runtime.cancelPlan).toHaveBeenCalledWith("p1")
    expect(runtime.runPlan).toHaveBeenCalledWith("p1")
    expect(runtime.deletePlan).toHaveBeenCalledWith("p1")
  })

  it("passes a step result through as a patch and omits it when absent", async () => {
    const api = createPlanAPI("p")
    await api.setStepStatus("p1", "s1", "completed", "did it")
    expect(runtime.setStepStatus).toHaveBeenCalledWith("p1", "s1", "completed", {
      result: "did it",
    })
    await api.setStepStatus("p1", "s1", "failed")
    expect(runtime.setStepStatus).toHaveBeenLastCalledWith("p1", "s1", "failed", {})
  })

  it("narrows start() to the strategy + status the host needs", async () => {
    runtime.startPlan.mockResolvedValue({
      strategy: "in_session",
      status: "executing",
      stepId: "s1",
      userMessage: "go",
    })
    const api = createPlanAPI("p")
    expect(await api.start("p1")).toEqual({ strategy: "in_session", status: "executing" })
    runtime.startPlan.mockResolvedValue(null)
    expect(await api.start("p1")).toBeNull()
  })

  it("refines as a manual trigger so it is not capped by the auto budget", async () => {
    getPlan.mockResolvedValue({ id: "p1", sessionId: "ses" })
    const api = createPlanAPI("p")
    await api.refine("p1", "expand", "add a rollback step")
    expect(runtime.refinePlan).toHaveBeenCalledWith(
      {
        planId: "p1",
        refinementType: "expand",
        trigger: "manual",
        customInstructions: "add a rollback step",
      },
      expect.anything()
    )
  })

  it("throws a typed error when no planner model is configured", async () => {
    getPlan.mockResolvedValue({ id: "p1", sessionId: "ses" })
    buildRendererLlmClient.mockReturnValue(null)
    const api = createPlanAPI("p")
    await expect(api.refine("p1", "repair")).rejects.toBeInstanceOf(NoPlannerModelError)
    expect(runtime.refinePlan).not.toHaveBeenCalled()
  })

  it("returns null rather than calling the planner for a missing plan", async () => {
    getPlan.mockResolvedValue(undefined)
    const api = createPlanAPI("p")
    expect(await api.refine("gone", "optimize")).toBeNull()
    expect(buildRendererLlmClient).not.toHaveBeenCalled()
  })
})
