// Partial mock of the platform leaf so `isTauri` is controllable while the rest
// keeps its real implementation (same seam as runtime.test.ts — the SWC-compiled
// `export function` is non-configurable, so `spyOn` cannot redefine it).
jest.mock("@/lib/platform/detect", () => {
  const actual = jest.requireActual("@/lib/platform/detect")
  return { ...actual, isTauri: jest.fn(() => false) }
})

const emit = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emit(...a) }), {
  virtual: true,
})

const emitSchedulerEvent = jest.fn()
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...a: unknown[]) => emitSchedulerEvent(...a),
}))

import * as detect from "@/lib/platform/detect"
import { emitPlanCompletedSchedulerEvent, emitPlanStatus } from "./notify"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

const isTauriMock = detect.isTauri as jest.Mock

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses_a",
    title: "Ship",
    source: "manual",
    executionMode: "auto",
    steps: [],
    status: "executing",
    totalSteps: 0,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  emit.mockResolvedValue(undefined)
  emitSchedulerEvent.mockResolvedValue(undefined)
  isTauriMock.mockReturnValue(true)
})

describe("emitPlanStatus", () => {
  it("broadcasts a compact snapshot under Tauri", async () => {
    await emitPlanStatus(plan({ status: "completed" }))
    expect(emit).toHaveBeenCalledWith("plan://status", {
      planId: "p1",
      sessionId: "ses_a",
      status: "completed",
    })
  })

  it("is a no-op off Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    await emitPlanStatus(plan())
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([null, undefined])("is a no-op for %s", async (value) => {
    await emitPlanStatus(value)
    expect(emit).not.toHaveBeenCalled()
  })

  it("swallows a transport failure", async () => {
    emit.mockRejectedValue(new Error("no bridge"))
    await expect(emitPlanStatus(plan())).resolves.toBeUndefined()
  })
})

describe("emitPlanCompletedSchedulerEvent", () => {
  it("emits plan:completed with the terminal status", async () => {
    await emitPlanCompletedSchedulerEvent("p1", "failed")
    expect(emitSchedulerEvent).toHaveBeenCalledWith(
      "plan:completed",
      { planId: "p1", status: "failed" },
      "plan"
    )
  })

  it("swallows a scheduler failure", async () => {
    emitSchedulerEvent.mockRejectedValue(new Error("no scheduler"))
    await expect(emitPlanCompletedSchedulerEvent("p1", "completed")).resolves.toBeUndefined()
  })
})

// ADR-0045 §5 promised a notification fan-out; before this the plan subsystem
// was the only decompose-and-drive engine with no notification-center row, so
// a plan waiting for approval was invisible unless its chat was open.
describe("notification center fan-out", () => {
  const notify = jest.fn()
  const approvePlan = jest.fn()
  const rejectPlan = jest.fn()
  const startPlan = jest.fn()
  const runPlan = jest.fn()

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    notify.mockResolvedValue("n1")
    startPlan.mockResolvedValue({ strategy: "in_session", status: "executing" })
    jest.doMock("@/lib/notifications/runtime", () => ({ notify }))
    jest.doMock("./runtime", () => ({
      getPlanRuntime: () => ({ approvePlan, rejectPlan, startPlan, runPlan }),
    }))
  })

  const plan = (over: Record<string, unknown> = {}) =>
    ({
      id: "p1",
      sessionId: "ses",
      title: "Ship v2",
      source: "planner_llm",
      status: "awaiting_approval",
      totalSteps: 3,
      completedSteps: 0,
      ...over,
    }) as never

  it("posts a directed row with both decisions when a plan needs approval", async () => {
    const { notifyPlanAwaitingApproval, PLAN_RESPOND_COMMAND } = await import("./notify")
    await notifyPlanAwaitingApproval(plan())
    expect(notify).toHaveBeenCalledTimes(1)
    const input = notify.mock.calls[0][0]
    expect(input).toMatchObject({ directed: true, dedupeKey: "plan-approval:p1" })
    expect(input.actions.map((a: { command: string }) => a.command)).toEqual([
      PLAN_RESPOND_COMMAND,
      PLAN_RESPOND_COMMAND,
    ])
  })

  it("stays silent for a plan that did not stop for approval", async () => {
    const { notifyPlanAwaitingApproval } = await import("./notify")
    await notifyPlanAwaitingApproval(plan({ status: "approved" }))
    expect(notify).not.toHaveBeenCalled()
  })

  it("posts an ambient row on a terminal status only", async () => {
    const { notifyPlanTerminal } = await import("./notify")
    await notifyPlanTerminal(plan({ status: "completed", completedSteps: 3 }), "completed")
    expect(notify.mock.calls[0][0]).toMatchObject({ level: "success", dedupeKey: "plan-exit:p1" })
    // Ambient, not directed: a finished plan is progress, not a request.
    expect(notify.mock.calls[0][0].directed).toBeUndefined()
    notify.mockClear()
    await notifyPlanTerminal(plan({ status: "executing" }), "executing")
    expect(notify).not.toHaveBeenCalled()
  })

  it("never lets a center failure surface as a plan failure", async () => {
    notify.mockRejectedValue(new Error("center down"))
    const { notifyPlanAwaitingApproval, notifyPlanTerminal } = await import("./notify")
    await expect(notifyPlanAwaitingApproval(plan())).resolves.toBeUndefined()
    await expect(notifyPlanTerminal(plan(), "failed")).resolves.toBeUndefined()
  })

  it("wires the Approve / Discard actions to the plan runtime", async () => {
    const registered: Record<string, (ctx: { args?: Record<string, unknown> }) => Promise<void>> =
      {}
    jest.doMock("@/lib/notifications/action-registry", () => ({
      registerNotificationCommand: (id: string, fn: (typeof registered)[string]) => {
        registered[id] = fn
        return () => delete registered[id]
      },
    }))
    const { installPlanNotificationActions, PLAN_RESPOND_COMMAND } = await import("./notify")
    const dispose = installPlanNotificationActions()

    await registered[PLAN_RESPOND_COMMAND]({ args: { planId: "p1", decision: "approve" } })
    expect(approvePlan).toHaveBeenCalledWith("p1")
    expect(runPlan).not.toHaveBeenCalled()

    startPlan.mockResolvedValueOnce({ strategy: "orchestrated", status: "approved" })
    await registered[PLAN_RESPOND_COMMAND]({ args: { planId: "p1", decision: "approve" } })
    expect(runPlan).toHaveBeenCalledWith("p1")

    await registered[PLAN_RESPOND_COMMAND]({ args: { planId: "p1", decision: "reject" } })
    expect(rejectPlan).toHaveBeenCalledWith("p1")

    // Malformed args must not reach the runtime.
    await registered[PLAN_RESPOND_COMMAND]({ args: { planId: 7, decision: "approve" } })
    await registered[PLAN_RESPOND_COMMAND]({ args: { planId: "p1", decision: "maybe" } })
    expect(approvePlan).toHaveBeenCalledTimes(2)
    dispose()
  })
})
