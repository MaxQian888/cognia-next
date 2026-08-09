import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
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

// The terminal transition emits a `plan:completed` scheduler event. Left real,
// `getTaskScheduler()` opens the scheduler's own Dexie database and leaves work
// outstanding in fake-indexeddb, and the NEXT test's `getDb().delete()` then
// never resolves — the whole suite hangs. Mocked here for the same reason
// `lib/execution/event-bridge.test.ts` mocks it: the scheduler linkage is
// `./notify`'s contract (covered in `notify.test.ts`), not the runtime's.
const emitSchedulerEventMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...a: unknown[]) => emitSchedulerEventMock(...a),
}))

// Mock the workflow orchestrator so `runPlan` exercises its own
// transition/synthesis/context logic without actually executing step nodes.
const runWorkflowMock = jest.fn()
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
}))

const isTauriMock = detect.isTauri as jest.Mock

// 30s: the first cold Dexie open (full schema migration chain) can exceed the
// 5s default on slower disks — same bump as the other cold-Dexie suites.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetPlanRuntimeForTesting()
  isTauriMock.mockReturnValue(false)
  runWorkflowMock.mockReset()
}, 30_000)

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

afterAll(dbFixture.dispose)

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

  it("keepPlanning defers awaiting_approval → draft, keeps the plan, logs deferred", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const deferred = await rt.keepPlanning(plan.id, "cover mobile too")
    expect(deferred?.status).toBe("draft")
    // Non-destructive: still the session's open plan (not cancelled).
    expect((await rt.getOpenPlanForSession("ses_a"))?.id).toBe(plan.id)
    const ev = (await listPlanEvents(plan.id)).find((e) => e.kind === "deferred")
    expect(ev?.payload).toMatchObject({ kind: "deferred", feedback: "cover mobile too" })
    // A fresh ExitPlanMode capture replaces the lingering draft.
    const next = await rt.createPlan(createInput({ title: "Round two" }))
    expect((await rt.getPlan(plan.id))?.status).toBe("cancelled")
    expect((await rt.getOpenPlanForSession("ses_a"))?.id).toBe(next.id)
  })

  it("keepPlanning is a no-op outside awaiting_approval", async () => {
    const rt = getPlanRuntime()
    expect(await rt.keepPlanning("ghost")).toBeNull()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    // Approved (not awaiting) — unchanged.
    expect((await rt.keepPlanning(plan.id))?.status).toBe("approved")
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

  // Every mutator is addressed by planId, and a plan can be deleted (or its
  // session wiped) between a UI read and the click that follows. All of them
  // must answer `null` rather than throw or write a row back into existence.
  it("every mutator answers null for a plan id that no longer exists", async () => {
    const rt = getPlanRuntime()
    expect(await rt.updatePlanDraft("ghost", { title: "x" })).toBeNull()
    expect(await rt.rejectPlan("ghost")).toBeNull()
    expect(await rt.resumePlan("ghost")).toBeNull()
    expect(await rt.cancelPlan("ghost")).toBeNull()
    expect(await rt.setStepStatus("ghost", "s0", "completed")).toBeNull()
    expect(await rt.keepPlanning("ghost")).toBeNull()
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

  it("forwards a live external abort into the run's own controller", async () => {
    // The signal is NOT aborted at call time, so the runtime must subscribe to
    // it — the path a user pressing stop mid-run actually takes.
    const external = new AbortController()
    runWorkflowMock.mockImplementation(async (input: { signal?: AbortSignal }) => {
      external.abort()
      return { runId: "x", status: input.signal?.aborted ? "cancelled" : "succeeded", output: null }
    })
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    await rt.runPlan(plan.id, { signal: external.signal })
    const forwarded = runWorkflowMock.mock.calls[0][0] as { signal: AbortSignal }
    expect(forwarded.signal.aborted).toBe(true)
  })

  it("exposes a step writer that the orchestrator's nodes persist through", async () => {
    // The run context is how `action.plan.step.dispatch` nodes report progress;
    // with the orchestrator mocked, drive that writer directly.
    const { getPlanRunContext } = await import("./plan-run-context")
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    runWorkflowMock.mockImplementation(async (input: { runId: string }) => {
      const ctx = getPlanRunContext(input.runId)
      await ctx?.writer.setStepStatus(plan.steps[0].id, "completed", { result: "done" })
      return { runId: input.runId, status: "succeeded", output: null }
    })
    await rt.runPlan(plan.id)
    const row = await rt.getPlan(plan.id)
    expect(row?.steps[0]).toMatchObject({ status: "completed", result: "done" })
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

describe("startPlan (in-session)", () => {
  it("flips the plan executing, starts step 1, and hands back its turn text", async () => {
    const rt = getPlanRuntime()
    // The default fixture is a linear agent_turn chain from `manual`, which the
    // strategy resolver routes to the in-session driver.
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const started = await rt.startPlan(plan.id)

    expect(started).toMatchObject({ strategy: "in_session", status: "executing" })
    expect(started?.userMessage).toContain("Step 1 of 2")
    const row = await rt.getPlan(plan.id)
    expect(row?.status).toBe("executing")
    expect(row?.currentStepId).toBe(started?.stepId)
    expect(row?.steps.find((s) => s.id === started?.stepId)?.status).toBe("in_progress")
    // The orchestrator must NOT have been involved — that is the whole point of
    // routing: one executor per plan, never both.
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("refuses an orchestrated plan instead of driving it one turn at a time", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(
      createInput({ executionMode: "orchestrated", config: { requireApproval: false } })
    )
    const started = await rt.startPlan(plan.id)

    expect(started).toEqual({ strategy: "orchestrated", status: "approved" })
    // Untouched: the caller is expected to fall back to `runPlan`.
    expect((await rt.getPlan(plan.id))?.status).toBe("approved")
  })

  it("finishes immediately when no step is runnable", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    for (const step of plan.steps) await rt.setStepStatus(plan.id, step.id, "completed")

    expect(await rt.startPlan(plan.id)).toEqual({ strategy: "in_session", status: "completed" })
    expect((await rt.getPlan(plan.id))?.status).toBe("completed")
  })

  it("returns null for a missing plan and the unchanged status for a terminal one", async () => {
    const rt = getPlanRuntime()
    expect(await rt.startPlan("ghost")).toBeNull()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    expect(await rt.startPlan(plan.id)).toMatchObject({ status: "cancelled" })
  })
})

describe("finishPlanRun", () => {
  it("does not overwrite a user pause that landed while the run was ending", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    await rt.startPlan(plan.id)
    await rt.pausePlan(plan.id)

    await rt.finishPlanRun(plan.id, "completed", "run settled")
    // Paused is a user decision — a late terminal transition must not erase it.
    expect((await rt.getPlan(plan.id))?.status).toBe("paused")
  })

  it("is a no-op on a missing or already-terminal plan", async () => {
    const rt = getPlanRuntime()
    await expect(rt.finishPlanRun("ghost", "completed")).resolves.toBeUndefined()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    await rt.finishPlanRun(plan.id, "completed")
    expect((await rt.getPlan(plan.id))?.status).toBe("cancelled")
  })
})

function fakeClient(reply: string): { complete: jest.Mock } {
  return { complete: jest.fn(async () => reply) }
}

describe("refinePlan", () => {
  it("manual refine replaces steps, returns to awaiting_approval, logs events", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const client = fakeClient('{"steps":["new a","new b","new c"],"reasoning":"clearer"}')
    const refined = await rt.refinePlan(
      { planId: plan.id, refinementType: "optimize", trigger: "manual" },
      client as never
    )
    expect(refined?.status).toBe("awaiting_approval")
    expect(refined?.steps.map((s) => s.title)).toEqual(["new a", "new b", "new c"])
    expect(refined?.refinementCount).toBe(1)
    const kinds = (await listPlanEvents(plan.id)).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(["refined", "replanned"]))
  })

  it("auto triggers respect maxAutoRefinements (no LLM call past the cap)", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { maxAutoRefinements: 0 } }))
    const client = fakeClient('{"steps":["x"]}')
    const res = await rt.refinePlan(
      { planId: plan.id, refinementType: "repair", trigger: "step_failure" },
      client as never
    )
    expect(client.complete).not.toHaveBeenCalled()
    expect(res?.refinementCount).toBe(0)
  })

  it("manual is allowed even when the auto budget is exhausted", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { maxAutoRefinements: 0 } }))
    const client = fakeClient('{"steps":["y"]}')
    const res = await rt.refinePlan(
      { planId: plan.id, refinementType: "expand", trigger: "manual" },
      client as never
    )
    expect(res?.refinementCount).toBe(1)
  })

  it("fails OPEN (keeps the plan) when the planner returns unusable output", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput())
    const res = await rt.refinePlan(
      { planId: plan.id, refinementType: "repair", trigger: "manual" },
      fakeClient("not json") as never
    )
    expect(res?.refinementCount).toBe(0)
    expect(res?.steps).toHaveLength(2) // unchanged
  })

  it("blocks the planner call when the plan carries PII, keeping the plan", async () => {
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(
      createInput({ steps: [{ title: "email leak@example.com the report", kind: "agent_turn" }] })
    )
    const client = fakeClient('{"steps":["a","b"]}')
    const res = await rt.refinePlan(
      { planId: plan.id, refinementType: "repair", trigger: "manual" },
      client as never
    )
    // Fail-OPEN on the flow: the plan survives untouched, only the send is skipped.
    expect(client.complete).not.toHaveBeenCalled()
    expect(res?.refinementCount).toBe(0)
    expect(res?.steps).toHaveLength(1)
    expect(res?.status).toBe("awaiting_approval")
  })

  it("is a no-op on cancelled/missing plans", async () => {
    const rt = getPlanRuntime()
    expect(
      await rt.refinePlan(
        { planId: "ghost", refinementType: "repair", trigger: "manual" },
        fakeClient("{}") as never
      )
    ).toBeNull()
    const plan = await rt.createPlan(createInput())
    await rt.cancelPlan(plan.id)
    const res = await rt.refinePlan(
      { planId: plan.id, refinementType: "repair", trigger: "manual" },
      fakeClient('{"steps":["z"]}') as never
    )
    expect(res?.status).toBe("cancelled")
  })

  it("runPlan auto-replans on failure when a client is supplied", async () => {
    runWorkflowMock.mockResolvedValue({
      runId: "x",
      status: "failed",
      error: { message: "boom", nodeId: "stepX" },
    })
    const rt = getPlanRuntime()
    const plan = await rt.createPlan(createInput({ config: { requireApproval: false } }))
    const client = fakeClient('{"steps":["recover step"],"reasoning":"route around"}')
    await rt.runPlan(plan.id, { client: client as never })
    // Fire-and-forget refine — allow the microtask chain to settle.
    await new Promise((r) => setTimeout(r, 20))
    const after = await rt.getPlan(plan.id)
    expect(after?.refinementCount).toBe(1)
    expect(after?.status).toBe("awaiting_approval")
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
