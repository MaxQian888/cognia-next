import { chatLikePrompt, summarizeTaskPayload, type PayloadFact } from "./payload-summary"

function factById(facts: PayloadFact[], id: string): PayloadFact | undefined {
  return facts.find((fact) => fact.id === id)
}

describe("summarizeTaskPayload", () => {
  it("reads a chat task's prompt and the run options it set, and omits the ones it did not", () => {
    const summary = summarizeTaskPayload({
      type: "agent",
      payload: {
        prompt: "Summarise yesterday's inbox",
        characterId: "char-1",
        model: "claude-opus-5-5",
        maxTurns: 12,
        allowedTools: ["Read", "Bash"],
        additionalDirectories: ["/tmp/a"],
      },
    })

    expect(summary.taskType).toBe("agent")
    expect(factById(summary.facts, "prompt")?.value).toEqual({
      kind: "multiline",
      text: "Summarise yesterday's inbox",
    })
    expect(factById(summary.facts, "character")?.value).toEqual({
      kind: "reference",
      ref: "character",
      id: "char-1",
    })
    expect(factById(summary.facts, "model")?.value).toEqual({
      kind: "mono",
      text: "claude-opus-5-5",
    })
    expect(factById(summary.facts, "maxTurns")?.value).toEqual({ kind: "count", value: 12 })
    expect(factById(summary.facts, "allowedTools")?.value).toEqual({
      kind: "list",
      items: ["Read", "Bash"],
      mono: true,
    })
    // Never set, so not a fact about this task.
    expect(factById(summary.facts, "skill")).toBeUndefined()
    expect(factById(summary.facts, "effort")).toBeUndefined()
    expect(factById(summary.facts, "mcpServers")).toBeUndefined()
  })

  it("lifts the legacy prompt keys the chat executor still reads", () => {
    expect(chatLikePrompt({ message: "old" })).toBe("old")
    expect(chatLikePrompt({ agentTask: "older" })).toBe("older")
    expect(chatLikePrompt({ prompt: "new", message: "old" })).toBe("new")
    expect(chatLikePrompt({ prompt: "   " })).toBeUndefined()
  })

  it("shows an explicit mode opt-out and an explicit empty MCP list as choices", () => {
    const summary = summarizeTaskPayload({
      type: "chat",
      payload: { prompt: "p", agentModeId: null, mcpServerIds: [] },
    })
    expect(factById(summary.facts, "agentMode")?.value).toEqual({
      kind: "label",
      key: "payload.modeNone",
    })
    expect(factById(summary.facts, "mcpServers")?.value).toEqual({ kind: "count", value: 0 })
  })

  it("reads a workflow task's workflow, environment and inputs", () => {
    const summary = summarizeTaskPayload({
      type: "workflow",
      payload: { workflowId: "wf-1", environment: "staging", inputs: { a: 1 } },
    })
    expect(summary.facts.map((fact) => fact.id)).toEqual(["workflow", "environment", "inputs"])
    expect(factById(summary.facts, "inputs")?.value).toEqual({ kind: "json", value: { a: 1 } })
  })

  it("reads a background command and converts nothing it does not need to", () => {
    const summary = summarizeTaskPayload({
      type: "background-command",
      payload: { command: "pnpm test", cwd: "/repo", maxRuntimeMs: 600_000 },
    })
    expect(factById(summary.facts, "command")?.value).toEqual({ kind: "mono", text: "pnpm test" })
    expect(factById(summary.facts, "maxRuntime")?.value).toEqual({ kind: "duration", ms: 600_000 })
  })

  it("reads a script's seconds-based timeout as a duration", () => {
    const summary = summarizeTaskPayload({
      type: "script",
      payload: { language: "python", code: "print(1)", working_dir: "/w", timeout_secs: 30 },
    })
    expect(factById(summary.facts, "timeout")?.value).toEqual({ kind: "duration", ms: 30_000 })
    expect(factById(summary.facts, "cwd")?.value).toEqual({ kind: "mono", text: "/w" })
  })

  it("reads goal limits from the nested config", () => {
    const summary = summarizeTaskPayload({
      type: "goal",
      payload: { objective: "Ship it", config: { maxTurns: 5, timeoutMs: 60_000 } },
    })
    expect(factById(summary.facts, "objective")?.value).toEqual({
      kind: "multiline",
      text: "Ship it",
    })
    expect(factById(summary.facts, "maxTurns")?.value).toEqual({ kind: "count", value: 5 })
    expect(factById(summary.facts, "timeout")?.value).toEqual({ kind: "duration", ms: 60_000 })
  })

  it("keeps IM segments only when there are some", () => {
    const withText = summarizeTaskPayload({
      type: "im-push",
      payload: { conversationKey: "lark:oc_1", text: "hi", segments: [] },
    })
    expect(factById(withText.facts, "segments")).toBeUndefined()
    const withSegments = summarizeTaskPayload({
      type: "im-push",
      payload: { conversationKey: "lark:oc_1", segments: [{ type: "text", text: "hi" }] },
    })
    expect(factById(withSegments.facts, "segments")?.value.kind).toBe("json")
  })

  it("parses a monitor's expiry into an instant and drops one it cannot parse", () => {
    const at = Date.UTC(2026, 9, 3, 12)
    const summary = summarizeTaskPayload({
      type: "monitor",
      payload: { label: "watch", condition: { kind: "x" }, expiresAt: at },
    })
    expect(factById(summary.facts, "expiresAt")?.value).toEqual({ kind: "date", at })
    const bad = summarizeTaskPayload({ type: "monitor", payload: { expiresAt: "not a date" } })
    expect(factById(bad.facts, "expiresAt")).toBeUndefined()
  })

  it("returns no facts but keeps the raw payload for a type it has no reading for", () => {
    const summary = summarizeTaskPayload({
      type: "twin",
      payload: { mode: "distill" },
    } as never)
    expect(summary.facts).toEqual([])
    expect(summary.raw).toEqual({ mode: "distill" })
  })

  it("treats a missing or non-object payload as empty", () => {
    expect(summarizeTaskPayload({ type: "chat", payload: undefined }).raw).toBeUndefined()
    expect(summarizeTaskPayload({ type: "chat", payload: undefined }).facts).toEqual([])
  })
})
