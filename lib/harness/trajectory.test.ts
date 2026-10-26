import {
  OBSERVATION_MAX_CHARS,
  createTrajectoryRecorder,
  renderTrajectory,
  summarizeTrajectory,
  trajectoryFromMessageParts,
} from "./trajectory"

describe("createTrajectoryRecorder", () => {
  it("turns a capture stream into actions, observations and assistant text", () => {
    const rec = createTrajectoryRecorder()
    rec.onEvent({ type: "text-delta", delta: "Let me " })
    rec.onEvent({ type: "text-delta", delta: "look." })
    rec.onEvent({ type: "tool-call", toolName: "Read", input: { path: "a.csv" }, id: "c1" })
    rec.onEvent({ type: "tool-result", toolName: "Read", result: "x,y\n1,2", id: "c1" })
    rec.onEvent({ type: "tool-call", toolName: "Bash", input: { command: "ls" }, id: "c2" })
    rec.onEvent({
      type: "tool-result",
      toolName: "Bash",
      result: "ENOENT",
      isError: true,
      id: "c2",
    })
    rec.onEvent({ type: "thinking-delta", delta: "hidden" })
    rec.onEvent({ type: "text-delta", delta: "Done." })
    const entries = rec.entries()
    expect(entries).toEqual([
      { kind: "assistant", text: "Let me look." },
      { kind: "action", toolName: "Read", input: { path: "a.csv" }, callId: "c1" },
      { kind: "observation", toolName: "Read", output: "x,y\n1,2", isError: false, callId: "c1" },
      { kind: "action", toolName: "Bash", input: { command: "ls" }, callId: "c2" },
      {
        kind: "observation",
        toolName: "Bash",
        output: "Error: ENOENT",
        isError: true,
        callId: "c2",
      },
      { kind: "assistant", text: "Done." },
    ])
    expect(rec.summary()).toMatchObject({
      toolCalls: 2,
      toolFailures: 1,
      steps: 4,
      finalText: "Done.",
    })
  })

  it("records a blocked action as an action plus an error observation", () => {
    const rec = createTrajectoryRecorder()
    rec.recordBlocked("Bash", { command: "git push" }, "external side effect")
    expect(rec.summary()).toMatchObject({ toolCalls: 1, toolFailures: 1 })
    expect(rec.entries()[1]).toMatchObject({
      kind: "observation",
      output: "Blocked by the probe policy: external side effect",
      isError: true,
    })
  })

  it("keeps long observations up to its own cap, not the reference cap", () => {
    const rec = createTrajectoryRecorder()
    rec.onEvent({ type: "tool-result", toolName: "Read", result: "x".repeat(11_000) })
    const obs = rec.entries()[0]
    expect(obs.kind === "observation" && obs.output.length).toBe(11_000)
    rec.onEvent({
      type: "tool-result",
      toolName: "Read",
      result: "y".repeat(OBSERVATION_MAX_CHARS + 10),
    })
    const capped = rec.entries()[1]
    expect(capped.kind === "observation" && capped.output).toMatch(/tool output truncated/)
  })
})

describe("summarizeTrajectory", () => {
  it("names delegations with their target", () => {
    const summary = summarizeTrajectory([
      { kind: "action", toolName: "Task", input: { subagent_type: "checker" } },
      { kind: "action", toolName: "dispatch_agent", input: { subagentId: "writer" } },
      { kind: "action", toolName: "Agent", input: {} },
      { kind: "action", toolName: "Read", input: {} },
    ])
    expect(summary.delegations).toEqual(["Task:checker", "dispatch_agent:writer", "Agent"])
  })
})

describe("trajectoryFromMessageParts", () => {
  it("reads assistant text and both tool-part dialects, skipping user turns", () => {
    const entries = trajectoryFromMessageParts([
      { role: "user", parts: [{ type: "text", text: "Do it" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "On it." },
          {
            type: "tool-Read",
            toolCallId: "t1",
            input: { path: "a" },
            state: "output-available",
            output: "contents",
          },
          {
            type: "dynamic-tool",
            toolName: "mcp__fs__write",
            toolCallId: "t2",
            input: {},
            state: "output-error",
            errorText: "denied",
          },
          { type: "tool-Bash", toolCallId: "t3", input: {}, state: "input-available" },
          { type: "reasoning", text: "skip" },
        ],
      },
    ])
    expect(entries).toEqual([
      { kind: "assistant", text: "On it." },
      { kind: "action", toolName: "Read", input: { path: "a" }, callId: "t1" },
      { kind: "observation", toolName: "Read", output: "contents", isError: false, callId: "t1" },
      { kind: "action", toolName: "mcp__fs__write", input: {}, callId: "t2" },
      {
        kind: "observation",
        toolName: "mcp__fs__write",
        output: "Error: denied",
        isError: true,
        callId: "t2",
      },
      { kind: "action", toolName: "Bash", input: {}, callId: "t3" },
    ])
  })
})

describe("renderTrajectory", () => {
  it("uses the [ACTION]/[OBSERVATION]/[ERROR] grammar", () => {
    const text = renderTrajectory([
      { kind: "assistant", text: "Plan." },
      { kind: "action", toolName: "Read", input: { path: "a" } },
      { kind: "observation", toolName: "Read", output: "ok", isError: false },
      { kind: "observation", toolName: "Bash", output: "", isError: true },
    ])
    expect(text).toBe(
      '[ASSISTANT] Plan.\n\n[ACTION] Read {"path":"a"}\n\n[OBSERVATION] Read\nok\n\n[ERROR] Bash\n(empty)'
    )
  })

  it("cuts the middle of an over-long trajectory and says how much", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      kind: "assistant" as const,
      text: `step ${i} ${"z".repeat(100)}`,
    }))
    const text = renderTrajectory(entries, { maxChars: 1_000 })
    expect(text.length).toBeLessThan(1_100)
    expect(text.startsWith("[ASSISTANT] step 0")).toBe(true)
    expect(text).toMatch(/chars of trajectory omitted/)
    expect(text).toMatch(/step 49 z+$/)
  })
})
