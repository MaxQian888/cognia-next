import { buildInitialSteps, foldRunEvents, stepStatusIcon } from "./workflow-run-fold"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

const nodes = [
  { id: "a", type: "trigger.manual", data: { label: "Start", params: {} } },
  { id: "b", type: "http.request", data: { label: "Fetch", params: {} } },
  { id: "c", type: "ai.generate", data: { label: "Generate", params: {} } },
] as never

function evt(
  p: Partial<WorkflowRunEventRow> & { type: WorkflowRunEventRow["type"]; ts: number }
): WorkflowRunEventRow {
  return { id: "e" + p.ts, runId: "r1", ...p } as WorkflowRunEventRow
}

describe("buildInitialSteps", () => {
  it("maps nodes to pending steps in declaration order using data.label", () => {
    const steps = buildInitialSteps(nodes)
    expect(steps.map((s) => [s.id, s.label, s.status])).toEqual([
      ["a", "Start", "pending"],
      ["b", "Fetch", "pending"],
      ["c", "Generate", "pending"],
    ])
  })

  it("falls back to the node id when label is blank", () => {
    const steps = buildInitialSteps([
      { id: "x", type: "noop", data: { label: "", params: {} } },
    ] as never)
    expect(steps[0].label).toBe("x")
  })
})

describe("foldRunEvents", () => {
  it("transitions started → succeeded with a duration from ts deltas", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "a", ts: 100 }),
      evt({ type: "step_completed", stepId: "a", ts: 250 }),
      evt({ type: "step_started", stepId: "b", ts: 300 }),
    ])
    expect(out.steps[0]).toMatchObject({ status: "succeeded", durationMs: 150 })
    expect(out.steps[1]).toMatchObject({ status: "running", startedAt: 300 })
    expect(out.completed).toBe(1)
    expect(out.currentId).toBe("b")
  })

  it("marks failures with the error message and counts them as completed", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "c", ts: 10 }),
      evt({ type: "step_failed", stepId: "c", ts: 40, payload: { message: "rate limited" } }),
    ])
    expect(out.steps[2]).toMatchObject({ status: "failed", durationMs: 30, error: "rate limited" })
    expect(out.completed).toBe(1)
    expect(out.currentId).toBeUndefined()
  })

  it("marks skipped steps and ignores unknown event types", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_skipped", stepId: "b", ts: 5 }),
      evt({ type: "step_stream", stepId: "c", ts: 6, payload: { delta: "x", seq: 1 } }),
    ])
    expect(out.steps[1].status).toBe("skipped")
    expect(out.completed).toBe(1)
  })

  it("on run_failed marks the still-running step failed", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "c", ts: 1 }),
      evt({ type: "run_failed", ts: 2, payload: { message: "boom", nodeId: "c" } }),
    ])
    expect(out.steps[2]).toMatchObject({ status: "failed", error: "boom" })
  })

  it("on run_failed without nodeId falls back to the running step", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "b", ts: 1 }),
      evt({ type: "run_failed", ts: 2, payload: { message: "boom" } }),
    ])
    expect(out.steps[1]).toMatchObject({ status: "failed", error: "boom" })
  })

  it("ignores step events whose stepId is not in the graph", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [evt({ type: "step_started", stepId: "ghost", ts: 1 })])
    expect(out.completed).toBe(0)
    expect(out.currentId).toBeUndefined()
  })
})

describe("stepStatusIcon", () => {
  it("returns a distinct glyph per status", () => {
    expect(stepStatusIcon("pending")).toBe("·")
    expect(stepStatusIcon("running")).toBe("⏳")
    expect(stepStatusIcon("succeeded")).toBe("✓")
    expect(stepStatusIcon("failed")).toBe("✗")
    expect(stepStatusIcon("skipped")).toBe("⊘")
  })
})
