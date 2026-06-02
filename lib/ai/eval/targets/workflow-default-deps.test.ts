jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(async (id: string) => ({ id, nodes: [], edges: [] })),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: jest.fn(async () => ({
    runId: "wfrun_1",
    status: "succeeded",
    output: { ok: true },
  })),
}))
jest.mock("@/lib/db/agent-traces", () => ({ queryByTrace: jest.fn(async () => []) }))

import { defaultWorkflowTargetDeps } from "./workflow-default-deps"
import { getWorkflow } from "@/lib/db/workflows"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { queryByTrace } from "@/lib/db/agent-traces"

const mockGetWorkflow = getWorkflow as jest.Mock
const mockRunWorkflow = runWorkflow as jest.Mock
const mockQueryByTrace = queryByTrace as jest.Mock

describe("defaultWorkflowTargetDeps.runWorkflow", () => {
  it("loads the workflow, runs it with a manual trigger + threaded trace id", async () => {
    const deps = defaultWorkflowTargetDeps()
    const out = await deps.runWorkflow({
      workflowId: "wf1",
      payload: { input: "go" },
      traceId: "tr",
    })
    expect(out.runId).toBe("wfrun_1")
    expect(out.status).toBe("succeeded")
    expect(out.output).toEqual({ ok: true })
    expect(out.traceId).toBe("tr")
    const passed = mockRunWorkflow.mock.calls[0][0] as {
      traceId: string
      trigger: { kind: string; payload: unknown }
    }
    expect(passed.traceId).toBe("tr")
    expect(passed.trigger.kind).toBe("trigger.manual")
    expect(passed.trigger.payload).toEqual({ input: "go" })
  })

  it("throws on a missing workflow", async () => {
    mockGetWorkflow.mockResolvedValueOnce(undefined as never)
    const deps = defaultWorkflowTargetDeps()
    await expect(
      deps.runWorkflow({ workflowId: "nope", payload: {}, traceId: "tr" })
    ).rejects.toThrow(/not found/)
  })

  it("delegates fetchSpansByTrace to queryByTrace", async () => {
    const deps = defaultWorkflowTargetDeps()
    await deps.fetchSpansByTrace("tr")
    expect(mockQueryByTrace).toHaveBeenCalledWith("tr")
  })
})
