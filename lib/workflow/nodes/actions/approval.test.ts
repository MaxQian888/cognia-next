/**
 * @jest-environment jsdom
 */
const mockNotifyRequested = jest.fn(async (..._a: unknown[]) => undefined)
const mockNotifyResolved = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/workflow/runtime/approval-notify", () => ({
  notifyApprovalRequested: (...a: unknown[]) => mockNotifyRequested(...a),
  notifyApprovalResolved: (...a: unknown[]) => mockNotifyResolved(...a),
}))

const mockListRunEvents = jest.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
const mockAppendEvent = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/workflow/runtime/event-log", () => ({
  listRunEvents: (...a: unknown[]) => mockListRunEvents(...a),
  appendEvent: (...a: unknown[]) => mockAppendEvent(...a),
}))

import { runApprovalRequest, APPROVAL_CHECKPOINT_KEY } from "./approval"
import {
  approvalId,
  getPendingApproval,
  respondToApproval,
  __resetApprovalRegistryForTesting,
} from "@/lib/workflow/runtime/approval-registry"
import { _clearWakeBusForTest } from "@/lib/workflow/runtime/wake-bus"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(
  params: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal
): StepExecutionContext {
  return {
    runId: "run_apr",
    workflowId: "wf_apr",
    stepId: "n_gate",
    params,
    upstream: {},
    trigger: { workflowId: "wf_apr", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  } as unknown as StepExecutionContext
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const id = approvalId("run_apr", "n_gate")

beforeEach(() => {
  jest.clearAllMocks()
  mockListRunEvents.mockResolvedValue([])
})

afterEach(() => {
  __resetApprovalRegistryForTesting()
  _clearWakeBusForTest()
})

describe("runApprovalRequest", () => {
  it("requires a title", async () => {
    await expect(runApprovalRequest(makeCtx({}))).rejects.toThrow(/title is required/)
  })

  it("notifies, waits, and routes an approval to the approved handle", async () => {
    const promise = runApprovalRequest(makeCtx({ title: "Ship it?", message: "v2.0" }))
    await flush()
    expect(mockNotifyRequested).toHaveBeenCalledTimes(1)
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "step.long_running.checkpoint",
        payload: expect.objectContaining({ checkpointKey: APPROVAL_CHECKPOINT_KEY }),
      })
    )
    expect(getPendingApproval(id)?.title).toBe("Ship it?")

    expect(respondToApproval(id, { decision: "approved", respondedBy: "device:dev-1" })).toEqual({
      ok: true,
    })
    const result = await promise
    expect(result.decision).toBe("approved")
    expect(result.output).toMatchObject({
      approvalId: id,
      decision: "approved",
      respondedBy: "device:dev-1",
    })
    // Registry cleaned up; resolution fanned out.
    expect(getPendingApproval(id)).toBeUndefined()
    expect(mockNotifyResolved).toHaveBeenCalledWith(expect.anything(), "approved")
  })

  it("routes a rejection to the rejected handle", async () => {
    const promise = runApprovalRequest(makeCtx({ title: "Ship it?" }))
    await flush()
    respondToApproval(id, { decision: "rejected", respondedBy: "desktop" })
    const result = await promise
    expect(result.decision).toBe("rejected")
  })

  it("times out as rejected by default", async () => {
    const promise = runApprovalRequest(makeCtx({ title: "Ship it?", timeoutMs: 1_000 }))
    await flush()
    // timeoutMs below the zod minimum is normalized by validation; the
    // executor honors whatever arrives. Advance past it.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const result = await promise
    expect(result.decision).toBe("rejected")
    expect(result.output).toMatchObject({ respondedBy: "timeout" })
    expect(getPendingApproval(id)).toBeUndefined()
  }, 10_000)

  it("times out as a failure when onTimeout is fail", async () => {
    const promise = runApprovalRequest(
      makeCtx({ title: "Ship it?", timeoutMs: 1_000, onTimeout: "fail" })
    )
    await expect(promise).rejects.toThrow(/no response within/)
  }, 10_000)

  it("rethrows on abort (run cancellation)", async () => {
    const ac = new AbortController()
    const promise = runApprovalRequest(makeCtx({ title: "Ship it?" }, ac.signal))
    await flush()
    ac.abort()
    await expect(promise).rejects.toThrow(/aborted/)
    expect(getPendingApproval(id)).toBeUndefined()
  })

  it("re-arms after resume without re-notifying and keeps the original budget", async () => {
    const requestedAt = Date.now() - 500
    mockListRunEvents.mockResolvedValue([
      {
        runId: "run_apr",
        stepId: "n_gate",
        type: "step.long_running.checkpoint",
        payload: {
          checkpointKey: APPROVAL_CHECKPOINT_KEY,
          state: { approvalId: id, requestedAt },
        },
      },
    ])
    const promise = runApprovalRequest(makeCtx({ title: "Ship it?" }))
    await flush()
    expect(mockNotifyRequested).not.toHaveBeenCalled()
    expect(mockAppendEvent).not.toHaveBeenCalled()
    expect(getPendingApproval(id)?.requestedAt).toBe(requestedAt)
    respondToApproval(id, { decision: "approved", respondedBy: "desktop" })
    await expect(promise).resolves.toMatchObject({ decision: "approved" })
  })

  it("resumes straight into the timeout outcome when the budget already expired", async () => {
    mockListRunEvents.mockResolvedValue([
      {
        runId: "run_apr",
        stepId: "n_gate",
        type: "step.long_running.checkpoint",
        payload: {
          checkpointKey: APPROVAL_CHECKPOINT_KEY,
          state: { approvalId: id, requestedAt: Date.now() - 7_200_000 },
        },
      },
    ])
    const result = await runApprovalRequest(makeCtx({ title: "Ship it?" }))
    expect(result.decision).toBe("rejected")
    expect(result.output).toMatchObject({ respondedBy: "timeout" })
  })
})
