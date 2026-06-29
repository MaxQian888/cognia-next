import type { UIMessage } from "ai"

import {
  applySdkEvent,
  contentPreview,
  makeUserMessage,
  mergeMemorySourcesIntoLastAssistant,
  mergeTwinSourcesIntoLastAssistant,
} from "./adapter"
import type { SourcesPart, SourcesPartItem } from "./parts-extensions"
import type {
  BetaMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SendContent,
} from "./types"

function asAssistant(message: BetaMessage, uuid = "evt-1"): SDKAssistantMessage {
  return { type: "assistant", message, uuid } as unknown as SDKAssistantMessage
}

function asResult(extra: Partial<SDKResultMessage> & Record<string, unknown>): SDKResultMessage {
  return { type: "result", ...extra } as unknown as SDKResultMessage
}

describe("applySdkEvent — assistant", () => {
  it("appends a fresh assistant message with text and thinking parts", () => {
    const evt = asAssistant({
      id: "asst-1",
      content: [
        { type: "text", text: "hi there" },
        { type: "thinking", thinking: "let me think" },
      ],
    } as unknown as BetaMessage)
    const { messages, turnComplete } = applySdkEvent([], evt)
    expect(turnComplete).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe("asst-1")
    expect(messages[0].role).toBe("assistant")
    expect(messages[0].parts).toHaveLength(2)
    expect((messages[0].parts[0] as { type: string; text: string }).text).toBe("hi there")
    expect((messages[0].parts[1] as { type: string }).type).toBe("reasoning")
  })

  it("represents tool_use blocks with `tool-{name}` parts", () => {
    const evt = asAssistant({
      id: "asst-2",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }],
    } as unknown as BetaMessage)
    const { messages } = applySdkEvent([], evt)
    const part = messages[0].parts[0] as {
      type: string
      toolCallId: string
      input: unknown
      state: string
    }
    expect(part.type).toBe("tool-Read")
    expect(part.toolCallId).toBe("t1")
    expect(part.state).toBe("input-available")
    expect(part.input).toEqual({ path: "/x" })
  })

  it("converts artifact_create tool_use into an ArtifactPart", () => {
    const evt = asAssistant({
      id: "asst-art-1",
      content: [
        {
          type: "tool_use",
          id: "art-tool-1",
          name: "artifact_create",
          input: {
            id: "art-1",
            title: "demo.md",
            type: "document",
            content: "# Hello",
          },
        },
      ],
    } as unknown as BetaMessage)
    const { messages } = applySdkEvent([], evt)
    const part = messages[0].parts[0] as {
      type: string
      artifactId: string
      title: string
      kind: string
    }
    expect(part.type).toBe("artifact")
    expect(part.artifactId).toBe("art-1")
    expect(part.title).toBe("demo.md")
    expect(part.kind).toBe("document")
  })

  it("falls back to evt.uuid when message.id is missing", () => {
    const evt = asAssistant(
      { content: [{ type: "text", text: "x" }] } as unknown as BetaMessage,
      "uuid-fallback"
    )
    const { messages } = applySdkEvent([], evt)
    expect(messages[0].id).toBe("uuid-fallback")
  })

  it("replaces a prior partial assistant version of the same id (in place)", () => {
    const initial = asAssistant({
      id: "asst-3",
      content: [{ type: "text", text: "stream a" }],
    } as unknown as BetaMessage)
    const { messages: a } = applySdkEvent([], initial)

    const updated = asAssistant({
      id: "asst-3",
      content: [{ type: "text", text: "stream a + b" }],
    } as unknown as BetaMessage)
    const { messages: b } = applySdkEvent(a, updated)
    expect(b).toHaveLength(1)
    expect((b[0].parts[0] as { text: string }).text).toBe("stream a + b")
  })

  it("ignores blocks with unknown types instead of throwing", () => {
    const evt = asAssistant({
      id: "asst-x",
      content: [{ type: "text", text: "ok" }, { type: "weird-future" } as unknown as never],
    } as unknown as BetaMessage)
    const { messages } = applySdkEvent([], evt)
    expect(messages[0].parts).toHaveLength(1)
  })

  it("treats missing text / thinking strings as empty", () => {
    const evt = asAssistant({
      id: "asst-y",
      content: [{ type: "text" } as unknown as never, { type: "thinking" } as unknown as never],
    } as unknown as BetaMessage)
    const { messages } = applySdkEvent([], evt)
    expect((messages[0].parts[0] as { text: string }).text).toBe("")
    expect((messages[0].parts[1] as { text: string }).text).toBe("")
  })
})

describe("applySdkEvent — compact boundary", () => {
  const boundary = (extra: Record<string, unknown> = {}) =>
    ({
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb-1",
      session_id: "s",
      compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 200 },
      ...extra,
    }) as unknown as SDKResultMessage // narrow local SDKMessage union; cast for the test

  it("appends a system compact-boundary marker carrying the metadata", () => {
    const { messages, turnComplete } = applySdkEvent([], boundary())
    expect(turnComplete).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("system")
    expect(messages[0].id).toBe("compact-cb-1")
    const part = messages[0].parts[0] as {
      type: string
      trigger?: string
      preTokens?: number
      postTokens?: number
    }
    expect(part.type).toBe("compact-boundary")
    expect(part.trigger).toBe("auto")
    expect(part.preTokens).toBe(1000)
    expect(part.postTokens).toBe(200)
  })

  it("registers an undo snapshot and tags the part when pre_messages are present", async () => {
    const { hasUndoSnapshot, getUndoSnapshot, __resetUndoRegistryForTesting } =
      await import("./compaction-undo")
    __resetUndoRegistryForTesting()
    const { messages } = applySdkEvent(
      [],
      boundary({
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 1000,
          post_tokens: 200,
          strategy: "selective",
          pre_messages: [{ role: "user", content: "m0" }],
        },
      })
    )
    const part = messages[0].parts[0] as { strategy?: string; undoToken?: string }
    expect(part.strategy).toBe("selective")
    expect(part.undoToken).toBe("compact-cb-1")
    expect(hasUndoSnapshot("compact-cb-1")).toBe(true)
    expect(getUndoSnapshot("compact-cb-1")?.snapshot).toHaveLength(1)
  })

  it("does not tag an undo token when no snapshot was captured", () => {
    const { messages } = applySdkEvent([], boundary())
    const part = messages[0].parts[0] as { undoToken?: string }
    expect(part.undoToken).toBeUndefined()
  })

  it("leaves other system messages (init) untouched", () => {
    const existing = [{ id: "u1", role: "user", parts: [] }] as unknown as UIMessage[]
    const evt = { type: "system", subtype: "init", session_id: "s" } as unknown as SDKResultMessage
    const { messages } = applySdkEvent(existing, evt)
    expect(messages).toBe(existing)
  })

  it("falls back to a generated id when the boundary carries no uuid", () => {
    const { messages } = applySdkEvent([], boundary({ uuid: undefined }))
    expect(messages[0].id).toMatch(/^compact-/)
    expect(messages[0].id.length).toBeGreaterThan("compact-".length)
  })
})

describe("applySdkEvent — hook fire", () => {
  const hookFire = (extra: Record<string, unknown> = {}) =>
    ({
      type: "system",
      subtype: "hook_fire",
      hook_event: "PreToolUse",
      tool_name: "Bash",
      outcome: "blocked",
      block: "command matches denylist",
      additional_context: null,
      warnings: ["hook timed out after 5000ms"],
      ...extra,
    }) as unknown as SDKResultMessage

  it("projects a consequential fire into a system hook-notice marker", () => {
    const { messages, turnComplete } = applySdkEvent([], hookFire())
    expect(turnComplete).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("system")
    expect(messages[0].id).toMatch(/^hook-PreToolUse-/)
    const part = messages[0].parts[0] as {
      type: string
      event: string
      toolName?: string
      outcome: string
      block?: string
      additionalContext?: string
      warnings: string[]
    }
    expect(part.type).toBe("hook-notice")
    expect(part.event).toBe("PreToolUse")
    expect(part.toolName).toBe("Bash")
    expect(part.outcome).toBe("blocked")
    expect(part.block).toBe("command matches denylist")
    expect(part.additionalContext).toBeFalsy()
    expect(part.warnings).toEqual(["hook timed out after 5000ms"])
  })

  it("maps a context fire with no tool name", () => {
    const { messages } = applySdkEvent(
      [],
      hookFire({
        hook_event: "UserPromptSubmit",
        tool_name: undefined,
        outcome: "context",
        block: undefined,
        additional_context: "loaded 1.2KB of context",
        warnings: [],
      })
    )
    const part = messages[0].parts[0] as unknown as {
      outcome: string
      toolName?: string
      warnings: string[]
    }
    expect(part.outcome).toBe("context")
    expect(part.toolName).toBeUndefined()
    expect(part.warnings).toEqual([])
  })

  it("defaults a missing outcome to warning and missing warnings to []", () => {
    const { messages } = applySdkEvent(
      [],
      hookFire({ outcome: undefined, block: undefined, warnings: undefined })
    )
    const part = messages[0].parts[0] as unknown as { outcome: string; warnings: string[] }
    expect(part.outcome).toBe("warning")
    expect(part.warnings).toEqual([])
  })
})

describe("applySdkEvent — permission denied dedup", () => {
  const permDenied = (reason: string) =>
    ({
      type: "system",
      subtype: "permission_denied",
      uuid: "pd-1",
      tool_name: "Bash",
      decision_reason: reason,
    }) as unknown as SDKResultMessage

  it("suppresses the notice when the denial came from a hook", () => {
    const existing = [{ id: "u1", role: "user", parts: [] }] as unknown as UIMessage[]
    const { messages } = applySdkEvent(
      existing,
      permDenied("hook denied: command matches denylist")
    )
    // The hook_fire row already covers it — no extra session notice appended.
    expect(messages).toBe(existing)
  })

  it("still appends a session notice for a non-hook denial", () => {
    const { messages } = applySdkEvent([], permDenied("classifier auto-denied"))
    expect(messages).toHaveLength(1)
    const part = messages[0].parts[0] as { type: string; variant: string; reason?: string }
    expect(part.type).toBe("session-notice")
    expect(part.variant).toBe("permission-denied")
    expect(part.reason).toBe("classifier auto-denied")
  })
})

describe("applySdkEvent — user (tool results)", () => {
  function userToolResult(blocks: unknown[]): SDKUserMessage {
    return {
      type: "user",
      message: { content: blocks },
    } as unknown as SDKUserMessage
  }

  it("ignores plain string user messages — those are rendered locally", () => {
    const evt = {
      type: "user",
      message: { content: "hello" },
    } as unknown as SDKUserMessage
    const messages: UIMessage[] = [
      {
        id: "x",
        role: "assistant",
        parts: [],
      } as UIMessage,
    ]
    const result = applySdkEvent(messages, evt)
    expect(result.messages).toBe(messages)
    expect(result.turnComplete).toBe(false)
  })

  it("ignores user messages whose content array has no tool_results", () => {
    const messages: UIMessage[] = [{ id: "x", role: "assistant", parts: [] } as UIMessage]
    const result = applySdkEvent(messages, userToolResult([{ type: "text", text: "hi" }]))
    expect(result.messages).toBe(messages)
  })

  it("patches the matching tool_use part with the tool_result string", () => {
    const assistant: UIMessage = {
      id: "asst-z",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "t-1",
          state: "input-available",
          input: { path: "/x" },
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        { type: "tool_result", tool_use_id: "t-1", content: "ok body", is_error: false },
      ])
    )
    expect(result.messages[0].parts).toHaveLength(1)
    const part = result.messages[0].parts[0] as {
      state: string
      output?: string
      errorText?: string
    }
    expect(part.state).toBe("output-available")
    expect(part.output).toBe("ok body")
    expect(part.errorText).toBeUndefined()
  })

  it("flags an error result with output-error / errorText", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-Bash",
          toolCallId: "t-2",
          state: "input-available",
          input: { command: "ls" },
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([{ type: "tool_result", tool_use_id: "t-2", content: "boom", is_error: true }])
    )
    const part = result.messages[0].parts[0] as { state: string; errorText?: string }
    expect(part.state).toBe("output-error")
    expect(part.errorText).toBe("boom")
  })

  it("flattens array-of-text-blocks tool_result content", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "t-3",
          state: "input-available",
          input: { path: "/x" },
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t-3",
          content: [
            { type: "text", text: "alpha" },
            "beta",
            { type: "image", source: { data: "abc" } },
            null,
          ],
          is_error: false,
        },
      ])
    )
    const part = result.messages[0].parts[0] as { output?: string }
    // alpha + beta + JSON.stringify(image-block) + JSON.stringify(null)? null
    // is filtered into "" by the helper.
    expect(part.output).toContain("alpha")
    expect(part.output).toContain("beta")
    expect(part.output).toContain("image")
  })

  it("falls back to JSON.stringify for non-string/non-array content", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "t-4",
          state: "input-available",
          input: {},
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t-4",
          content: { foo: "bar" },
          is_error: false,
        },
      ])
    )
    const part = result.messages[0].parts[0] as { output?: string }
    expect(part.output).toBe('{"foo":"bar"}')
  })

  it("preserves structured mcpContent when the result carries a non-text block (gap3)", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-mcp__some-server__capture",
          toolCallId: "t-mcp",
          state: "input-available",
          input: {},
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t-mcp",
          content: [
            { type: "text", text: "here is the screenshot" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
          is_error: false,
        },
      ])
    )
    const part = result.messages[0].parts[0] as {
      output?: string
      mcpContent?: Array<{ type: string }>
    }
    // flattened string still present for back-compat
    expect(part.output).toContain("here is the screenshot")
    // structured blocks preserved verbatim
    expect(part.mcpContent).toHaveLength(2)
    expect(part.mcpContent?.[1]?.type).toBe("image")
  })

  it("does NOT attach mcpContent for a pure-text array result (no behavior change)", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "t-txt",
          state: "input-available",
          input: {},
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t-txt",
          content: [
            { type: "text", text: "alpha" },
            { type: "text", text: "beta" },
          ],
          is_error: false,
        },
      ])
    )
    const part = result.messages[0].parts[0] as { mcpContent?: unknown }
    expect(part.mcpContent).toBeUndefined()
  })

  it("does NOT attach mcpContent for an error result", () => {
    const assistant: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-mcp__x__y",
          toolCallId: "t-err",
          state: "input-available",
          input: {},
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage
    const result = applySdkEvent(
      [assistant],
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t-err",
          content: [{ type: "image", source: { data: "AAAA" } }],
          is_error: true,
        },
      ])
    )
    const part = result.messages[0].parts[0] as { mcpContent?: unknown; state: string }
    expect(part.state).toBe("output-error")
    expect(part.mcpContent).toBeUndefined()
  })

  it("returns the original list unchanged when the tool_use_id matches nothing", () => {
    const messages: UIMessage[] = [
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-Read",
            toolCallId: "real-id",
            state: "input-available",
            input: {},
          } as unknown as UIMessage["parts"][number],
        ],
      } as UIMessage,
    ]
    const result = applySdkEvent(
      messages,
      userToolResult([
        { type: "tool_result", tool_use_id: "ghost-id", content: "x", is_error: false },
      ])
    )
    expect(result.messages).toBe(messages)
  })

  it("ignores tool_result blocks whose tool_use_id matches a prior message that is not assistant", () => {
    const messages: UIMessage[] = [{ id: "u", role: "user", parts: [] } as UIMessage]
    const result = applySdkEvent(
      messages,
      userToolResult([{ type: "tool_result", tool_use_id: "x", content: "y", is_error: false }])
    )
    expect(result.messages).toBe(messages)
  })
})

describe("applySdkEvent — result", () => {
  it("attaches usage onto the latest assistant message", () => {
    const messages: UIMessage[] = [
      { id: "u", role: "user", parts: [] } as UIMessage,
      { id: "a", role: "assistant", parts: [] } as UIMessage,
    ]
    const result = applySdkEvent(
      messages,
      asResult({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
        },
        total_cost_usd: 0.05,
        duration_ms: 1234,
      })
    )
    expect(result.turnComplete).toBe(true)
    expect(result.result).toBeDefined()
    const meta = (result.messages[1] as { metadata?: Record<string, unknown> }).metadata as {
      usage?: Record<string, unknown>
    }
    expect(meta.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      totalCostUsd: 0.05,
      durationMs: 1234,
    })
  })

  it("surfaces reasoning_tokens (> 0) as reasoningTokens, ignoring a zero", () => {
    const withReasoning = applySdkEvent(
      [{ id: "a", role: "assistant", parts: [] } as UIMessage],
      asResult({ usage: { output_tokens: 40, reasoning_tokens: 32 } })
    )
    const meta1 = (withReasoning.messages[0] as { metadata?: { usage?: Record<string, unknown> } })
      .metadata
    expect(meta1?.usage?.reasoningTokens).toBe(32)

    const zeroReasoning = applySdkEvent(
      [{ id: "a", role: "assistant", parts: [] } as UIMessage],
      asResult({ usage: { output_tokens: 20, reasoning_tokens: 0 } })
    )
    const meta2 = (zeroReasoning.messages[0] as { metadata?: { usage?: Record<string, unknown> } })
      .metadata
    // A non-reasoning turn must not carry a noisy reasoningTokens: 0.
    expect(meta2?.usage?.reasoningTokens).toBeUndefined()
  })

  it("surfaces context_input_tokens (window prompt) only when it differs from input_tokens", () => {
    // ai-sdk multi-leg turn: input_tokens is the summed billing figure; the
    // window holds only the last leg → context_input_tokens carries it.
    const differs = applySdkEvent(
      [{ id: "a", role: "assistant", parts: [] } as UIMessage],
      asResult({ usage: { input_tokens: 3000, output_tokens: 40, context_input_tokens: 1000 } })
    )
    const m1 = (differs.messages[0] as { metadata?: { usage?: Record<string, unknown> } }).metadata
    expect(m1?.usage?.contextInputTokens).toBe(1000)

    // Single-leg turn where the two coincide → no redundant field attached.
    const same = applySdkEvent(
      [{ id: "a", role: "assistant", parts: [] } as UIMessage],
      asResult({ usage: { input_tokens: 1000, output_tokens: 40, context_input_tokens: 1000 } })
    )
    const m2 = (same.messages[0] as { metadata?: { usage?: Record<string, unknown> } }).metadata
    expect(m2?.usage?.contextInputTokens).toBeUndefined()
  })

  it("looks for usage under message.usage when the top-level usage is absent", () => {
    const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [] } as UIMessage]
    const result = applySdkEvent(
      messages,
      asResult({
        message: { usage: { input_tokens: 5 } },
      })
    )
    const meta = (result.messages[0] as { metadata?: Record<string, unknown> }).metadata as {
      usage?: Record<string, unknown>
    }
    expect(meta.usage).toEqual({
      inputTokens: 5,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      totalCostUsd: undefined,
      durationMs: undefined,
    })
  })

  it("merges with existing metadata instead of clobbering it", () => {
    const messages: UIMessage[] = [
      {
        id: "a",
        role: "assistant",
        parts: [],
        ...({ metadata: { other: "preserved" } } as Record<string, unknown>),
      } as UIMessage,
    ]
    const { messages: out } = applySdkEvent(messages, asResult({ usage: { input_tokens: 1 } }))
    const meta = (out[0] as { metadata?: Record<string, unknown> }).metadata as {
      other?: string
      usage?: Record<string, unknown>
    }
    expect(meta.other).toBe("preserved")
    expect(meta.usage).toBeDefined()
  })

  it("returns the same list when there is no assistant to attach to", () => {
    const messages: UIMessage[] = [{ id: "u", role: "user", parts: [] } as UIMessage]
    const out = applySdkEvent(messages, asResult({ usage: { input_tokens: 1 } }))
    expect(out.messages).toBe(messages)
    expect(out.turnComplete).toBe(true)
  })

  it("returns the same list when usage extraction yields nothing", () => {
    const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [] } as UIMessage]
    const out = applySdkEvent(messages, asResult({}))
    expect(out.messages).toBe(messages)
    expect(out.turnComplete).toBe(true)
  })

  it("treats a numeric total_cost_usd alone as enough to attach metadata", () => {
    const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [] } as UIMessage]
    const { messages: out } = applySdkEvent(
      messages,
      asResult({ total_cost_usd: 0.25, duration_ms: 100 })
    )
    const meta = (out[0] as { metadata?: Record<string, unknown> }).metadata as {
      usage?: Record<string, unknown>
    }
    expect(meta.usage).toBeDefined()
    expect((meta.usage as Record<string, unknown>).totalCostUsd).toBe(0.25)
  })

  it("ignores non-numeric usage fields", () => {
    const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [] } as UIMessage]
    const { messages: out } = applySdkEvent(
      messages,
      asResult({ usage: { input_tokens: "not-a-number" } })
    )
    // Result discards everything → no metadata to attach.
    const meta = (out[0] as { metadata?: Record<string, unknown> }).metadata
    expect(meta).toBeUndefined()
  })
})

describe("applySdkEvent — unknown event", () => {
  it("returns the messages unchanged with turnComplete false", () => {
    const messages: UIMessage[] = []
    const result = applySdkEvent(messages, { type: "weird" } as unknown as never)
    expect(result.messages).toBe(messages)
    expect(result.turnComplete).toBe(false)
  })
})

describe("makeUserMessage", () => {
  it("produces a single text part for a string content", () => {
    const msg = makeUserMessage("hello", "id-1")
    expect(msg.id).toBe("id-1")
    expect(msg.role).toBe("user")
    expect(msg.parts).toHaveLength(1)
    expect((msg.parts[0] as { type: string; text: string }).text).toBe("hello")
  })

  it("auto-generates an id when none is given", () => {
    const msg = makeUserMessage("hello")
    expect(msg.id).toMatch(/^user-\d+-[a-z0-9]+$/)
  })

  it("emits one part per content block (text + image)", () => {
    const blocks: SendContent = [
      { type: "text", text: "look at this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ]
    const msg = makeUserMessage(blocks, "id-2")
    expect(msg.parts).toHaveLength(2)
    expect((msg.parts[0] as { text: string }).text).toBe("look at this")
    const file = msg.parts[1] as { type: string; url: string; mediaType: string }
    expect(file.type).toBe("file")
    expect(file.url).toBe("data:image/png;base64,AAAA")
    expect(file.mediaType).toBe("image/png")
  })

  it("ignores unknown block kinds in a multimodal payload", () => {
    const msg = makeUserMessage(
      [{ type: "audio" } as unknown as never, { type: "text", text: "alpha" }],
      "id-3"
    )
    expect(msg.parts).toHaveLength(1)
    expect((msg.parts[0] as { text: string }).text).toBe("alpha")
  })
})

describe("contentPreview", () => {
  it("returns plain string content as-is when under the limit", () => {
    expect(contentPreview("hello")).toBe("hello")
  })

  it("truncates and adds an ellipsis when over the limit", () => {
    const long = "x".repeat(200)
    const out = contentPreview(long, 80)
    expect(out).toHaveLength(81)
    expect(out.endsWith("…")).toBe(true)
  })

  it("joins text blocks with spaces and ignores non-text blocks", () => {
    const blocks: SendContent = [
      { type: "text", text: "hi" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "x" },
      },
      { type: "text", text: "there" },
    ]
    expect(contentPreview(blocks)).toBe("hi there")
  })

  it("respects a custom max length", () => {
    expect(contentPreview("hello world", 5)).toBe("hello…")
  })
})

describe("mergeTwinSourcesIntoLastAssistant", () => {
  const baseMessages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" } as never] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" } as never] },
  ]

  it("returns the same array when twinContext is undefined", () => {
    expect(mergeTwinSourcesIntoLastAssistant(baseMessages, undefined)).toBe(baseMessages)
    expect(mergeTwinSourcesIntoLastAssistant(baseMessages, null)).toBe(baseMessages)
  })

  it("attaches a SourcesPart with twin-rag + twin-style items when none exists", () => {
    const next = mergeTwinSourcesIntoLastAssistant(baseMessages, {
      twinId: "twin_a",
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "doc content", sourceId: "src1" },
          score: 0.9,
          sourceTitle: "migration.md",
        },
      ],
      selectedStyleSamples: [
        { id: "s1", contextLabel: "PR description", summary: "concise tone", tone: ["concise"] },
      ],
    })
    expect(next).not.toBe(baseMessages)
    const assistant = next[1]
    const sources = assistant.parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    expect(sources).toBeDefined()
    expect(sources.sources).toHaveLength(2)
    const twinRag = sources.sources.find((s) => s.origin === "twin-rag") as SourcesPartItem
    const twinStyle = sources.sources.find((s) => s.origin === "twin-style") as SourcesPartItem
    expect(twinRag.title).toBe("migration.md")
    expect(twinRag.chunkRef).toEqual({
      twinId: "twin_a",
      sourceId: "src1",
      chunkId: "v1",
    })
    expect(twinStyle.title).toBe("PR description")
  })

  it("merges into an existing SourcesPart and dedupes", () => {
    const withExisting: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "hi" } as never,
          {
            type: "sources",
            sources: [{ id: "x", title: "existing", origin: "anthropic" } as SourcesPartItem],
          } as never,
        ],
      },
    ]
    const next = mergeTwinSourcesIntoLastAssistant(withExisting, {
      twinId: "twin_a",
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "doc", sourceId: "src1" },
          score: 0.8,
          sourceTitle: "doc.md",
        },
      ],
      selectedStyleSamples: [],
    })
    const sources = next[0].parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    expect(sources.sources).toHaveLength(2)
    expect(sources.sources[0].origin).toBe("anthropic")
    expect(sources.sources[1].origin).toBe("twin-rag")
  })

  it("is idempotent — re-applying with the same context returns the same array", () => {
    const ctx = {
      twinId: "twin_a",
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "doc", sourceId: "src1" },
          score: 0.8,
          sourceTitle: "doc.md",
        },
      ],
      selectedStyleSamples: [],
    }
    const once = mergeTwinSourcesIntoLastAssistant(baseMessages, ctx)
    const twice = mergeTwinSourcesIntoLastAssistant(once, ctx)
    expect(twice).toBe(once)
  })

  it("returns the same array when both retrievedChunks and styleSamples are empty", () => {
    const next = mergeTwinSourcesIntoLastAssistant(baseMessages, {
      twinId: "twin_a",
      retrievedChunks: [],
      selectedStyleSamples: [],
    })
    expect(next).toBe(baseMessages)
  })

  it("attaches a degraded-flagged SourcesPart when degraded with no retrieved context", () => {
    const next = mergeTwinSourcesIntoLastAssistant(baseMessages, {
      twinId: "twin_a",
      retrievedChunks: [],
      selectedStyleSamples: [],
      degraded: true,
    })
    expect(next).not.toBe(baseMessages)
    const sources = next[1].parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    expect(sources).toBeDefined()
    expect(sources.sources).toHaveLength(0)
    expect(sources.twinDegraded).toBe(true)
  })

  it("flags an existing SourcesPart as degraded while still attaching retrieved chunks", () => {
    const next = mergeTwinSourcesIntoLastAssistant(baseMessages, {
      twinId: "twin_a",
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "doc", sourceId: "src1" },
          score: 0.5,
          sourceTitle: "doc.md",
        },
      ],
      selectedStyleSamples: [],
      degraded: true,
    })
    const sources = next[1].parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    expect(sources.sources).toHaveLength(1)
    expect(sources.twinDegraded).toBe(true)
  })

  it("is idempotent for a degraded no-context merge", () => {
    const ctx = {
      twinId: "twin_a",
      retrievedChunks: [],
      selectedStyleSamples: [],
      degraded: true,
    }
    const once = mergeTwinSourcesIntoLastAssistant(baseMessages, ctx)
    const twice = mergeTwinSourcesIntoLastAssistant(once, ctx)
    expect(twice).toBe(once)
  })

  it("returns the same array when there is no assistant message", () => {
    const userOnly: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" } as never] },
    ]
    const next = mergeTwinSourcesIntoLastAssistant(userOnly, {
      twinId: "twin_a",
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "doc", sourceId: "src1" },
          score: 0.5,
          sourceTitle: "doc.md",
        },
      ],
      selectedStyleSamples: [],
    })
    expect(next).toBe(userOnly)
  })
})

describe("mergeMemorySourcesIntoLastAssistant", () => {
  const baseMessages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" } as never] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" } as never] },
  ]

  it("returns the same array when memoryContext is empty/nullish", () => {
    expect(mergeMemorySourcesIntoLastAssistant(baseMessages, undefined)).toBe(baseMessages)
    expect(mergeMemorySourcesIntoLastAssistant(baseMessages, null)).toBe(baseMessages)
    expect(mergeMemorySourcesIntoLastAssistant(baseMessages, { retrievedMemories: [] })).toBe(
      baseMessages
    )
  })

  it("attaches memory-origin sources onto the last assistant message", () => {
    const next = mergeMemorySourcesIntoLastAssistant(baseMessages, {
      retrievedMemories: [
        { id: "m1", type: "semantic", text: "The user prefers pnpm", score: 0.9 },
      ],
    })
    expect(next).not.toBe(baseMessages)
    const sources = next[1].parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    const item = sources.sources.find((s) => s.origin === "memory") as SourcesPartItem
    expect(item.id).toBe("memory-m1")
    expect(item.title).toBe("The user prefers pnpm")
    expect(item.score).toBe(0.9)
  })

  it("truncates long memory text for title and snippet", () => {
    const long = "x".repeat(300)
    const next = mergeMemorySourcesIntoLastAssistant(baseMessages, {
      retrievedMemories: [{ id: "m1", type: "semantic", text: long, score: 0.5 }],
    })
    const sources = next[1].parts.find(
      (p) => (p as { type?: string }).type === "sources"
    ) as unknown as SourcesPart
    const item = sources.sources[0]
    expect(item.title!.endsWith("…")).toBe(true)
    expect(item.title!.length).toBeLessThanOrEqual(81)
    expect(item.snippet!.endsWith("…")).toBe(true)
  })

  it("is idempotent", () => {
    const ctx = {
      retrievedMemories: [{ id: "m1", type: "semantic", text: "fact", score: 0.5 }],
    }
    const once = mergeMemorySourcesIntoLastAssistant(baseMessages, ctx)
    const twice = mergeMemorySourcesIntoLastAssistant(once, ctx)
    expect(twice).toBe(once)
  })

  it("returns the same array when there is no assistant message", () => {
    const userOnly: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" } as never] },
    ]
    const next = mergeMemorySourcesIntoLastAssistant(userOnly, {
      retrievedMemories: [{ id: "m1", type: "semantic", text: "fact", score: 0.5 }],
    })
    expect(next).toBe(userOnly)
  })
})

describe("applySdkEvent — stream_event (token-level streaming)", () => {
  function streamEvt(event: Record<string, unknown>, uuid = "se-1") {
    return {
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid,
      session_id: "s1",
    } as unknown as Parameters<typeof applySdkEvent>[1]
  }

  it("message_start seeds an empty assistant message keyed by id", () => {
    const { messages, turnComplete } = applySdkEvent(
      [],
      streamEvt({ type: "message_start", message: { id: "asst-stream-1" } })
    )
    expect(turnComplete).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe("asst-stream-1")
    expect(messages[0].role).toBe("assistant")
    expect(messages[0].parts).toHaveLength(0)
  })

  it("message_start is idempotent (no duplicate for the same id)", () => {
    const a = applySdkEvent([], streamEvt({ type: "message_start", message: { id: "m" } })).messages
    const b = applySdkEvent(a, streamEvt({ type: "message_start", message: { id: "m" } })).messages
    expect(b).toHaveLength(1)
  })

  it("text_delta accumulates into a single streaming text part", () => {
    let msgs = applySdkEvent(
      [],
      streamEvt({ type: "message_start", message: { id: "m" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } })
    ).messages
    expect(msgs[0].parts).toHaveLength(1)
    const part = msgs[0].parts[0] as { type: string; text: string; state: string }
    expect(part.type).toBe("text")
    expect(part.text).toBe("Hello")
    expect(part.state).toBe("streaming")
  })

  it("thinking_delta accumulates into a reasoning part, separate from text", () => {
    let msgs = applySdkEvent(
      [],
      streamEvt({ type: "message_start", message: { id: "m" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })
    ).messages
    const types = msgs[0].parts.map((p) => (p as { type: string }).type)
    expect(types).toEqual(["reasoning", "text"])
  })

  it("the final full assistant message replaces the streamed preview (same id)", () => {
    let msgs = applySdkEvent(
      [],
      streamEvt({ type: "message_start", message: { id: "asst-9" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } })
    ).messages
    const final = applySdkEvent(
      msgs,
      asAssistant({
        id: "asst-9",
        content: [{ type: "text", text: "final answer" }],
      } as unknown as BetaMessage)
    ).messages
    expect(final).toHaveLength(1)
    expect(final[0].id).toBe("asst-9")
    const part = final[0].parts[0] as { type: string; text: string; state: string }
    expect(part.text).toBe("final answer")
    expect(part.state).toBe("done")
  })

  it("does not merge a new turn's deltas into a prior turn's assistant message", () => {
    // Turn 1 sealed (user1 + completed assistant). Turn 2 started: `send`
    // appended the optimistic user2 message. A `content_block_delta` then
    // arrives whose `message_start` was dropped (aborted / resent turn that
    // "didn't send"). It must NOT grow the prior turn's finished assistant —
    // doing so produces the garbled "greeting two + greeting one tail" merge.
    const prior = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "greeting one", state: "done" }],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as unknown as UIMessage[]
    const out = applySdkEvent(
      prior,
      streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: " LEAK" } })
    ).messages
    // Reference unchanged and the prior assistant text is untouched.
    expect(out).toBe(prior)
    const a1 = out[1].parts[0] as { text: string }
    expect(a1.text).toBe("greeting one")
  })

  it("grows the current turn's assistant once message_start seeds it after the user turn", () => {
    // Same turn-2 base, but message_start arrives first → a fresh assistant is
    // seeded after user2 and the delta lands there, never on the prior turn.
    const base = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "greeting one", state: "done" }],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as unknown as UIMessage[]
    let msgs = applySdkEvent(
      base,
      streamEvt({ type: "message_start", message: { id: "a2" } })
    ).messages
    msgs = applySdkEvent(
      msgs,
      streamEvt({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "greeting two" },
      })
    ).messages
    expect(msgs).toHaveLength(4)
    expect((msgs[1].parts[0] as { text: string }).text).toBe("greeting one")
    expect(msgs[3].id).toBe("a2")
    expect((msgs[3].parts[0] as { text: string }).text).toBe("greeting two")
  })

  it("ignores deltas with no active assistant message and unknown raw events", () => {
    expect(
      applySdkEvent(
        [],
        streamEvt({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })
      ).messages
    ).toHaveLength(0)
    const seeded = applySdkEvent(
      [],
      streamEvt({ type: "message_start", message: { id: "m" } })
    ).messages
    expect(applySdkEvent(seeded, streamEvt({ type: "message_stop" })).messages).toBe(seeded)
  })
})

describe("applySdkEvent — session notices (permission-denied + rate-limit)", () => {
  function sysDenied(extra: Record<string, unknown> = {}) {
    return {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      decision_reason: "blocked by deny rule",
      message: "denied",
      uuid: "pd-1",
      ...extra,
    } as unknown as Parameters<typeof applySdkEvent>[1]
  }
  function rateEvt(status: string, extra: Record<string, unknown> = {}) {
    return {
      type: "rate_limit_event",
      rate_limit_info: { status, rateLimitType: "five_hour", resetsAt: 1781869200, ...extra },
      uuid: "rl-1",
      session_id: "s1",
    } as unknown as Parameters<typeof applySdkEvent>[1]
  }

  it("permission_denied appends a session-notice marker with tool + reason", () => {
    const { messages, turnComplete } = applySdkEvent([], sysDenied())
    expect(turnComplete).toBe(false)
    expect(messages).toHaveLength(1)
    const part = messages[0].parts[0] as {
      type: string
      variant: string
      toolName: string
      reason: string
    }
    expect(messages[0].role).toBe("system")
    expect(part.type).toBe("session-notice")
    expect(part.variant).toBe("permission-denied")
    expect(part.toolName).toBe("Bash")
    expect(part.reason).toBe("blocked by deny rule")
  })

  it("rate_limit_event with status=allowed is ignored (no transcript spam)", () => {
    expect(applySdkEvent([], rateEvt("allowed")).messages).toHaveLength(0)
  })

  it("rate_limit_event with allowed_warning / rejected appends a notice", () => {
    const warn = applySdkEvent([], rateEvt("allowed_warning")).messages
    expect(warn).toHaveLength(1)
    expect((warn[0].parts[0] as unknown as { variant: string }).variant).toBe("rate-limit")
    expect((warn[0].parts[0] as unknown as { status: string }).status).toBe("allowed_warning")
    const rej = applySdkEvent([], rateEvt("rejected")).messages
    expect((rej[0].parts[0] as unknown as { status: string }).status).toBe("rejected")
  })

  it("consecutive rate-limit notices collapse to one (latest wins)", () => {
    let msgs = applySdkEvent([], rateEvt("allowed_warning", {})).messages
    msgs = applySdkEvent(msgs, rateEvt("rejected")).messages
    const notices = msgs.filter((m) => (m.parts[0] as { type?: string }).type === "session-notice")
    expect(notices).toHaveLength(1)
    expect((notices[0].parts[0] as unknown as { status: string }).status).toBe("rejected")
  })

  it("a rate-limit notice does NOT collapse a preceding permission-denied notice", () => {
    let msgs = applySdkEvent([], sysDenied()).messages
    msgs = applySdkEvent(msgs, rateEvt("rejected")).messages
    expect(msgs).toHaveLength(2)
  })
})
