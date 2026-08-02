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
