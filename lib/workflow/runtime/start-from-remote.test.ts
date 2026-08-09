import { startWorkflowFromRemote } from "./start-from-remote"
const executeDeployedWorkflow = jest.fn()
jest.mock("./execution-authority", () => {
  class WorkflowAdmissionError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    WorkflowAdmissionError,
    executeDeployedWorkflow: (...args: unknown[]) => executeDeployedWorkflow(...args),
  }
})

import { WorkflowAdmissionError } from "./execution-authority"

describe("startWorkflowFromRemote", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    executeDeployedWorkflow.mockImplementation(
      async (input: { onAdmitted?: (id: string) => void }) => {
        input.onAdmitted?.("run_generated")
        return {
          invocationId: "wfi_1",
          runId: "run_generated",
          reused: false,
          result: { runId: "run_generated", status: "succeeded" },
        }
      }
    )
  })

  it("returns not-found when the workflow has no deployment", async () => {
    executeDeployedWorkflow.mockRejectedValueOnce(
      new WorkflowAdmissionError("deployment-not-found", "not deployed")
    )
    const result = await startWorkflowFromRemote({ workflowId: "wf_x", runParams: {} })
    expect(result).toEqual({ ok: false, reason: "workflow-not-found", workflowId: "wf_x" })
  })

  it("routes through the authority with source api", async () => {
    const result = await startWorkflowFromRemote({ workflowId: "wf_1", runParams: { a: 1 } })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected admitted run")
    expect(result.runId).toMatch(/^run_/)
    expect(executeDeployedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf_1",
        entrypoint: "http",
        caller: "remote-control",
        triggerKind: "trigger.manual",
        payload: { a: 1 },
        triggeredBy: { source: "api" },
        requestedRunId: result.runId,
      })
    )
  })

  it("stamps the caller deviceId into provenance", async () => {
    await startWorkflowFromRemote({ workflowId: "wf_1", deviceId: "dev-42" })
    expect(executeDeployedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: "device:dev-42",
        triggeredBy: { source: "api", deviceId: "dev-42" },
      })
    )
  })

  it("honors a server-supplied run id and uses it as the idempotency key", async () => {
    executeDeployedWorkflow.mockImplementationOnce(
      async (input: { onAdmitted?: (id: string) => void }) => {
        input.onAdmitted?.("run_fixed")
        return {
          invocationId: "wfi_1",
          runId: "run_fixed",
          reused: false,
          result: { runId: "run_fixed", status: "succeeded" },
        }
      }
    )
    const result = await startWorkflowFromRemote({ workflowId: "wf_1", runId: "run_fixed" })
    expect(result).toEqual({ ok: true, runId: "run_fixed" })
    expect(executeDeployedWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ requestedRunId: "run_fixed", idempotencyKey: "run_fixed" })
    )
  })
})
