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

  it("categorizes tools, synthesizes ids for anonymous calls, and reports failures", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })

    // Anonymous tool-call (no id) + each summary category + an error result.
    await producer.onCaptureEvent({ type: "tool-call", toolName: "Read" }, 1_010)
    await producer.onCaptureEvent({ type: "tool-call", id: "c2", toolName: "Edit" }, 1_011)
    await producer.onCaptureEvent({ type: "tool-call", id: "c3", toolName: "Bash" }, 1_012)
    await producer.onCaptureEvent({ type: "tool-call", id: "c4", toolName: "mcp_custom" }, 1_013)
    await producer.onCaptureEvent(
      { type: "tool-result", id: "c3", toolName: "Bash", result: "boom", isError: true },
      1_014
    )
    // A result whose call was never seen still lands on a synthesized step.
    await producer.onCaptureEvent(
      { type: "tool-result", toolName: "web_search", result: "ok" },
      1_015
    )
    await producer.finish("failed", 1_016, "exploded")
    await producer.finish("cancelled", 1_017)

    const types = appended.map((item) => item.type)
    expect(types).toContain("tool.failed")
    expect(types).toContain("step.failed")
    expect(types).toContain("run.failed")
    expect(types).toContain("run.cancelled")
    const started = appended.filter((item) => item.type === "tool.started")
    expect(started.map((item) => (item.payload as { toolName: string }).toolName)).toEqual([
      "read",
      "write",
      "command",
      "integration",
    ])
    // The failed run event carries the summary as its error.
    const failed = appended.find((item) => item.type === "run.failed")
    expect(failed?.payload).toEqual({ error: "exploded" })
  })

  it("records a machine-readable run.degraded event (ADR-0090)", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })

    await producer.degraded("sidecar-unavailable", 1_500)

    expect(appended).toEqual([
      expect.objectContaining({
        type: "run.degraded",
        payload: { reason: "sidecar-unavailable" },
      }),
    ])
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
