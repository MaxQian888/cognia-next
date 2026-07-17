import { AgentRunEventProducer } from "./sources/agent-turn"
import { mapWorkflowRunEvent } from "./sources/workflow"
import type { AppendRunEventInput } from "@/lib/db/execution-runs"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

describe("AgentRunEventProducer", () => {
  it("turns capture events into semantic steps and never persists thinking or raw tool data", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })

    await producer.start(1_000)
    await producer.onCaptureEvent({ type: "thinking-delta", delta: "private reasoning" }, 1_001)
    await producer.onCaptureEvent(
      { type: "tool-call", id: "call-1", toolName: "web_search", input: { query: "secret" } },
      1_002
    )
    await producer.onCaptureEvent(
      {
        type: "tool-result",
        id: "call-1",
        toolName: "web_search",
        result: { secret: "raw result" },
      },
      1_003
    )
    await producer.finish("completed", 1_004, "Research complete")

    expect(appended.map((item) => item.type)).toEqual([
      "run.started",
      "step.added",
      "step.started",
      "tool.started",
      "tool.completed",
      "step.completed",
      "run.completed",
    ])
    const wire = JSON.stringify(appended)
    expect(wire).not.toContain("private reasoning")
    expect(wire).not.toContain("secret")
    expect(wire).not.toContain("raw result")
  })
})

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
