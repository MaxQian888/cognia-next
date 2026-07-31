/**
 * @jest-environment node
 */
import { buildStepInspectorDoc } from "./workflow-step-doc"
import type { RunStepView } from "./workflow-run-fold"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function evt(
  p: Partial<WorkflowRunEventRow> & { type: WorkflowRunEventRow["type"]; ts: number }
): WorkflowRunEventRow {
  return { id: "e" + p.ts, runId: "r1", ...p } as WorkflowRunEventRow
}

const step: RunStepView = {
  id: "b",
  label: "Generate",
  status: "succeeded",
  category: "ai",
  durationMs: 1500,
  retryCount: 1,
}

describe("buildStepInspectorDoc", () => {
  it("renders the header, status meta, and a usage breakdown from events", () => {
    const events = [
      evt({
        type: "step_usage",
        stepId: "b",
        ts: 1,
        payload: {
          inputTokens: 300,
          outputTokens: 500,
          totalTokens: 800,
          modelId: "claude-x",
          costUsd: 0.004,
        },
      }),
    ]
    const doc = buildStepInspectorDoc(step, events)
    expect(doc).toContain("# ✓ Generate")
    expect(doc).toContain("**Status:** succeeded")
    expect(doc).toContain("**Category:** ai")
    expect(doc).toContain("**Retries:** 1")
    expect(doc).toContain("## Usage")
    expect(doc).toContain("800 tokens")
    expect(doc).toContain("model claude-x")
  })

  it("includes output, input and step-scoped logs", () => {
    const events = [
      evt({ type: "step_started", stepId: "b", ts: 1, payload: { params: { topic: "x" } } }),
      evt({
        type: "run_log",
        stepId: "b",
        ts: 2,
        level: "warn",
        payload: { message: "slow upstream" },
      }),
      evt({
        type: "run_log",
        stepId: "other",
        ts: 3,
        level: "info",
        payload: { message: "ignore me" },
      }),
      evt({ type: "step_completed", stepId: "b", ts: 4, payload: { output: "done" } }),
    ]
    const doc = buildStepInspectorDoc(step, events)
    expect(doc).toContain("## Output")
    expect(doc).toContain("done")
    expect(doc).toContain("## Input")
    expect(doc).toContain("topic")
    expect(doc).toContain("[WARN] slow upstream")
    expect(doc).not.toContain("ignore me")
  })

  it("degrades each section to _none_ when there are no events", () => {
    const doc = buildStepInspectorDoc(step, [])
    expect(doc).toContain("## Usage\n_none_")
    expect(doc).toContain("## Output\n_none_")
    expect(doc).toContain("## Input\n_none_")
    expect(doc).toContain("## Logs\n_none_")
  })

  it("surfaces the error as a callout", () => {
    const failed: RunStepView = { ...step, status: "failed", error: "rate limited" }
    const doc = buildStepInspectorDoc(failed, [])
    expect(doc).toContain("⚠️ rate limited")
  })

  it("skips logs that carry no message and renders empty output gracefully", () => {
    const events = [
      evt({ type: "run_log", stepId: "b", ts: 1, level: "info", payload: {} }),
      evt({ type: "step_completed", stepId: "b", ts: 2, payload: undefined }),
    ]
    const doc = buildStepInspectorDoc(step, events)
    // No message-bearing logs → Logs degrades to _none_.
    expect(doc).toContain("## Logs\n_none_")
    // step_completed with no payload → Output renders an empty code block.
    expect(doc).toContain("## Output")
  })

  it("truncates an oversized output payload", () => {
    const big = "z".repeat(5000)
    const events = [evt({ type: "step_completed", stepId: "b", ts: 1, payload: big })]
    const doc = buildStepInspectorDoc(step, events)
    expect(doc).toContain("truncated")
  })

  it("falls back to String() when the output payload can't be serialized", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const events = [evt({ type: "step_completed", stepId: "b", ts: 1, payload: circular })]
    const doc = buildStepInspectorDoc(step, events)
    expect(doc).toContain("[object Object]")
  })
})
