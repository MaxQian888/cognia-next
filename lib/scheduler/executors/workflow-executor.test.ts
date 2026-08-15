import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const executeDeployedWorkflowMock = jest.fn()
jest.mock("@/lib/workflow/runtime/execution-authority", () => {
  class WorkflowAdmissionError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
      this.name = "WorkflowAdmissionError"
    }
  }
  return {
    executeDeployedWorkflow: (...a: unknown[]) => executeDeployedWorkflowMock(...a),
    WorkflowAdmissionError,
  }
})

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { scheduler: stub }, createLogger: () => stub }
})

import { executeWorkflowTask } from "./workflow-executor"
import { WorkflowAdmissionError } from "@/lib/workflow/runtime/execution-authority"

function makeTask(payload: unknown): ScheduledTask {
  return {
    id: "task-wf",
    name: "Nightly report",
    type: "workflow",
    trigger: { type: "cron", cronExpression: "0 2 * * *" },
    payload: payload as ScheduledTask["payload"],
    config: { maxRetries: 0, retryDelay: 1000, timeout: 60_000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeExecution(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "exec-wf",
    taskId: "task-wf",
    taskName: "Nightly report",
    taskType: "workflow",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date("2026-08-16T02:00:05Z"),
    scheduledFor: new Date("2026-08-16T02:00:00Z"),
    logs: [],
    ...overrides,
  }
}

const okResult = {
  invocationId: "wfi_1",
  runId: "run_1",
  reused: false,
  version: { id: "wfv_1" },
  executionBinding: {},
  result: { runId: "run_1", status: "succeeded", output: { rows: 3 } },
}

beforeEach(() => {
  executeDeployedWorkflowMock.mockReset().mockResolvedValue(okResult)
})

describe("executeWorkflowTask", () => {
  it("rejects payloads without a workflowId", async () => {
    for (const payload of [undefined, null, [], {}, { workflowId: "  " }]) {
      const r = await executeWorkflowTask(
        makeTask(payload),
        makeExecution(),
        new AbortController().signal
      )
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/workflowId/)
    }
    expect(executeDeployedWorkflowMock).not.toHaveBeenCalled()
  })

  it("returns early when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      controller.signal
    )
    expect(r).toEqual({ success: false, error: "Workflow task aborted before start" })
  })

  it("admits the run through executeDeployedWorkflow with schedule provenance", async () => {
    const signal = new AbortController().signal
    const r = await executeWorkflowTask(
      makeTask({ workflowId: " wf1 ", inputs: { a: 1 }, environment: " staging " }),
      makeExecution(),
      signal
    )
    expect(executeDeployedWorkflowMock).toHaveBeenCalledTimes(1)
    const input = executeDeployedWorkflowMock.mock.calls[0][0]
    expect(input).toMatchObject({
      workflowId: "wf1",
      environment: "staging",
      entrypoint: "schedule",
      caller: "scheduler:task:task-wf",
      idempotencyKey: "task-wf:exec-wf",
      triggerKind: "trigger.manual",
      triggerOriginAt: new Date("2026-08-16T02:00:00Z").getTime(),
      payload: { a: 1 },
      signal,
      triggeredBy: { source: "schedule" },
    })
    expect(input.triggerId).toBeUndefined()
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({
      runId: "run_1",
      invocationId: "wfi_1",
      status: "succeeded",
      versionId: "wfv_1",
      environment: "staging",
      result: { rows: 3 },
    })
  })

  it("enters through a cron trigger node when triggerId is set and honours idempotencyKey", async () => {
    await executeWorkflowTask(
      makeTask({ workflowId: "wf1", triggerId: "trig-9", idempotencyKey: "custom-key" }),
      makeExecution({ scheduledFor: undefined }),
      new AbortController().signal
    )
    const input = executeDeployedWorkflowMock.mock.calls[0][0]
    expect(input).toMatchObject({
      triggerKind: "trigger.cron",
      triggerId: "trig-9",
      idempotencyKey: "custom-key",
      payload: {},
      triggerOriginAt: new Date("2026-08-16T02:00:05Z").getTime(),
    })
  })

  it("maps a failed run status to a failed execution with the run error", async () => {
    executeDeployedWorkflowMock.mockResolvedValue({
      ...okResult,
      result: {
        runId: "run_2",
        status: "failed",
        error: { message: "step blew up", nodeId: "n1" },
      },
    })
    const r = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("step blew up")
    expect(r.output).toMatchObject({ status: "failed", error: { nodeId: "n1" } })
  })

  it("reports a cancelled run distinctly when the signal was aborted", async () => {
    const controller = new AbortController()
    executeDeployedWorkflowMock.mockImplementation(async () => {
      controller.abort()
      return { ...okResult, result: { runId: "run_3", status: "cancelled" } }
    })
    const r = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      controller.signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/cancelled/)
    executeDeployedWorkflowMock.mockResolvedValue({
      ...okResult,
      result: { runId: "run_4", status: "paused" },
    })
    const r2 = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r2.error).toMatch(/status "paused"/)
  })

  it("surfaces admission errors with their code and the admitted run id when present", async () => {
    executeDeployedWorkflowMock.mockImplementation(
      async (input: { onAdmitted?: (id: string) => void }) => {
        input.onAdmitted?.("run_adm")
        throw new WorkflowAdmissionError("deployment-not-found", "no active deployment")
      }
    )
    const r = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("deployment-not-found: no active deployment")
    expect(r.output).toMatchObject({
      workflowId: "wf1",
      runId: "run_adm",
      admissionCode: "deployment-not-found",
    })
  })

  it("surfaces unexpected errors", async () => {
    executeDeployedWorkflowMock.mockRejectedValue(new Error("db down"))
    const r = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r).toMatchObject({ success: false, error: "db down", output: { workflowId: "wf1" } })
    executeDeployedWorkflowMock.mockRejectedValue("weird")
    const r2 = await executeWorkflowTask(
      makeTask({ workflowId: "wf1" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r2.error).toBe("weird")
  })
})
