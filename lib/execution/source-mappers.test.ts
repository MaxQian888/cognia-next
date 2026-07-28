import { mapWorkflowRunEvent } from "./sources/workflow"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

describe("mapWorkflowRunEvent", () => {
  function workflowEvent(
    type: WorkflowRunEventRow["type"],
    payload?: unknown
  ): WorkflowRunEventRow {
    return { id: `wf-${type}`, runId: "wf-run", type, ts: 2_000, stepId: "node-1", payload }
  }

  it("maps durable workflow lifecycle and step events with source-event deduplication", () => {
    expect(
      mapWorkflowRunEvent(
        workflowEvent("step_completed", { output: "private", summary: "Built" }),
        {
          stepTitle: "Build release",
        }
      )
    ).toEqual(
      expect.objectContaining({
        type: "step.completed",
        sourceEventId: "wf-step_completed",
        payload: { stepId: "node-1", title: "Build release", summary: "Built" },
      })
    )
    expect(
      mapWorkflowRunEvent(workflowEvent("step_stream", { delta: "raw model text" }))
    ).toBeNull()
  })

  it("maps terminal failures without copying raw structured payloads", () => {
    const mapped = mapWorkflowRunEvent(
      workflowEvent("run_failed", { error: { message: "Network unavailable", details: "secret" } })
    )
    expect(mapped).toEqual(
      expect.objectContaining({ type: "run.failed", payload: { error: "Network unavailable" } })
    )
    expect(JSON.stringify(mapped)).not.toContain("secret")
  })
})
