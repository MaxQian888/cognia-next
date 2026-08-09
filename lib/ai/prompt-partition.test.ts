import type { ModelMessage, SystemModelMessage } from "ai"

import { EMITTED_INSTRUCTIONS_KEY, partitionPrompt } from "./prompt-partition"

const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

function sys(content: string, providerOptions?: SystemModelMessage["providerOptions"]) {
  return { role: "system", content, ...(providerOptions ? { providerOptions } : {}) } as const
}

describe("partitionPrompt", () => {
  it("emits under the key the installed AI SDK accepts", () => {
    // ToolLoopAgent-only. Flip both this pin and the helper in the v7 bump.
    expect(EMITTED_INSTRUCTIONS_KEY).toBe("instructions")
  })

  it("leaves a system-free conversation untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]

    const result = partitionPrompt(messages)

    expect(result).toEqual({ messages })
    expect(result.instructions).toBeUndefined()
    expect(result.allowSystemInMessages).toBeUndefined()
  })

  it("handles an empty conversation", () => {
    expect(partitionPrompt([])).toEqual({ messages: [] })
  })

  it("hoists a single leading system message", () => {
    const result = partitionPrompt([sys("be terse"), { role: "user", content: "hi" }])

    expect(result.instructions).toEqual([{ role: "system", content: "be terse" }])
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
    expect(result.allowSystemInMessages).toBeUndefined()
  })

  it("preserves order and per-message providerOptions across multiple leading system messages", () => {
    // The sidecar plants up to three Anthropic cacheControl breakpoints on
    // separate leading system messages; every one must survive the hoist.
    const result = partitionPrompt([
      sys("base", CACHE_CONTROL),
      sys("stable append", CACHE_CONTROL),
      sys("per-turn tail"),
      { role: "user", content: "hi" },
    ])

    expect(result.instructions).toEqual([
      { role: "system", content: "base", providerOptions: CACHE_CONTROL },
      { role: "system", content: "stable append", providerOptions: CACHE_CONTROL },
      { role: "system", content: "per-turn tail" },
    ])
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("prepends separately-carried leading instructions ahead of message-derived system content", () => {
    const result = partitionPrompt(
      [sys("from history"), { role: "user", content: "hi" }],
      "composed"
    )

    expect(result.instructions).toEqual([
      { role: "system", content: "composed" },
      { role: "system", content: "from history" },
    ])
  })

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   \n\t "],
  ])("drops %s leading instructions instead of emitting an empty system turn", (_label, value) => {
    const result = partitionPrompt([{ role: "user", content: "hi" }], value)

    expect(result.instructions).toBeUndefined()
  })

  it("accepts a single SystemModelMessage as leading instructions", () => {
    const result = partitionPrompt([{ role: "user", content: "hi" }], sys("solo", CACHE_CONTROL))

    expect(result.instructions).toEqual([
      { role: "system", content: "solo", providerOptions: CACHE_CONTROL },
    ])
  })

  it("accepts an array of SystemModelMessages as leading instructions", () => {
    const result = partitionPrompt([{ role: "user", content: "hi" }], [sys("a"), sys("b")])

    expect(result.instructions).toEqual([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ])
  })

  it("drops blank system messages so they never reach the provider", () => {
    const result = partitionPrompt([sys("   "), sys("real"), { role: "user", content: "hi" }])

    expect(result.instructions).toEqual([{ role: "system", content: "real" }])
  })

  it("leaves mid-history system messages in place and opts them back in", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      sys("mid-course correction"),
      { role: "assistant", content: "ok" },
    ]

    const result = partitionPrompt(messages)

    expect(result.instructions).toBeUndefined()
    expect(result.messages).toEqual(messages)
    expect(result.allowSystemInMessages).toBe(true)
  })

  it("hoists the leading run while still opting in for an interleaved system message", () => {
    const result = partitionPrompt([
      sys("base"),
      { role: "user", content: "hi" },
      sys("mid"),
      { role: "assistant", content: "ok" },
    ])

    expect(result.instructions).toEqual([{ role: "system", content: "base" }])
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: "mid" },
      { role: "assistant", content: "ok" },
    ])
    expect(result.allowSystemInMessages).toBe(true)
  })

  it("treats an all-system conversation as pure instructions", () => {
    const result = partitionPrompt([sys("a"), sys("b")])

    expect(result.instructions).toEqual([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ])
    expect(result.messages).toEqual([])
    expect(result.allowSystemInMessages).toBeUndefined()
  })

  it("does not mutate the input array", () => {
    const messages: ModelMessage[] = [sys("base"), { role: "user", content: "hi" }]
    const snapshot = structuredClone(messages)

    partitionPrompt(messages, "composed")

    expect(messages).toEqual(snapshot)
  })

  it("spreads directly into call options without leaking undefined keys", () => {
    const options = { model: "m", ...partitionPrompt([{ role: "user", content: "hi" }]) }

    expect(Object.keys(options).sort()).toEqual(["messages", "model"])
  })
})
