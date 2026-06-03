import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listPlanEvents } from "@/lib/db/plans"
import type { CreatePlanInput } from "@/types/agent/plan"
import * as detect from "@/lib/platform/detect"
import { __resetPlanRuntimeForTesting, getPlanRuntime, resolvePlanConfig } from "./runtime"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

// Partial mock of the platform leaf so `isTauri` is controllable while every
// other export keeps its real implementation (the db layer may use them). The
// SWC-compiled `export function isTauri` is non-configurable, so `spyOn` can't
// redefine it — a module mock is the only reliable seam.
jest.mock("@/lib/platform/detect", () => {
  const actual = jest.requireActual("@/lib/platform/detect")
  return { ...actual, isTauri: jest.fn(() => false) }
})

// Virtual mock for the Tauri event module the runtime dynamically imports in
// `emitPlanStatus` — the web build never resolves it, so it's declared virtual.
jest.mock("@tauri-apps/api/event", () => ({ emit: jest.fn().mockResolvedValue(undefined) }), {
  virtual: true,
})

// Mock the workflow orchestrator so `runPlan` exercises its own
// transition/synthesis/context logic without actually executing step nodes.
const runWorkflowMock = jest.fn()
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
}))

const isTauriMock = detect.isTauri as jest.Mock

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetPlanRuntimeForTesting()
  isTauriMock.mockReturnValue(false)
  runWorkflowMock.mockReset()
})

function createInput(over: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return {
    sessionId: over.sessionId ?? "ses_a",
    title: over.title ?? "Ship it",
    source: over.source ?? "manual",
    executionMode: over.executionMode,
    steps: over.steps ?? [
      { title: "step a", kind: "agent_turn" },
      { title: "step b", kind: "agent_turn", dependsOn: [0] },
    ],
    config: over.config,
    metadata: over.metadata,
  }
}

describe("resolvePlanConfig", () => {
  it("returns defaults with no overrides", () => {
    expect(resolvePlanConfig()).toEqual(DEFAULT_PLAN_CONFIG)
  })
  it("merges overrides over defaults", () => {
    expect(resolvePlanConfig({ requireApproval: false, maxStepRetries: 3 })).toMatchObject({
      requireApproval: false,
      maxStepRetries: 3,
      maxAutoRefinements: DEFAULT_PLAN_CONFIG.maxAutoRefinements,
    })
  })
})

describe("createPlan", () => {
  it("materialises steps, defaults executionMode to auto, awaits approval", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    expect(plan.status).toBe("awaiting_approval")
    expect(plan.executionMode).toBe("auto")
    expect(plan.totalSteps).toBe(2)
    expect(plan.completedSteps).toBe(0)
    expect(plan.steps[1].dependencies).toEqual([plan.steps[0].id])
    const events = await listPlanEvents(plan.id)
    expect(events.map((e) => e.kind)).toContain("plan_created")
  })

  it("creates approved directly when requireApproval is false", async () => {
    const plan = await getPlanRuntime().createPlan(
      createInput({ config: { requireApproval: false } })
    )
    expect(plan.status).toBe("approved")
  })

  it("cancels a prior open plan to keep one-open-per-session", async () => {
    const rt = getPlanRuntime()
    const first = await rt.createPlan(createInput())
    const second = await rt.createPlan(createInput({ title: "Second" }))
    expect((await rt.getPlan(first.id))?.status).toBe("cancelled")
    expect((await rt.getOpenPlanForSession("ses_a"))?.id).toBe(second.id)
  })
})

describe("lifecycle transitions", () => {
  it("approvePlan moves awaiting_approval → approved", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const approved = await rt.approvePlan(plan.id)
    expect(approved?.status).toBe("approved")
    const events = await listPlanEvents(plan.id)
    expect(events.map((e) => e.kind)).toContain("approved")
  })

  it("rejectPlan cancels and records feedback", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const rejected = await rt.rejectPlan(plan.id, "too vague")
    expect(rejected?.status).toBe("cancelled")
    const events = await listPlanEvents(plan.id)
    const rej = events.find((e) => e.kind === "rejected")
    expect(rej?.payload).toMatchObject({ kind: "rejected", feedback: "too vague" })
  })

  it("pause/resume round-trips an executing plan and fires the abort controller", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    // Simulate the runtime moving the plan into executing.
    const db = getDb()
    await db.agentPlans.update(plan.id, { status: "executing" })

    const ac = new AbortController()
    rt.registerAbortController(plan.id, ac)
    const paused = await rt.pausePlan(plan.id)
    expect(paused?.status).toBe("paused")
    expect(ac.signal.aborted).toBe(true)

    const resumed = await rt.resumePlan(plan.id)
    expect(resumed?.status).toBe("executing")
  })

  it("cancelPlan terminates any non-terminal plan and logs exit", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const cancelled = await rt.cancelPlan(plan.id)
    expect(cancelled?.status).toBe("cancelled")
    const kinds = (await listPlanEvents(plan.id)).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(["cancelled", "exit"]))
  })

  it("transition methods are no-ops on missing / terminal plans", async () => {
    const rt = getPlanRuntime()
    expect(await rt.approvePlan("ghost")).toBeNull()
    expect(await rt.pausePlan("ghost")).toBeNull()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    // Already terminal — approve/pause/reject return the unchanged row.
    expect((await rt.approvePlan(plan.id))?.status).toBe("cancelled")
    expect((await rt.pausePlan(plan.id))?.status).toBe("cancelled")
  })
})

describe("updatePlanDraft", () => {
  it("replaces steps and recomputes counts for a pending plan", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const newSteps = [...plan.steps]
    newSteps[0] = { ...newSteps[0], status: "completed" }
    const updated = await rt.updatePlanDraft(plan.id, { title: "Renamed", steps: newSteps })
    expect(updated?.title).toBe("Renamed")
    expect(updated?.completedSteps).toBe(1)
    const events = await listPlanEvents(plan.id)
    expect(events.map((e) => e.kind)).toContain("plan_updated")
  })

  it("is a no-op while executing", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    await getDb().agentPlans.update(plan.id, { status: "executing" })
    const res = await rt.updatePlanDraft(plan.id, { title: "nope" })
    expect(res?.title).toBe("Ship it")
  })
})

describe("setStepStatus", () => {
  it("writes one step's status and updates the cursor + counts", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const updated = await rt.setStepStatus(plan.id, plan.steps[0].id, "completed", {
      result: "done",
    })
    expect(updated?.completedSteps).toBe(1)
    expect(updated?.steps[0].result).toBe("done")
    expect(updated?.currentStepId).toBe(plan.steps[1].id)
  })

  it("is a no-op on terminal plans", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    expect((await rt.setStepStatus(plan.id, plan.steps[0].id, "completed"))?.status).toBe(
      "cancelled"
    )
  })
})

describe("deletePlan", () => {
  it("removes the plan and its events", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    await rt.deletePlan(plan.id)
    expect(await rt.getPlan(plan.id)).toBeUndefined()
    expect(await listPlanEvents(plan.id)).toHaveLength(0)
  })
})

describe("runPlan (orchestrated)", () => {
  it("drives an approved plan executing → completed and logs exit", async () => {
    runWorkflowMock.mockResolvedValue({ runId: "x", status: "succeeded", output: { done: true } })
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const result = await rt.runPlan(plan.id)
    expect(result).toMatchObject({ status: "completed", output: { done: true } })
    expect((await rt.getPlan(plan.id))?.status).toBe("completed")
    const kinds = (await listPlanEvents(plan.id)).map((e) => e.kind)
    expect(kinds).toContain("exit")
    // The synthesized workflow was handed to the orchestrator with a runId.
    expect(runWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.stringContaining("plan_run_") })
    )
  })

  it("marks the plan failed when the run does not succeed", async () => {
    runWorkflowMock.mockResolvedValue({
      runId: "x",
      status: "failed",
      error: { message: "step blew up" },
    })
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const result = await rt.runPlan(plan.id)
    expect(result?.status).toBe("failed")
    expect((await rt.getPlan(plan.id))?.status).toBe("failed")
  })

  it("fails terminally on a malformed (empty) plan without calling the orchestrator", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ steps: [], config: { requireApproval: false } }))
    await expect(rt.runPlan(plan.id)).rejects.toThrow()
    expect((await rt.getPlan(plan.id))?.status).toBe("failed")
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("returns null for a missing plan and the unchanged status for a terminal one", async () => {
    const rt = getPlanRuntime()
    expect(await rt.runPlan("ghost")).toBeNull()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    expect(await rt.runPlan(plan.id)).toMatchObject({ status: "cancelled" })
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("aborts the run when an external signal is already aborted", async () => {
    runWorkflowMock.mockImplementation(async (input: { signal?: AbortSignal }) => ({
      runId: "x",
      status: input.signal?.aborted ? "cancelled" : "succeeded",
      output: null,
    }))
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const ac = new AbortController()
    ac.abort()
    const result = await rt.runPlan(plan.id, { signal: ac.signal })
    expect(result?.status).toBe("failed") // cancelled run → not succeeded → failed
  })
})

describe("registerAbortController", () => {
  it("unregister clears only the matching controller (stale closure is a no-op)", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    await getDb().agentPlans.update(plan.id, { status: "executing" })

    const ac1 = new AbortController()
    const unregister1 = rt.registerAbortController(plan.id, ac1)
    // Replace with a second controller for the same plan.
    const ac2 = new AbortController()
    rt.registerAbortController(plan.id, ac2)
    // Stale unregister must NOT remove ac2 (its controller !== ac1).
    unregister1()
    await rt.pausePlan(plan.id)
    expect(ac2.signal.aborted).toBe(true) // ac2 still registered → fired

    // A matching unregister removes the controller so a later pause can't fire it.
    const ac3 = new AbortController()
    const unregister3 = rt.registerAbortController(plan.id, ac3)
    unregister3()
    await getDb().agentPlans.update(plan.id, { status: "executing" })
    await rt.pausePlan(plan.id)
    expect(ac3.signal.aborted).toBe(false)
  })
})

describe("emitPlanStatus (Tauri broadcast)", () => {
  it("emits plan://status when running under Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    const { emit } = jest.requireMock("@tauri-apps/api/event") as { emit: jest.Mock }
    emit.mockClear()

    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    await rt.approvePlan(plan.id)
    // emitPlanStatus is fire-and-forget; flush the dynamic import + emit.
    await new Promise((r) => setTimeout(r, 20))

    expect(emit).toHaveBeenCalledWith(
      "plan://status",
      expect.objectContaining({ planId: plan.id, sessionId: plan.sessionId, status: "approved" })
    )
  })

  it("does not emit when not under Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { emit } = jest.requireMock("@tauri-apps/api/event") as { emit: jest.Mock }
    emit.mockClear()

    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    await rt.approvePlan(plan.id)
    await new Promise((r) => setTimeout(r, 20))

    expect(emit).not.toHaveBeenCalled()
  })

  it("swallows a Tauri emit failure (best-effort broadcast)", async () => {
    isTauriMock.mockReturnValue(true)
    const { emit } = jest.requireMock("@tauri-apps/api/event") as { emit: jest.Mock }
    emit.mockClear()
    emit.mockRejectedValueOnce(new Error("transport down"))

    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    // Must not reject even though emit threw.
    await expect(rt.approvePlan(plan.id)).resolves.toMatchObject({ status: "approved" })
    await new Promise((r) => setTimeout(r, 20))
    expect(emit).toHaveBeenCalled()
  })
})

describe("pass-through readers", () => {
  it("getExecutingPlanForSession and listPlansBySession proxy the db", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    await getDb().agentPlans.update(plan.id, { status: "executing" })
    expect((await rt.getExecutingPlanForSession("ses_a"))?.id).toBe(plan.id)
    expect((await rt.getOpenPlanForSession("ses_a"))?.id).toBe(plan.id)
    expect((await rt.listPlansBySession("ses_a")).map((p) => p.id)).toContain(plan.id)
  })
})
