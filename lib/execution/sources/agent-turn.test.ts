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

    await producer.start(1_000, {
      recoveryAnchor: { version: 1, attemptId: "attempt-1" },
    })
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
    expect(appended[0].payload).toEqual({
      recoveryAnchor: { version: 1, attemptId: "attempt-1" },
    })
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

  it("humanizes integration step titles and journals only sanitized failure text", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })
    await producer.onCaptureEvent(
      {
        type: "tool-call",
        id: "issue",
        toolName: "mcp__issues__issue_list_projects",
        input: { secret: "private arguments" },
      },
      1000
    )
    await producer.onCaptureEvent(
      {
        type: "tool-result",
        id: "issue",
        toolName: "mcp__issues__issue_list_projects",
        result: {
          error: { message: "Access denied for alice@example.com\nprivate stack" },
          input: "private arguments",
        },
        isError: true,
      },
      1001
    )
    expect(
      appended.filter((row) => row.type.startsWith("step.")).map((row) => row.payload.title)
    ).toEqual(["Issue list projects", "Issue list projects", "Issue list projects"])
    const failure = appended.find((row) => row.type === "tool.failed")?.payload
    expect(failure).toMatchObject({
      safeFailureReason: true,
      failureReason: expect.stringContaining("Access denied for"),
    })
    expect(JSON.stringify(appended)).not.toMatch(
      /alice@example.com|private stack|private arguments/
    )
  })

  it.each([
    ["Timed out", "Timed out"],
    [{ content: [{ type: "text", text: "Server unavailable" }] }, "Server unavailable"],
    [[{ type: "text", text: "Request timed out" }], "Request timed out"],
    [{ error: "curl https://example.com?token=secret" }, "Tool failed"],
    [{ error: "Permission denied", args: "private" }, "Permission denied"],
  ])("extracts safe failure text from supported result shapes", async (result, reason) => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })
    await producer.onCaptureEvent({
      type: "tool-result",
      id: "failed",
      toolName: "issue_list",
      result,
      isError: true,
    })
    expect(appended.find((row) => row.type === "tool.failed")?.payload).toMatchObject({
      failureReason: reason,
      safeFailureReason: true,
    })
  })

  it("preserves safe commentary prose while removing execution details before journaling", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-agent", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })
    await producer.onCaptureEvent(
      {
        type: "commentary-delta",
        messageId: "prose",
        delta: "Checking `code` and git history at https://user:pass@example.com?token=secret",
        done: true,
      },
      2_000
    )
    await producer.onCaptureEvent(
      {
        type: "commentary-delta",
        messageId: "command",
        delta: "git log -S secret -- docs/plans",
        done: true,
      },
      2_001
    )

    expect(appended[2].payload).toMatchObject({
      title: "Checking code and git history at example.com",
      category: "status",
      safeTitle: true,
    })
    expect(appended[5].payload.title).toBe("Agent progress")
    expect(JSON.stringify(appended)).not.toMatch(/user:pass|token=secret|git log|docs\/plans/)
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

describe("verification artifacts", () => {
  const JEST_OUTPUT = `
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 2 skipped, 10 passed, 13 total
Time:        4.2 s
`

  /** Drive one Bash tool call and return every event the producer appended. */
  async function runToolCall(command: string, result: unknown, isError = false) {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-verify", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })
    await producer.onCaptureEvent(
      { type: "tool-call", id: "call-1", toolName: "Bash", input: { command } },
      1_000
    )
    await producer.onCaptureEvent(
      { type: "tool-result", id: "call-1", toolName: "Bash", result, isError },
      1_001
    )
    return appended
  }

  const artifactsIn = (events: AppendRunEventInput[]) =>
    events.filter((event) => event.type === "artifact.created")

  it("emits counts for a test command", async () => {
    const artifacts = artifactsIn(await runToolCall("pnpm test -- lib/", JEST_OUTPUT, true))
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].payload).toMatchObject({
      artifactId: "verification:call-1",
      title: "Tests",
      safeTitle: true,
      kind: "verification",
      detailsRef: "call-1",
      verification: { conclusion: "failed", passed: 10, failed: 1, skipped: 2, total: 13 },
    })
  })

  it("emits nothing for a command that is not a test run", async () => {
    expect(artifactsIn(await runToolCall("git status", "clean"))).toHaveLength(0)
  })

  it("reports inconclusive rather than a green run when output is unparseable", async () => {
    const artifacts = artifactsIn(
      await runToolCall("pnpm test", "Command failed with exit code 137.", true)
    )
    expect(artifacts).toHaveLength(1)
    const { verification } = artifacts[0].payload as {
      verification: { conclusion: string; failed: number }
    }
    expect(verification.conclusion).toBe("inconclusive")
    expect(verification.conclusion).not.toBe("passed")
  })

  it("never puts raw test output or the command line in the journal", async () => {
    const secret = "MY_TOKEN=sk-secret-value"
    const events = await runToolCall(
      `${secret} pnpm test -- lib/`,
      `${JEST_OUTPUT}\nFAIL /Users/someone/private/path/foo.test.ts`
    )
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("sk-secret-value")
    expect(serialized).not.toContain("/Users/someone/private/path")
    expect(serialized).not.toContain("FAIL")
  })

  it("emits at most one artifact when a result is delivered twice", async () => {
    const appended: AppendRunEventInput[] = []
    const producer = new AgentRunEventProducer("run-verify", async (_runId, input) => {
      appended.push(input)
      return {} as never
    })
    const call = { type: "tool-call", id: "c1", toolName: "Bash", input: { command: "jest" } }
    const result = { type: "tool-result", id: "c1", toolName: "Bash", result: JEST_OUTPUT }
    await producer.onCaptureEvent(call as never, 1_000)
    await producer.onCaptureEvent(result as never, 1_001)
    await producer.onCaptureEvent(result as never, 1_002)
    // The second result has no remembered runner and no test-shaped input of
    // its own to re-detect from, so it must not mint a duplicate artifact.
    expect(artifactsIn(appended)).toHaveLength(1)
  })
})
