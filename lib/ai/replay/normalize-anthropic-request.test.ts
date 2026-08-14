import {
  computeRequestDigests,
  digestAnthropicRequest,
  flattenSystemPrompt,
  normalizeAnthropicRequest,
  normalizeTools,
} from "./normalize-anthropic-request"
import type { AnthropicMessagesPayload } from "./normalize-anthropic-request"

const OPTIONS = { provider: "anthropic", purpose: "turn" as const }

function payload(overrides: AnthropicMessagesPayload = {}): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5",
    system: "be helpful",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1024,
    temperature: 0,
    stream: true,
    ...overrides,
  }
}

describe("flattenSystemPrompt", () => {
  it("passes a plain string through", () => {
    expect(flattenSystemPrompt("be helpful")).toBe("be helpful")
  })

  it("joins block form to the same text", () => {
    // The SDK switches between these two shapes when prompt caching turns on;
    // the instructions are identical, so the digest must be too.
    expect(
      flattenSystemPrompt([
        { type: "text", text: "be " },
        { type: "text", text: "helpful" },
      ])
    ).toBe("be helpful")
  })

  it("tolerates raw strings inside the array", () => {
    expect(flattenSystemPrompt(["a", { type: "text", text: "b" }])).toBe("ab")
  })

  it("treats an absent or malformed prompt as empty", () => {
    expect(flattenSystemPrompt(undefined)).toBe("")
    expect(flattenSystemPrompt(42)).toBe("")
    expect(flattenSystemPrompt([{ type: "image" }])).toBe("")
  })
})

describe("normalizeTools", () => {
  it("keeps declaration order", () => {
    const tools = normalizeTools([
      { name: "Read", input_schema: { type: "object" } },
      { name: "Grep", input_schema: { type: "object" } },
    ])
    expect(tools.map((tool) => tool.name)).toEqual(["Read", "Grep"])
  })

  it("accepts either schema spelling", () => {
    expect(normalizeTools([{ name: "Read", inputSchema: { type: "object" } }])[0].schema).toEqual({
      type: "object",
    })
  })

  it("names an anonymous tool by position rather than dropping it", () => {
    expect(normalizeTools([{ input_schema: {} }])[0].name).toBe("tool_0")
    expect(normalizeTools(["nope"])[0].name).toBe("tool_0")
  })

  it("returns nothing for a missing tool list", () => {
    expect(normalizeTools(undefined)).toEqual([])
  })

  it("records a schemaless tool as null rather than undefined", () => {
    expect(normalizeTools([{ name: "Read" }])[0].schema).toBeNull()
  })
})

describe("normalizeAnthropicRequest", () => {
  it("maps the config fields the provider actually honours", () => {
    const normalized = normalizeAnthropicRequest(
      payload({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2048,
        stop_sequences: ["STOP", 3 as never],
        thinking: { type: "enabled", budget_tokens: 4096 },
      })
    )
    expect(normalized.config).toEqual({
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 2048,
      stopSequences: ["STOP"],
      thinkingBudgetTokens: 4096,
    })
  })

  it("flattens both tool_choice spellings", () => {
    expect(normalizeAnthropicRequest(payload({ tool_choice: "auto" })).config.toolChoice).toBe(
      "auto"
    )
    expect(
      normalizeAnthropicRequest(payload({ tool_choice: { type: "any" } })).config.toolChoice
    ).toBe("any")
    expect(
      normalizeAnthropicRequest(payload({ tool_choice: { type: "tool", name: "Read" } })).config
        .toolChoice
    ).toBe("tool:Read")
  })

  it("does not mutate the caller's payload", () => {
    // Normalizing a live request must never change what is actually sent.
    const original = payload({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    })
    const snapshot = JSON.parse(JSON.stringify(original))
    normalizeAnthropicRequest(original)
    expect(original).toEqual(snapshot)
  })

  it("survives a payload with nothing in it", () => {
    expect(normalizeAnthropicRequest({})).toEqual({
      model: "",
      system: "",
      messages: [],
      tools: [],
      config: {},
    })
  })
})

describe("request identity", () => {
  it("is stable for the same question asked twice", async () => {
    const first = await digestAnthropicRequest(payload(), OPTIONS)
    const second = await digestAnthropicRequest(payload(), OPTIONS)
    expect(second.requestDigest).toBe(first.requestDigest)
  })

  it("ignores cache_control breakpoints", async () => {
    const plain = await digestAnthropicRequest(
      payload({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      OPTIONS
    )
    const cached = await digestAnthropicRequest(
      payload({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
      OPTIONS
    )
    expect(cached.requestDigest).toBe(plain.requestDigest)
  })

  it("ignores metadata, which carries user_id", async () => {
    const withMetadata = await digestAnthropicRequest(
      payload({ metadata: { user_id: "user-42" } }),
      OPTIONS
    )
    expect(withMetadata.requestDigest).toBe(
      (await digestAnthropicRequest(payload(), OPTIONS)).requestDigest
    )
  })

  it("ignores whether the answer is streamed", async () => {
    const streamed = await digestAnthropicRequest(payload({ stream: true }), OPTIONS)
    const whole = await digestAnthropicRequest(payload({ stream: false }), OPTIONS)
    expect(whole.requestDigest).toBe(streamed.requestDigest)
  })

  it("treats string and block system prompts as one request", async () => {
    const asString = await digestAnthropicRequest(payload({ system: "be helpful" }), OPTIONS)
    const asBlocks = await digestAnthropicRequest(
      payload({ system: [{ type: "text", text: "be helpful" }] }),
      OPTIONS
    )
    expect(asBlocks.requestDigest).toBe(asString.requestDigest)
  })

  it("separates a different system prompt", async () => {
    const other = await digestAnthropicRequest(payload({ system: "be terse" }), OPTIONS)
    expect(other.requestDigest).not.toBe(
      (await digestAnthropicRequest(payload(), OPTIONS)).requestDigest
    )
  })

  it("separates a different message list", async () => {
    const other = await digestAnthropicRequest(
      payload({ messages: [{ role: "user", content: "goodbye" }] }),
      OPTIONS
    )
    expect(other.requestDigest).not.toBe(
      (await digestAnthropicRequest(payload(), OPTIONS)).requestDigest
    )
  })

  it("separates a reordered tool list", async () => {
    const tools = [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Grep", input_schema: { type: "object" } },
    ]
    const forward = await digestAnthropicRequest(payload({ tools }), OPTIONS)
    const reversed = await digestAnthropicRequest(payload({ tools: [...tools].reverse() }), OPTIONS)
    expect(reversed.requestDigest).not.toBe(forward.requestDigest)
  })

  it("separates a different model, provider and purpose", async () => {
    const base = await digestAnthropicRequest(payload(), OPTIONS)
    expect(
      (await digestAnthropicRequest(payload({ model: "claude-sonnet-5" }), OPTIONS)).requestDigest
    ).not.toBe(base.requestDigest)
    expect(
      (await digestAnthropicRequest(payload(), { ...OPTIONS, provider: "bedrock" })).requestDigest
    ).not.toBe(base.requestDigest)
    expect(
      (await digestAnthropicRequest(payload(), { ...OPTIONS, purpose: "title" })).requestDigest
    ).not.toBe(base.requestDigest)
  })

  it("separates a changed sampling config", async () => {
    const base = await digestAnthropicRequest(payload(), OPTIONS)
    expect(
      (await digestAnthropicRequest(payload({ temperature: 1 }), OPTIONS)).requestDigest
    ).not.toBe(base.requestDigest)
  })

  it("returns the component digests alongside the match key", async () => {
    const result = await digestAnthropicRequest(payload(), OPTIONS)
    for (const digest of [result.promptDigest, result.messagesDigest, result.toolDigest]) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    expect(result.normalized.model).toBe("claude-opus-5")
  })

  it("agrees whether digested in one step or two", async () => {
    const normalized = normalizeAnthropicRequest(payload())
    const twoStep = await computeRequestDigests(normalized, OPTIONS)
    const oneStep = await digestAnthropicRequest(payload(), OPTIONS)
    expect(twoStep.requestDigest).toBe(oneStep.requestDigest)
  })

  it("uses an injected hash when one is given", async () => {
    const hash = jest.fn(async () => "f".repeat(64))
    const result = await digestAnthropicRequest(payload(), { ...OPTIONS, hash })
    expect(result.requestDigest).toBe(`sha256:${"f".repeat(64)}`)
    expect(hash).toHaveBeenCalled()
  })
})
