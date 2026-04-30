import type { UIMessage } from "ai"

import { applySdkEvent, contentPreview, makeUserMessage } from "./adapter"
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
