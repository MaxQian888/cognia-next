import { deriveLastRunSummary, withStepUsage } from "./last-run-summary"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function ev(
  ts: number,
  type: WorkflowRunEventRow["type"],
  stepId?: string,
  payload?: unknown
): WorkflowRunEventRow {
  return { id: `e_${ts}_${stepId ?? "x"}`, runId: "r1", ts, type, stepId, payload }
}

describe("deriveLastRunSummary", () => {
  it("returns an empty object when there are no terminal events", () => {
    expect(deriveLastRunSummary([])).toEqual({})
    expect(deriveLastRunSummary([ev(1, "run_started")])).toEqual({})
  })

  it("emits a succeeded summary with duration and attempt=1", () => {
    const out = deriveLastRunSummary([
      ev(100, "step_started", "n1"),
      ev(250, "step_completed", "n1"),
    ])
    expect(out["n1"]).toEqual({
      status: "succeeded",
      startedAt: 100,
      finishedAt: 250,
      durationMs: 150,
      errorMessage: undefined,
      attempt: 1,
    })
  })

  it("captures the failure message for failed steps", () => {
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(50, "step_failed", "n1", { message: "Something broke\nstack frame here" }),
    ])
    expect(out["n1"].status).toBe("failed")
    expect(out["n1"].errorMessage).toBe("Something broke")
  })

  it("falls back to nested {error: {message}} payload shape", () => {
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(10, "step_failed", "n1", { error: { message: "oops" } }),
    ])
    expect(out["n1"].errorMessage).toBe("oops")
  })

  it("flags handled failures (failed → completed with no new attempt)", () => {
    // The orchestrator's per-node onError emits step_completed with the
    // substituted output right after the recorded step_failed.
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(10, "step_failed", "n1", { message: "boom" }),
      ev(11, "step_completed", "n1", { output: { failed: true, error: "boom" } }),
    ])
    expect(out["n1"].status).toBe("succeeded")
    expect(out["n1"].handled).toBe(true)
    expect(out["n1"].errorMessage).toBe("boom")
  })

  it("does NOT flag handled when a retry succeeded normally", () => {
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(10, "step_failed", "n1", { message: "transient" }),
      ev(20, "step_started", "n1"),
      ev(30, "step_completed", "n1"),
    ])
    expect(out["n1"].status).toBe("succeeded")
    expect(out["n1"].handled).toBeUndefined()
  })

  it("counts retry attempts and keeps the latest terminal", () => {
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(10, "step_failed", "n1"),
      ev(20, "step_started", "n1"),
      ev(30, "step_completed", "n1"),
    ])
    expect(out["n1"].status).toBe("succeeded")
    // Two starts → attempt=2 on the latest
    expect(out["n1"].attempt).toBe(2)
    expect(out["n1"].startedAt).toBe(20)
    expect(out["n1"].finishedAt).toBe(30)
  })

  it("treats skipped events as their own terminal status", () => {
    const out = deriveLastRunSummary([ev(5, "step_skipped", "n1")])
    expect(out["n1"].status).toBe("skipped")
    // No prior step_started → durationMs=0
    expect(out["n1"].durationMs).toBe(0)
  })

  it("ignores events without a stepId", () => {
    const out = deriveLastRunSummary([ev(0, "step_started"), ev(5, "step_completed")])
    expect(out).toEqual({})
  })

  it("handles multiple steps independently", () => {
    const out = deriveLastRunSummary([
      ev(0, "step_started", "n1"),
      ev(5, "step_started", "n2"),
      ev(10, "step_completed", "n1"),
      ev(15, "step_failed", "n2", { message: "boom" }),
    ])
    expect(out["n1"].status).toBe("succeeded")
    expect(out["n2"].status).toBe("failed")
    expect(out["n2"].errorMessage).toBe("boom")
  })

  it("re-sorts unsorted input chronologically", () => {
    const out = deriveLastRunSummary([ev(30, "step_completed", "n1"), ev(10, "step_started", "n1")])
    expect(out["n1"].durationMs).toBe(20)
  })
})

describe("withStepUsage", () => {
  const usageEvent = (over: Record<string, unknown>) =>
    ({ runId: "r", ts: 1, type: "step_usage", ...over }) as never

  it("attaches tokens and cost to the step that reported them", () => {
    // `step_usage` was already aggregated for the run detail page. It just
    // never reached the canvas, so the most expensive node in a graph looked
    // exactly like the cheapest.
    const summaries = {
      n1: { status: "succeeded", startedAt: 0, finishedAt: 1, durationMs: 1, attempt: 1 },
    } as never
    const out = withStepUsage(summaries, [
      usageEvent({ stepId: "n1", payload: { inputTokens: 100, outputTokens: 20, costUsd: 0.004 } }),
    ])
    expect(out.n1!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.004,
    })
  })

  it("omits the key entirely for a step that reported nothing", () => {
    // A row of zeros on every non-LLM node would be noise on the card.
    const summaries = {
      n1: { status: "succeeded", startedAt: 0, finishedAt: 1, durationMs: 1, attempt: 1 },
    } as never
    expect(withStepUsage(summaries, []).n1!.usage).toBeUndefined()
  })

  it("keeps cost absent when the provider reported no pricing", () => {
    const summaries = {
      n1: { status: "succeeded", startedAt: 0, finishedAt: 1, durationMs: 1, attempt: 1 },
    } as never
    const out = withStepUsage(summaries, [
      usageEvent({ stepId: "n1", payload: { inputTokens: 5, outputTokens: 5 } }),
    ])
    expect(out.n1!.usage?.totalTokens).toBe(10)
    expect(out.n1!.usage?.costUsd).toBeUndefined()
  })
})
