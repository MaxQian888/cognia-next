import type { SDKMessage } from "@cognia/agent-config-types"

import {
  canonicalEventsFromSdkMessage,
  filterChatCanonicalEvents,
  isResidentChatEventKind,
  DELTA_CHAT_EVENT_KINDS,
  NO_CAPTURE,
  PROMPT_CHAT_EVENT_KINDS,
  RESIDENT_CHAT_EVENT_KINDS,
  type ChatCanonicalCaptureTiers,
} from "./canonical-projection"

const ALL_TIERS: ChatCanonicalCaptureTiers = {
  deltas: true,
  prompts: true,
  toolDetails: true,
}

function sdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage
}

describe("canonicalEventsFromSdkMessage — assistant frames", () => {
  const toolUse = sdk({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/etc/passwd" } },
      ],
    },
  })

  it("records the tool call without its arguments by default", () => {
    const events = canonicalEventsFromSdkMessage(toolUse, NO_CAPTURE)
    expect(events).toEqual([
      { kind: "tool-call", toolName: "Read", input: {}, toolCallId: "toolu_1" },
    ])
    // Arguments are the largest and most sensitive thing a call carries.
    expect(JSON.stringify(events)).not.toContain("/etc/passwd")
  })

  it("records arguments and text once the tiers are armed", () => {
    const events = canonicalEventsFromSdkMessage(toolUse, ALL_TIERS)
    expect(events).toContainEqual({ kind: "text-delta", delta: "let me check" })
    expect(events).toContainEqual({
      kind: "tool-call",
      toolName: "Read",
      input: { file_path: "/etc/passwd" },
      toolCallId: "toolu_1",
    })
  })

  it("captures thinking blocks only under the deltas tier", () => {
    const message = sdk({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }] },
    })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([])
    expect(canonicalEventsFromSdkMessage(message, ALL_TIERS)).toEqual([
      { kind: "thinking-delta", delta: "hmm" },
    ])
  })

  it("ignores blocks that are not objects or lack a name", () => {
    const message = sdk({
      type: "assistant",
      message: { content: [null, "text", { type: "tool_use", id: "x" }] },
    })
    expect(canonicalEventsFromSdkMessage(message, ALL_TIERS)).toEqual([])
  })
})

describe("canonicalEventsFromSdkMessage — tool results", () => {
  const result = sdk({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "root:x:0:0:root:/root:/bin/sh" },
      ],
    },
  })

  it("summarises the body by size instead of storing it", () => {
    const [event] = canonicalEventsFromSdkMessage(result, NO_CAPTURE)
    expect(event).toEqual({
      kind: "tool-result",
      toolName: "unknown",
      toolCallId: "toolu_1",
      result: { omitted: true, sizeBytes: 29 },
    })
    // A reader can still tell a 4-byte result from a 400KB one.
    expect(JSON.stringify(event)).not.toContain("root:x:0:0")
  })

  it("stores the body under the toolDetails tier", () => {
    const [event] = canonicalEventsFromSdkMessage(result, ALL_TIERS)
    expect(event).toMatchObject({ result: "root:x:0:0:root:/root:/bin/sh" })
  })

  it("flags an error result", () => {
    const errored = sdk({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "nope", is_error: true }],
      },
    })
    expect(canonicalEventsFromSdkMessage(errored, NO_CAPTURE)[0]).toMatchObject({ isError: true })
  })

  it("reports an unserializable body as omitted rather than throwing", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const message = sdk({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: circular }] },
    })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)[0]).toMatchObject({
      result: { omitted: true, unserializable: true },
    })
  })
})

describe("canonicalEventsFromSdkMessage — result frames", () => {
  it("emits normalised usage with the SDK's own cost", () => {
    const message = sdk({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.0125,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
      },
    })
    const [event] = canonicalEventsFromSdkMessage(message, NO_CAPTURE)
    expect(event).toMatchObject({ kind: "usage" })
    const usage = (event as { usage: Record<string, unknown> }).usage
    expect(usage.total_cost_usd).toBe(0.0125)
    expect(usage.input_tokens).toBe(100)
    // The TTL split survives the projection — it is the only signal separating
    // a 1.25x cache write from a 2x one.
    expect(usage.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 10,
      ephemeral_1h_input_tokens: 5,
    })
  })

  it("emits a failure for an errored turn", () => {
    const message = sdk({ type: "result", subtype: "error_max_turns", is_error: true })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([
      { kind: "failure", code: "chat_error_max_turns", message: "error_max_turns" },
    ])
  })
})

describe("canonicalEventsFromSdkMessage — system frames", () => {
  it("captures the session preamble", () => {
    const message = sdk({
      type: "system",
      subtype: "init",
      model: "claude-opus-5",
      cwd: "/work",
      tools: ["Read", "Bash"],
      mcp_servers: [{ name: "lark", status: "connected" }, { name: "" }],
      permissionMode: "default",
    })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([
      {
        kind: "session-init",
        model: "claude-opus-5",
        cwd: "/work",
        tools: ["Read", "Bash"],
        mcpServers: [{ name: "lark", status: "connected" }],
        permissionMode: "default",
      },
    ])
  })

  it("captures compaction with its token counts", () => {
    const message = sdk({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 12_000 },
    })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([
      { kind: "compact", trigger: "auto", preTokens: 90_000, postTokens: 12_000 },
    ])
  })

  it("captures subagent start and end", () => {
    expect(
      canonicalEventsFromSdkMessage(
        sdk({ type: "system", subtype: "task_started", subagent_type: "Explore" }),
        NO_CAPTURE
      )
    ).toEqual([{ kind: "subagent", phase: "started", runtimeBinding: "Explore" }])
    expect(
      canonicalEventsFromSdkMessage(
        sdk({ type: "system", subtype: "task_completed", subagent_type: "Explore" }),
        NO_CAPTURE
      )
    ).toEqual([{ kind: "subagent", phase: "ended", runtimeBinding: "Explore" }])
  })

  it("keeps a task description out of the log unless prompts are armed", () => {
    const message = sdk({
      type: "system",
      subtype: "task_started",
      description: "find the leaked key in src/",
    })
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([
      { kind: "subagent", phase: "started" },
    ])
    expect(canonicalEventsFromSdkMessage(message, ALL_TIERS)).toEqual([
      { kind: "subagent", phase: "started", runtimeBinding: "find the leaked key in src/" },
    ])
  })

  it("returns nothing for an unknown subtype", () => {
    expect(
      canonicalEventsFromSdkMessage(sdk({ type: "system", subtype: "whatever" }), ALL_TIERS)
    ).toEqual([])
  })
})

describe("canonicalEventsFromSdkMessage — stream events", () => {
  const message = sdk({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  })

  it("drops deltas by default", () => {
    // A single long turn emits tens of thousands of these.
    expect(canonicalEventsFromSdkMessage(message, NO_CAPTURE)).toEqual([])
  })

  it("keeps deltas once armed", () => {
    expect(canonicalEventsFromSdkMessage(message, ALL_TIERS)).toEqual([
      { kind: "text-delta", delta: "hi" },
    ])
  })
})

describe("canonicalEventsFromSdkMessage — malformed input", () => {
  it("returns nothing rather than throwing", () => {
    expect(canonicalEventsFromSdkMessage(null as unknown as SDKMessage)).toEqual([])
    expect(canonicalEventsFromSdkMessage(sdk({ type: "unknown_type" }))).toEqual([])
    expect(canonicalEventsFromSdkMessage(sdk({ type: "assistant" }))).toEqual([])
  })
})

describe("filterChatCanonicalEvents", () => {
  it("keeps resident kinds with nothing armed", () => {
    const events = [
      { kind: "tool-call" as const, toolName: "Read", input: {} },
      { kind: "text-delta" as const, delta: "x" },
      { kind: "user-input" as const, text: "secret prompt" },
    ]
    expect(filterChatCanonicalEvents(events, NO_CAPTURE)).toEqual([events[0]])
  })

  it("keeps everything with every tier armed", () => {
    const events = [
      { kind: "text-delta" as const, delta: "x" },
      { kind: "user-input" as const, text: "prompt" },
    ]
    expect(filterChatCanonicalEvents(events, ALL_TIERS)).toEqual(events)
  })

  it("keeps an unrecognised semantic kind rather than dropping it silently", () => {
    // The resident set names what we are SURE is worth storing; dropping the
    // rest is how a log stops being trustworthy.
    const events = [{ kind: "rate-limit" as const, scope: "session", message: "slow down" }]
    expect(filterChatCanonicalEvents(events as never, NO_CAPTURE)).toHaveLength(1)
  })
})

describe("kind sets", () => {
  it("keeps the resident set disjoint from the gated sets", () => {
    for (const kind of RESIDENT_CHAT_EVENT_KINDS) {
      expect(DELTA_CHAT_EVENT_KINDS.has(kind)).toBe(false)
      expect(PROMPT_CHAT_EVENT_KINDS.has(kind)).toBe(false)
    }
  })

  it("excludes the prompt, which `messages` already stores verbatim", () => {
    expect(isResidentChatEventKind("user-input")).toBe(false)
    expect(isResidentChatEventKind("lifecycle")).toBe(true)
    expect(isResidentChatEventKind("usage")).toBe(true)
  })
})
