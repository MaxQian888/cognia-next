import { completeText, completeJson, type AiBridge, type AiChunk } from "./ai"

function bridgeFromChunks(chunks: AiChunk[]): AiBridge {
  return {
    chat: async function* () {
      for (const c of chunks) yield c
    },
    embed: async (texts) => texts.map(() => [0]),
  }
}

describe("completeText", () => {
  it("concatenates chunk content", async () => {
    const ai = bridgeFromChunks([{ content: "Hello " }, { content: "world" }])
    const { text } = await completeText(ai, [{ role: "user", content: "hi" }])
    expect(text).toBe("Hello world")
  })

  it("takes the largest reported cumulative totalTokens", async () => {
    const ai = bridgeFromChunks([
      { content: "a", usage: { totalTokens: 10 } },
      { content: "b", usage: { totalTokens: 25 } },
    ])
    const { tokens } = await completeText(ai, [{ role: "user", content: "hi" }])
    expect(tokens).toBe(25)
  })

  it("falls back to prompt + summed completion tokens when no total is sent", async () => {
    const ai = bridgeFromChunks([
      { content: "a", usage: { promptTokens: 5, completionTokens: 3 } },
      { content: "b", usage: { promptTokens: 5, completionTokens: 4 } },
    ])
    const { tokens } = await completeText(ai, [{ role: "user", content: "hi" }])
    expect(tokens).toBe(5 + 3 + 4)
  })

  it("reports 0 tokens when usage is absent", async () => {
    const ai = bridgeFromChunks([{ content: "x" }])
    const { tokens } = await completeText(ai, [{ role: "user", content: "hi" }])
    expect(tokens).toBe(0)
  })

  it("passes options straight through to chat", async () => {
    const chat = jest.fn(async function* () {
      yield { content: "ok" }
    })
    const ai: AiBridge = { chat, embed: async () => [] }
    const opts = { temperature: 0.1, maxTokens: 50 }
    await completeText(ai, [{ role: "user", content: "hi" }], opts)
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: "hi" }], opts)
  })
})

describe("completeJson", () => {
  it("parses the assembled text with the supplied parser", async () => {
    const ai = bridgeFromChunks([{ content: '{"a":' }, { content: "1}" }])
    const { value } = await completeJson<{ a: number }>(
      ai,
      [{ role: "user", content: "hi" }],
      (t) => JSON.parse(t)
    )
    expect(value).toEqual({ a: 1 })
  })
})
