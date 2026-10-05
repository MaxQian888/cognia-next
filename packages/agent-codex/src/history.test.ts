import {
  CODEX_HISTORY_FORMAT,
  detectCodexRollouts,
  isCodexRolloutFileName,
  parseCodexRollout,
  summarizeCodexRollout,
} from "./history"

const host = { redactText: (text: string) => text.replace(/alice@example\.com/g, "[email]") }
const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n")

const ROLLOUT = jsonl([
  {
    timestamp: "2025-01-03T12:00:00Z",
    type: "session_meta",
    payload: { id: "cx-1", cwd: "/work", model: "gpt-5", cli_version: "0.150.1" },
  },
  {
    timestamp: "2025-01-03T12:00:01Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "fix the bug" }],
    },
  },
  {
    timestamp: "2025-01-03T12:00:02Z",
    type: "response_item",
    payload: { type: "reasoning", summary: "thinking about it" },
  },
  {
    timestamp: "2025-01-03T12:00:03Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" },
  },
  {
    timestamp: "2025-01-03T12:00:04Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: "a.txt\nb.txt" },
  },
  {
    timestamp: "2025-01-03T12:00:05Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  },
  { timestamp: "2025-01-03T12:00:06Z", type: "response_item", payload: { type: "ghost_snapshot" } },
])

describe("parseCodexRollout", () => {
  it("rebuilds the transcript as neutral parts", () => {
    const parsed = parseCodexRollout(ROLLOUT, "rollout.jsonl", host)
    expect(parsed).toMatchObject({
      sourceId: "codex",
      originalSessionId: "cx-1",
      cwd: "/work",
      model: "gpt-5",
      title: "fix the bug",
      sourceVersion: "0.150.1",
      createdAt: Date.parse("2025-01-03T12:00:00Z"),
      updatedAt: Date.parse("2025-01-03T12:00:06Z"),
    })
    expect(parsed.messages.map((message) => [message.role, message.parts[0]])).toEqual([
      ["user", { type: "text", text: "fix the bug" }],
      ["assistant", { type: "reasoning", text: "thinking about it" }],
      [
        "assistant",
        {
          type: "tool",
          name: "shell",
          toolCallId: "c1",
          input: { cmd: "ls" },
          result: { ok: true, output: "a.txt\nb.txt" },
        },
      ],
      ["assistant", { type: "text", text: "done" }],
    ])
    expect(parsed.losses).toEqual([
      expect.objectContaining({ path: "response_item.ghost_snapshot", kind: "approximated" }),
    ])
  })

  it("falls back to the locator when the rollout records no session id", () => {
    const parsed = parseCodexRollout(
      jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }]),
      "/x/rollout.jsonl",
      host
    )
    expect(parsed.originalSessionId).toBe("/x/rollout.jsonl")
  })

  it("records a failed tool result as an error with the recorded text", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1" } },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c1",
            output: { output: "nope", metadata: { exit_code: 1 } },
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages[0].parts[0]).toMatchObject({
      type: "tool",
      result: { ok: false, errorText: "nope" },
    })
  })

  it("keeps commentary separate from the final answer", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: {
            id: "c-1",
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking" }],
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages[0].parts).toEqual([
      { type: "commentary", text: "Checking", messageId: "c-1", source: "codex" },
    ])
  })

  it("attaches per-turn usage, deriving deltas from cumulative totals", () => {
    const assistant = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    })
    const total = (input: number, output: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    })
    const parsed = parseCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "cx", model: "gpt-5" } },
        assistant("one"),
        total(100, 30),
        assistant("two"),
        total(250, 70),
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages.map((message) => [message.usage, message.usageModel])).toEqual([
      [{ inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 0 }, "gpt-5"],
      [{ inputTokens: 150, outputTokens: 40, cacheReadInputTokens: 0 }, "gpt-5"],
    ])
  })

  it("maps current shell, search, image and tool-search items with their statuses", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: { type: "local_shell_call", call_id: "s1", action: { command: ["pwd"] } },
        },
        {
          type: "response_item",
          payload: { id: "w1", type: "web_search_call", status: "completed", action: { q: "x" } },
        },
        {
          type: "response_item",
          payload: { id: "i1", type: "image_generation_call", status: "failed", result: "YWJj" },
        },
        {
          type: "response_item",
          payload: { type: "tool_search_call", call_id: "t1", arguments: { query: "cal" } },
        },
        {
          type: "response_item",
          payload: { type: "tool_search_output", call_id: "t1", status: "completed", tools: [1] },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.messages.map((message) => message.parts[0])).toEqual([
      {
        type: "tool",
        name: "local_shell",
        toolCallId: "s1",
        input: { command: ["pwd"] },
        status: "running",
      },
      {
        type: "tool",
        name: "web_search",
        toolCallId: "w1",
        input: { q: "x" },
        result: { ok: true, output: { status: "completed" } },
        status: "completed",
      },
      {
        type: "tool",
        name: "image_generation",
        toolCallId: "i1",
        input: { revisedPrompt: undefined },
        result: { ok: false, errorText: '{"base64":"YWJj","status":"failed"}' },
        status: "failed",
      },
      {
        type: "tool",
        name: "tool_search",
        toolCallId: "t1",
        input: { query: "cal" },
        result: { ok: true, output: [1] },
        status: "completed",
      },
    ])
  })

  it("routes inter-agent messages and keeps their routing as annotations", () => {
    const parsed = parseCodexRollout(
      jsonl([
        {
          type: "response_item",
          payload: {
            id: "m1",
            type: "agent_message",
            author: "root",
            recipient: "child",
            content: [{ type: "input_text", text: "continue" }],
          },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.interAgentMessages).toEqual([
      {
        messageId: "m1",
        fromSessionId: "root",
        toSessionId: "child",
        text: "continue",
        at: undefined,
      },
    ])
    expect(parsed.messages[0]).toMatchObject({
      role: "system",
      annotations: { codexAgentMessage: { author: "root", recipient: "child" } },
    })
  })

  it("records fork and subagent lineage from the session meta", () => {
    const fork = parseCodexRollout(
      jsonl([{ type: "session_meta", payload: { id: "b", forked_from_id: "a" } }]),
      "r",
      host
    )
    expect(fork).toMatchObject({ relationKind: "fork", parentNativeSessionId: "a" })
    const child = parseCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "c", source: { x: { parent_thread_id: "a" } } } },
      ]),
      "r",
      host
    )
    expect(child).toMatchObject({ relationKind: "subagent", parentNativeSessionId: "a" })
  })

  it("passes every retained diagnostic string through the host redactor", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { type: "event_msg", payload: { type: "brand_new_event", note: "mail alice@example.com" } },
      ]),
      "r.jsonl",
      host
    )
    expect(JSON.stringify(parsed.recordedEvents)).not.toContain("alice@example.com")
    expect(JSON.stringify(parsed.recordedEvents)).toContain("[email]")
    expect(parsed.losses).toEqual([
      expect.objectContaining({ path: "event_msg.brand_new_event", kind: "approximated" }),
    ])
  })

  it("reports unparseable lines as dropped instead of failing", () => {
    const parsed = parseCodexRollout(`${ROLLOUT}\n{oops`, "r.jsonl", host)
    expect(parsed.messages.length).toBe(4)
    expect(parsed.losses).toContainEqual(expect.objectContaining({ kind: "dropped" }))
  })

  it("tracks lifecycle, plans, goals, compaction and rollback", () => {
    const parsed = parseCodexRollout(
      jsonl([
        { timestamp: "2025-01-01T00:00:00Z", type: "event_msg", payload: { type: "turn_started" } },
        {
          type: "event_msg",
          payload: {
            type: "plan_update",
            plan: [
              { step: "inspect", status: "completed" },
              { step: "patch", status: "pending" },
            ],
          },
        },
        { type: "event_msg", payload: { type: "goal_update", goal: "ship", status: "done" } },
        { type: "event_msg", payload: { type: "context_compacted" } },
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 2 } },
        {
          timestamp: "2025-01-01T00:01:00Z",
          type: "event_msg",
          payload: { type: "turn_complete" },
        },
      ]),
      "r.jsonl",
      host
    )
    expect(parsed.lifecycle).toMatchObject({ status: "completed" })
    expect(parsed.plans[0]).toMatchObject({ status: "active", steps: ["inspect", "patch"] })
    expect(parsed.goals[0]).toMatchObject({ description: "ship", status: "completed" })
    expect(parsed.history.map((event) => event.kind)).toEqual(["compaction", "rollback"])
  })
})

describe("summarizeCodexRollout", () => {
  it("summarises without a full parse", () => {
    expect(summarizeCodexRollout(ROLLOUT, "rollout.jsonl")).toEqual({
      sourceId: "codex",
      originalSessionId: "cx-1",
      title: "fix the bug",
      messageCount: 4,
      updatedAt: Date.parse("2025-01-03T12:00:06Z"),
      cwd: "/work",
      sourceVersion: "0.150.1",
      relationKind: undefined,
    })
  })

  it("falls back to a per-line parse for spaced JSON and agrees with the fast path", () => {
    const spaced = ROLLOUT.split("\n")
      .map((line) => JSON.stringify(JSON.parse(line), null, 1).replace(/\n/g, ""))
      .join("\n")
    expect(summarizeCodexRollout(spaced, "rollout.jsonl")).toMatchObject({
      originalSessionId: "cx-1",
      title: "fix the bug",
      messageCount: 4,
    })
  })

  it("defaults the version to the verified one and returns null for an empty file", () => {
    const summary = summarizeCodexRollout(
      jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }]),
      "r"
    )
    expect(summary?.sourceVersion).toBe(CODEX_HISTORY_FORMAT.verifiedVersion)
    expect(summarizeCodexRollout("", "r")).toBeNull()
  })

  it("carries the parent id so a picker can hide children without parsing them", () => {
    const summary = summarizeCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "c", parent_thread_id: "p" } },
        { type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
      ]),
      "r"
    )
    expect(summary).toMatchObject({ relationKind: "subagent", parentNativeSessionId: "p" })
  })
})

describe("format detection", () => {
  it("matches rollout names and paths, and sniffs content otherwise", () => {
    expect(isCodexRolloutFileName("rollout-1.JSONL")).toBe(true)
    expect(isCodexRolloutFileName("notes.md")).toBe(false)
    expect(detectCodexRollouts([])).toBe("no")
    expect(
      detectCodexRollouts([{ path: "/h/.codex/sessions/a.jsonl", name: "a.jsonl", content: "" }])
    ).toBe("match")
    expect(
      detectCodexRollouts([
        { path: "/x/rollout-1.jsonl", name: "rollout-1.jsonl", content: "" },
        { path: "/x/other.txt", name: "other.txt", content: "" },
      ])
    ).toBe("maybe")
    expect(
      detectCodexRollouts([
        { path: "/x/a.jsonl", name: "a.jsonl", content: '{"type":"session_meta","payload":{}}' },
      ])
    ).toBe("maybe")
    expect(detectCodexRollouts([{ path: "/x/a.txt", name: "a.txt", content: "plain" }])).toBe("no")
  })
})
