import { buildRunReplayDoc } from "./workflow-replay-doc"
import type { RunStepView } from "./workflow-run-fold"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

const step = (id: string, label: string, status: RunStepView["status"]): RunStepView => ({
  id,
  label,
  status,
})

describe("buildRunReplayDoc", () => {
  const nodes = [
    { id: "t", type: "trigger.manual", data: { label: "Start" } },
    { id: "p", type: "ai.prompt", data: { label: "Summarize" } },
  ]
  const edges = [{ source: "t", target: "p" }]
  const events: WorkflowRunEventRow[] = [
    { type: "step_started", stepId: "p", ts: 0 } as WorkflowRunEventRow,
    { type: "step_completed", stepId: "p", ts: 5, payload: { ok: true } } as WorkflowRunEventRow,
  ]

  it("renders the timeline, topology, and per-step detail", () => {
    const doc = buildRunReplayDoc({
      workflowName: "Nightly",
      status: "succeeded",
      steps: [step("t", "Start", "succeeded"), step("p", "Summarize", "succeeded")],
      events,
      nodes,
      edges,
    })
    expect(doc).toContain("Workflow run · Nightly — succeeded")
    expect(doc).toContain("## Structure")
    expect(doc).toContain("## Step details")
    // Both ran steps get an inspector section.
    expect(doc).toContain("Start")
    expect(doc).toContain("Summarize")
  })

  it("omits the step-details section when nothing ran", () => {
    const doc = buildRunReplayDoc({
      workflowName: "Idle",
      status: "failed",
      steps: [step("t", "Start", "pending")],
      events: [],
      nodes,
      edges,
    })
    expect(doc).not.toContain("## Step details")
  })
})
