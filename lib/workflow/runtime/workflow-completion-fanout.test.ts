import type { TriggerEvent } from "@/types/workflow/visual"
import {
  chainDepthOf,
  emitWorkflowCompletedFanout,
  MAX_WORKFLOW_CHAIN_DEPTH,
} from "./workflow-completion-fanout"

const mockFindMatching = jest.fn()
jest.mock("./trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => mockFindMatching(...args),
}))

const mockDispatchTrigger = jest.fn()
jest.mock("./trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => mockDispatchTrigger(...args),
}))

function manualTrigger(): TriggerEvent {
  return {
    workflowId: "wf_a",
    kind: "trigger.manual",
    payload: {},
    originAt: 0,
  }
}

function chainedTrigger(chainDepth: number): TriggerEvent {
  return {
    workflowId: "wf_a",
    kind: "trigger.workflow.completed",
    payload: { workflowId: "wf_prev", runId: "r_prev", status: "succeeded", chainDepth },
    originAt: 0,
  }
}

beforeEach(() => {
  mockFindMatching.mockReset().mockReturnValue([])
  mockDispatchTrigger.mockReset().mockResolvedValue(undefined)
})

describe("chainDepthOf", () => {
  it("returns 0 for organic (non-chained) triggers", () => {
    expect(chainDepthOf(manualTrigger())).toBe(0)
  })

  it("reads the depth off a chained trigger payload", () => {
    expect(chainDepthOf(chainedTrigger(3))).toBe(3)
  })

  it("collapses garbage depths to 0", () => {
    const t = chainedTrigger(0)
    ;(t.payload as { chainDepth: unknown }).chainDepth = "nope"
    expect(chainDepthOf(t)).toBe(0)
    ;(t.payload as { chainDepth: unknown }).chainDepth = -5
    expect(chainDepthOf(t)).toBe(0)
  })
})

describe("emitWorkflowCompletedFanout", () => {
  const base = {
    workflow: { id: "wf_a", name: "A" },
    runId: "run_1",
    status: "succeeded" as const,
    output: { summary: "done" },
    trigger: manualTrigger(),
  }

  it("dispatches each matching workflow with the typed payload at depth 1", async () => {
    mockFindMatching.mockReturnValue([
      { workflowId: "wf_b", nodeId: "n1", params: {} },
      { workflowId: "wf_c", nodeId: "n2", params: {} },
    ])

    await emitWorkflowCompletedFanout(base)

    expect(mockFindMatching).toHaveBeenCalledWith("trigger.workflow.completed", {
      sourceWorkflowId: "wf_a",
      status: "succeeded",
    })
    expect(mockDispatchTrigger).toHaveBeenCalledTimes(2)
    const [event] = mockDispatchTrigger.mock.calls[0]
    expect(event).toMatchObject({
      workflowId: "wf_b",
      kind: "trigger.workflow.completed",
      triggerId: "n1",
      payload: {
        workflowId: "wf_a",
        workflowName: "A",
        runId: "run_1",
        status: "succeeded",
        output: { summary: "done" },
        chainDepth: 1,
      },
    })
  })

  it("carries the error envelope for failed runs", async () => {
    mockFindMatching.mockReturnValue([{ workflowId: "wf_b", nodeId: "n1", params: {} }])

    await emitWorkflowCompletedFanout({
      ...base,
      status: "failed",
      output: undefined,
      error: { message: "boom", nodeId: "n9" },
    })

    const [event] = mockDispatchTrigger.mock.calls[0]
    expect(event.payload).toMatchObject({
      status: "failed",
      error: { message: "boom", nodeId: "n9" },
    })
    expect("output" in event.payload).toBe(false)
  })

  it("increments the inherited chain depth", async () => {
    mockFindMatching.mockReturnValue([{ workflowId: "wf_b", nodeId: "n1", params: {} }])

    await emitWorkflowCompletedFanout({ ...base, trigger: chainedTrigger(2) })

    const [event] = mockDispatchTrigger.mock.calls[0]
    expect(event.payload.chainDepth).toBe(3)
  })

  it("stops fanning out past the chain depth cap", async () => {
    mockFindMatching.mockReturnValue([{ workflowId: "wf_b", nodeId: "n1", params: {} }])

    await emitWorkflowCompletedFanout({
      ...base,
      trigger: chainedTrigger(MAX_WORKFLOW_CHAIN_DEPTH),
    })

    expect(mockFindMatching).not.toHaveBeenCalled()
    expect(mockDispatchTrigger).not.toHaveBeenCalled()
  })

  it("rejects a self-trigger match even when the node's filter is unscoped", async () => {
    mockFindMatching.mockReturnValue([
      { workflowId: "wf_a", nodeId: "n_self", params: {} },
      { workflowId: "wf_b", nodeId: "n1", params: {} },
    ])

    await emitWorkflowCompletedFanout(base)

    expect(mockDispatchTrigger).toHaveBeenCalledTimes(1)
    expect(mockDispatchTrigger.mock.calls[0][0].workflowId).toBe("wf_b")
  })

  it("isolates per-match dispatch failures", async () => {
    mockFindMatching.mockReturnValue([
      { workflowId: "wf_b", nodeId: "n1", params: {} },
      { workflowId: "wf_c", nodeId: "n2", params: {} },
    ])
    mockDispatchTrigger
      .mockRejectedValueOnce(new Error("target exploded"))
      .mockResolvedValueOnce(undefined)

    await expect(emitWorkflowCompletedFanout(base)).resolves.toBeUndefined()
    expect(mockDispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("never throws when the runtime is unavailable", async () => {
    mockFindMatching.mockImplementation(() => {
      throw new Error("no runtime")
    })
    await expect(emitWorkflowCompletedFanout(base)).resolves.toBeUndefined()
  })
})
