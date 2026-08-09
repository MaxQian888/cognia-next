const runWorkflowMock = jest.fn(async (..._args: unknown[]) => ({
  runId: "run_new",
  status: "succeeded" as const,
}))
jest.mock("./orchestrator", () => ({
  __esModule: true,
  runWorkflow: (...args: unknown[]) => runWorkflowMock(...args),
}))

import { getRunStepOutputs, runFromStep } from "./run-from-step"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRunEvents.clear()
  runWorkflowMock.mockClear()
})
afterAll(dbFixture.dispose)

const ev = (
  over: Partial<WorkflowRunEventRow> & { id: string; ts: number }
): WorkflowRunEventRow => ({
  runId: "run_prior",
  type: "step_completed",
  ...over,
})

const workflow: VisualWorkflow = {
  id: "wf_1",
  schemaVersion: 1,
  name: "wf",
  createdAt: 0,
  updatedAt: 0,
  nodes: [
    {
      id: "n_a",
      type: "trigger.manual",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "a", params: {} },
    },
    {
      id: "n_b",
      type: "flow.set",
      typeVersion: 1,
      position: { x: 200, y: 0 },
      data: { label: "b", params: {} },
    },
  ],
  edges: [{ id: "e1", source: "n_a", target: "n_b" }],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
  },
}

describe("getRunStepOutputs", () => {
  it("returns each step's completed output keyed by step id", async () => {
    await getDb().workflowRunEvents.bulkPut([
      ev({ id: "1", ts: 1, stepId: "n_a", payload: { output: { val: 42 } } }),
      ev({ id: "2", ts: 2, stepId: "n_b", payload: { output: "done" } }),
    ])
    const outputs = await getRunStepOutputs("run_prior")
    expect(outputs).toEqual({ n_a: { val: 42 }, n_b: "done" })
  })

  it("ignores non-completed events and events without an output payload", async () => {
    await getDb().workflowRunEvents.bulkPut([
      ev({ id: "1", ts: 1, type: "step_started", stepId: "n_a", payload: {} }),
      ev({ id: "2", ts: 2, type: "step_failed", stepId: "n_b", payload: { message: "boom" } }),
      ev({ id: "3", ts: 3, type: "step_completed", stepId: "n_a", payload: { output: 7 } }),
    ])
    const outputs = await getRunStepOutputs("run_prior")
    expect(outputs).toEqual({ n_a: 7 })
  })

  it("returns an empty map for a run with no events", async () => {
    expect(await getRunStepOutputs("run_absent")).toEqual({})
  })
})

describe("runFromStep", () => {
  it("re-runs from the step with the prior run's outputs seeded", async () => {
    await getDb().workflowRunEvents.bulkPut([
      ev({ id: "1", ts: 1, stepId: "n_a", payload: { output: { val: 42 } } }),
    ])

    const result = await runFromStep({
      workflow,
      startStepId: "n_b",
      seedFromRunId: "run_prior",
    })

    expect(result.status).toBe("succeeded")
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    const arg = runWorkflowMock.mock.calls[0][0] as Record<string, unknown>
    expect(arg).toEqual(
      expect.objectContaining({
        workflow,
        startStepId: "n_b",
        seedOutputs: { n_a: { val: 42 } },
      })
    )
    expect((arg.trigger as { kind: string }).kind).toBe("trigger.manual")
  })

  it("prefers injected seedOutputs over reading the event log", async () => {
    await runFromStep({
      workflow,
      startStepId: "n_b",
      seedFromRunId: "run_prior",
      seedOutputs: { n_a: "injected" },
    })
    const arg = runWorkflowMock.mock.calls[0][0] as Record<string, unknown>
    expect(arg.seedOutputs).toEqual({ n_a: "injected" })
  })

  it("seeds nothing when neither seedOutputs nor seedFromRunId is given", async () => {
    await runFromStep({ workflow, startStepId: "n_b" })
    const arg = runWorkflowMock.mock.calls[0][0] as Record<string, unknown>
    expect(arg.seedOutputs).toEqual({})
  })

  it("forwards a caller-supplied trigger verbatim", async () => {
    const trigger = {
      workflowId: "wf_1",
      kind: "trigger.cron" as const,
      payload: { tick: 1 },
      originAt: 123,
    }
    await runFromStep({ workflow, startStepId: "n_b", trigger })
    const arg = runWorkflowMock.mock.calls[0][0] as Record<string, unknown>
    expect(arg.trigger).toEqual(trigger)
  })
})
