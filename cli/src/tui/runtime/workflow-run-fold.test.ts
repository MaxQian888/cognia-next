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

  it("tags each step with its node category", () => {
    const steps = buildInitialSteps(nodes)
    expect(steps.map((s) => s.category)).toEqual(["trigger", "annotation", "ai"])
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

  it("aggregates step_usage into run-level tokens + cost", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({
        type: "step_usage",
        stepId: "b",
        ts: 1,
        payload: { totalTokens: 1200, costUsd: 0.002 },
      }),
      evt({
        type: "step_usage",
        stepId: "c",
        ts: 2,
        payload: { inputTokens: 300, outputTokens: 500, costUsd: 0.0015 },
      }),
    ])
    // c has no totalTokens → derived from input+output (800).
    expect(out.usage).toEqual({ totalTokens: 2000, costUsd: 0.0035 })
  })

  it("omits cost from the aggregate when no step reported a price", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_usage", stepId: "b", ts: 1, payload: { totalTokens: 500 } }),
    ])
    expect(out.usage).toEqual({ totalTokens: 500 })
    expect(out.usage?.costUsd).toBeUndefined()
  })

  it("leaves usage undefined when no step_usage event was seen", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [evt({ type: "step_started", stepId: "b", ts: 1 })])
    expect(out.usage).toBeUndefined()
  })

  it("attributes per-step usage (tokens + cost), latest snapshot wins", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({
        type: "step_usage",
        stepId: "b",
        ts: 1,
        payload: { totalTokens: 100, costUsd: 0.001 },
      }),
      evt({
        type: "step_usage",
        stepId: "b",
        ts: 2,
        payload: { totalTokens: 250, costUsd: 0.003 },
      }),
    ])
    expect(out.steps[1]).toMatchObject({ usageTokens: 250, usageCostUsd: 0.003 })
  })

  it("tracks retry attempts from step_retrying", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_retrying", stepId: "c", ts: 1, payload: { attempt: 1, maxAttempts: 3 } }),
      evt({ type: "step_retrying", stepId: "c", ts: 2, payload: { attempt: 2, maxAttempts: 3 } }),
    ])
    expect(out.steps[2].retryCount).toBe(2)
  })

  it("clamps long-running progress to 0–100", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step.long_running.progress", stepId: "b", ts: 1, payload: { progress: 42 } }),
      evt({ type: "step.long_running.progress", stepId: "c", ts: 2, payload: { progress: 150 } }),
    ])
    expect(out.steps[1].progress).toBe(42)
    expect(out.steps[2].progress).toBe(100)
  })

  it("keeps the newest streamed delta, truncated", () => {
    const init = buildInitialSteps(nodes)
    const long = "x".repeat(200)
    const out = foldRunEvents(init, [
      evt({ type: "step_stream", stepId: "c", ts: 1, payload: { delta: "hello", seq: 1 } }),
      evt({ type: "step_stream", stepId: "c", ts: 2, payload: { delta: long, seq: 2 } }),
    ])
    const preview = out.steps[2].lastStreamDelta ?? ""
    expect(preview.endsWith("…")).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(60)
  })

  it("leaves all new fields undefined when no enriching events arrive (back-compat)", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "b", ts: 1 }),
      evt({ type: "step_completed", stepId: "b", ts: 2 }),
    ])
    expect(out.steps[1]).toMatchObject({ status: "succeeded" })
    expect(out.steps[1].usageTokens).toBeUndefined()
    expect(out.steps[1].retryCount).toBeUndefined()
    expect(out.steps[1].progress).toBeUndefined()
    expect(out.steps[1].lastStreamDelta).toBeUndefined()
  })

  it("counts loop iterations from the iterationIndex on step_started", () => {
    const init = buildInitialSteps(nodes)
    const out = foldRunEvents(init, [
      evt({ type: "step_started", stepId: "b", ts: 1, payload: { iterationIndex: 0 } }),
      evt({ type: "step_completed", stepId: "b", ts: 2, payload: { iterationIndex: 0 } }),
      evt({ type: "step_started", stepId: "b", ts: 3, payload: { iterationIndex: 1 } }),
      evt({ type: "step_completed", stepId: "b", ts: 4, payload: { iterationIndex: 1 } }),
      evt({ type: "step_started", stepId: "b", ts: 5, payload: { iterationIndex: 2 } }),
    ])
    // Highest index 2 → 3 iterations observed.
    expect(out.steps[1].iterations).toBe(3)
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
