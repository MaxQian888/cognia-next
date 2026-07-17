import { runEventsToAgUi } from "./ag-ui-export"
import type { RunEvent } from "@/types/execution/run"

function event(seq: number, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  return {
    id: `e-${seq}`,
    runId: "run-1",
    seq,
    ts: 1_000 + seq,
    type,
    visibility: "summary",
    payload,
  }
}

describe("runEventsToAgUi", () => {
  it("exports lifecycle, step, and semantic tool events without reasoning or raw arguments", () => {
    const output = runEventsToAgUi("thread-1", [
      event(1, "run.started", {}),
      event(2, "step.started", { stepId: "search", title: "Search docs" }),
      event(3, "tool.started", {
        toolCallId: "tool-1",
        toolName: "web_search",
        summary: "Searching official documentation",
        rawArgs: { query: "secret" },
      }),
      event(4, "tool.completed", {
        toolCallId: "tool-1",
        toolName: "web_search",
        summary: "Found 3 sources",
        rawResult: "secret output",
      }),
      event(5, "run.completed", { summary: "Research complete" }),
    ])

    expect(output.map((item) => item.type)).toEqual([
      "RUN_STARTED",
      "STEP_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ])
    expect(JSON.stringify(output)).not.toContain("rawArgs")
    expect(JSON.stringify(output)).not.toContain("rawResult")
    expect(JSON.stringify(output)).not.toContain("secret")
    expect(output.some((item) => item.type.startsWith("REASONING"))).toBe(false)
  })

  it("omits private journal events", () => {
    const privateEvent = {
      ...event(1, "milestone.created", { summary: "internal" }),
      visibility: "private" as const,
    }
    expect(runEventsToAgUi("thread-1", [privateEvent])).toEqual([])
  })
})
