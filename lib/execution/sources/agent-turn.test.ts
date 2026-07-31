import { AgentRunEventProducer } from "./agent-turn"
import type { AppendRunEventInput } from "@/lib/db/execution-runs"

describe("AgentRunEventProducer", () => {
  it("emits safe semantic events without reasoning or raw tool data", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer(
      "run-agent",
      async (_runId, input) => {
        appended.push(input)
        return {} as never
      },
      { workspaceRoot: "/workspace/project" }
    )

    await producer.start(1_000)
    await producer.onCaptureEvent({ type: "thinking-delta", delta: "private reasoning" }, 1_001)
    await producer.onCaptureEvent({ type: "text-delta", delta: "draft answer" }, 1_001)
    await producer.onCaptureEvent(
      {
        type: "tool-call",
        id: "call-1",
        toolName: "Read",
        input: {
          file_path: "/workspace/project/src/index.ts",
          command: "printenv secret",
          query: "secret",
        },
      },
      1_002
    )
    await producer.onCaptureEvent(
      {
        type: "tool-result",
        id: "call-1",
        toolName: "Read",
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
    expect(wire).not.toContain("draft answer")
    expect(wire).not.toContain("secret")
    expect(wire).not.toContain("raw result")
    expect(appended.find((item) => item.type === "tool.started")?.payload).toEqual({
      toolCallId: "call-1",
      toolName: "Read",
      category: "read",
      summary: "Reading files",
      target: { kind: "workspace_path", label: "src/index.ts" },
    })
    expect(appended.find((item) => item.type === "step.completed")?.payload).toMatchObject({
      safeTitle: true,
      safeSummary: true,
    })
  })

  it("projects commentary into one updatable progress activity", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })

    await producer.onCaptureEvent(
      { type: "commentary-delta", messageId: "c1", delta: "Checking ", done: false },
      2_000
    )
    await producer.onCaptureEvent(
      { type: "commentary-delta", messageId: "c1", delta: "the files", done: false },
      2_001
    )
    await producer.onCaptureEvent(
      { type: "commentary-delta", messageId: "c1", delta: "", done: true },
      2_002
    )

    expect(appended.map((item) => item.type)).toEqual([
      "step.added",
      "step.started",
      "step.progress",
    ])
    expect(appended.map((item) => item.payload.stepId)).toEqual([
      "commentary:c1",
      "commentary:c1",
      "commentary:c1",
    ])
    expect(appended[0].payload).toMatchObject({
      title: "Checking",
      safeTitle: true,
      category: "status",
    })
    expect(appended[2].payload).toMatchObject({
      title: "Checking the files",
      safeTitle: true,
      category: "status",
    })
  })

  it("categorizes tools, synthesizes ids, and reports failures", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })

    await producer.onCaptureEvent({ type: "tool-call", toolName: "Read", input: {} }, 1_010)
    await producer.onCaptureEvent(
      { type: "tool-call", id: "c2", toolName: "Edit", input: {} },
      1_011
    )
    await producer.onCaptureEvent(
      { type: "tool-call", id: "c3", toolName: "Bash", input: {} },
      1_012
    )
    await producer.onCaptureEvent(
      { type: "tool-call", id: "c4", toolName: "mcp_custom", input: {} },
      1_013
    )
    await producer.onCaptureEvent(
      { type: "tool-result", id: "c3", toolName: "Bash", result: "boom", isError: true },
      1_014
    )
    await producer.onCaptureEvent(
      { type: "tool-result", toolName: "web_search", result: "ok" },
      1_015
    )
    await producer.finish("failed", 1_016, "exploded")
    await producer.finish("cancelled", 1_017)

    const started = appended.filter((item) => item.type === "tool.started")
    expect(started.map((item) => item.payload.toolName)).toEqual([
      "Read",
      "Edit",
      "Bash",
      "mcp_custom",
    ])
    expect(started.map((item) => item.payload.category)).toEqual([
      "read",
      "write",
      "command",
      "integration",
    ])
    expect(appended.map((item) => item.type)).toEqual(
      expect.arrayContaining(["tool.failed", "step.failed", "run.failed", "run.cancelled"])
    )
  })

  it("records a machine-readable degradation event", async () => {
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
