import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const runPlanMock = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ runPlan: runPlanMock }),
}))

const buildUtilityLlmClientMock = jest.fn(() => ({ id: "client" }))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => buildUtilityLlmClientMock(...args),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => null) }))

import { executePlanTask } from "./plan-executor"

function makeTask(payload: Record<string, unknown>): ScheduledTask {
  return {
    id: "task_1",
    name: "plan task",
    type: "plan",
    payload,
    config: { timeout: 300000 },
  } as unknown as ScheduledTask
}

const execution = { id: "exec_1" } as unknown as TaskExecution

beforeEach(() => {
  runPlanMock.mockReset()
  buildUtilityLlmClientMock.mockClear()
})

describe("executePlanTask", () => {
  it("rejects payloads missing planId", async () => {
    const r = await executePlanTask(makeTask({}), execution, new AbortController().signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/planId/)
  })

  it("rejects when already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await executePlanTask(makeTask({ planId: "p1" }), execution, ac.signal)
    expect(r.success).toBe(false)
    expect(runPlanMock).not.toHaveBeenCalled()
  })

  it("succeeds when the plan completes", async () => {
    runPlanMock.mockResolvedValue({ status: "completed", output: { ok: true } })
    const r = await executePlanTask(
      makeTask({ planId: "p1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ planId: "p1", status: "completed" })
    expect(runPlanMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it("fails when the plan does not complete", async () => {
    runPlanMock.mockResolvedValue({ status: "failed" })
    const r = await executePlanTask(
      makeTask({ planId: "p1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/failed/)
  })

  it("reports a missing/unrunnable plan", async () => {
    runPlanMock.mockResolvedValue(null)
    const r = await executePlanTask(
      makeTask({ planId: "ghost" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found/)
  })

  it("passes an LLM client when replanOnFailure is set", async () => {
    runPlanMock.mockResolvedValue({ status: "completed" })
    await executePlanTask(
      makeTask({ planId: "p1", replanOnFailure: true }),
      execution,
      new AbortController().signal
    )
    expect(buildUtilityLlmClientMock).toHaveBeenCalled()
    expect(runPlanMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ client: expect.anything() })
    )
  })

  it("surfaces a thrown error", async () => {
    runPlanMock.mockRejectedValue(new Error("boom"))
    const r = await executePlanTask(
      makeTask({ planId: "p1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
  })
})
