import { buildSpans } from "./run-timeline"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function ev(
  partial: Partial<WorkflowRunEventRow> & {
    runId: string
    type: WorkflowRunEventRow["type"]
    ts: number
  }
): WorkflowRunEventRow {
  return {
    id: partial.id ?? "evt_" + Math.random().toString(36).slice(2, 8),
    ...partial,
  }
}

describe("buildSpans", () => {
  it("creates one span per step using start/complete pairs", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_started", stepId: "n_a", ts: 100 }),
      ev({ runId: "r", type: "step_completed", stepId: "n_a", ts: 200 }),
      ev({ runId: "r", type: "step_started", stepId: "n_b", ts: 220 }),
      ev({ runId: "r", type: "step_completed", stepId: "n_b", ts: 350 }),
    ]
    const spans = buildSpans(events, 400)
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({
      stepId: "n_a",
      startTs: 100,
      endTs: 200,
      status: "succeeded",
      attemptCount: 1,
    })
    expect(spans[1]).toMatchObject({
      stepId: "n_b",
      startTs: 220,
      endTs: 350,
      status: "succeeded",
    })
  })

  it("marks step_failed spans as failed", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_started", stepId: "n", ts: 0 }),
      ev({ runId: "r", type: "step_failed", stepId: "n", ts: 50 }),
    ]
    const spans = buildSpans(events, 100)
    expect(spans[0].status).toBe("failed")
    expect(spans[0].endTs).toBe(50)
  })

  it("collapses retries into one span and bumps attempt count", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_started", stepId: "n", ts: 0 }),
      ev({ runId: "r", type: "step_failed", stepId: "n", ts: 30 }),
      ev({ runId: "r", type: "step_started", stepId: "n", ts: 40 }),
      ev({ runId: "r", type: "step_completed", stepId: "n", ts: 100 }),
    ]
    const spans = buildSpans(events, 200)
    expect(spans).toHaveLength(1)
    expect(spans[0].attemptCount).toBe(2)
    // The first span keeps its original startTs; status becomes succeeded.
    expect(spans[0].startTs).toBe(0)
    expect(spans[0].endTs).toBe(100)
    expect(spans[0].status).toBe("succeeded")
  })

  it("creates skipped spans without a prior start event", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_skipped", stepId: "n", ts: 12, payload: { reason: "branch" } }),
    ]
    const spans = buildSpans(events, 50)
    expect(spans).toHaveLength(1)
    expect(spans[0].status).toBe("skipped")
    expect(spans[0].startTs).toBe(12)
    expect(spans[0].endTs).toBe(12)
  })

  it("treats running spans (no terminal event yet) as ending at fallback", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_started", stepId: "n", ts: 0 }),
    ]
    const spans = buildSpans(events, 200)
    expect(spans[0].status).toBe("running")
    expect(spans[0].endTs).toBe(200)
  })

  it("ignores events without a stepId", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "run_started", ts: 0 }),
      ev({ runId: "r", type: "run_completed", ts: 100 }),
      ev({ runId: "r", type: "step_started", stepId: "n", ts: 10 }),
      ev({ runId: "r", type: "step_completed", stepId: "n", ts: 50 }),
    ]
    const spans = buildSpans(events, 100)
    expect(spans).toHaveLength(1)
    expect(spans[0].stepId).toBe("n")
  })

  it("orders spans by startTs", () => {
    const events: WorkflowRunEventRow[] = [
      ev({ runId: "r", type: "step_started", stepId: "z", ts: 50 }),
      ev({ runId: "r", type: "step_completed", stepId: "z", ts: 60 }),
      ev({ runId: "r", type: "step_started", stepId: "a", ts: 10 }),
      ev({ runId: "r", type: "step_completed", stepId: "a", ts: 20 }),
    ]
    expect(buildSpans(events, 100).map((s) => s.stepId)).toEqual(["a", "z"])
  })
})
