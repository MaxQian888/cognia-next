import type { LanguageModel } from "ai"

import {
  generateThroughSeam,
  modelIdOf,
  type GenerationRequest,
  type GenerationSeam,
  type GenerationSend,
} from "./generation-seam"

const REQUEST: GenerationRequest = { stage: "rag.hyde", modelId: "m-1", prompt: "p" }

describe("modelIdOf", () => {
  it("reads a provider handle's model id and passes a global model id through", () => {
    expect(modelIdOf({ modelId: "claude-haiku" } as unknown as LanguageModel)).toBe("claude-haiku")
    expect(modelIdOf("openai/gpt-5-mini")).toBe("openai/gpt-5-mini")
  })
})

describe("generateThroughSeam", () => {
  it("makes the package's own call with no override when no seam is injected", async () => {
    const send = jest.fn<ReturnType<GenerationSend>, Parameters<GenerationSend>>(async () => ({
      text: "answer",
    }))
    await expect(generateThroughSeam(undefined, REQUEST, send)).resolves.toBe("answer")
    expect(send).toHaveBeenCalledTimes(1)
    // `{}` spreads nothing into the package's `generateText` arguments.
    expect(send.mock.calls[0][0]).toEqual({})
    expect(Object.keys(send.mock.calls[0][0])).toHaveLength(0)
  })

  it("hands the request and the package's own call to an injected seam", async () => {
    const send: GenerationSend = jest.fn(async () => ({ text: "sent" }))
    const seam = jest.fn<ReturnType<GenerationSeam>, Parameters<GenerationSeam>>(
      async (_request, run) => (await run({ maxOutputTokens: 64, maxRetries: 0 })).text
    )
    await expect(generateThroughSeam(seam, REQUEST, send)).resolves.toBe("sent")
    expect(seam).toHaveBeenCalledWith(REQUEST, send)
    expect(send).toHaveBeenCalledWith({ maxOutputTokens: 64, maxRetries: 0 })
  })

  it("lets a seam refuse without sending", async () => {
    const send: GenerationSend = jest.fn(async () => ({ text: "never" }))
    const refusal = new Error("refused")
    const seam: GenerationSeam = async () => {
      throw refusal
    }
    await expect(generateThroughSeam(seam, REQUEST, send)).rejects.toBe(refusal)
    expect(send).not.toHaveBeenCalled()
  })
})
