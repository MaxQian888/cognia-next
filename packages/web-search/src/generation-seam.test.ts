import type { LanguageModel } from "ai"

import {
  generateThroughSeam,
  modelIdOf,
  type GenerationRequest,
  type GenerationSeam,
  type GenerationSend,
} from "./generation-seam"

const REQUEST: GenerationRequest = { stage: "web-search.google-ai", modelId: "m", prompt: "q" }

describe("modelIdOf", () => {
  it("reads a provider handle's model id and passes a global model id through", () => {
    expect(modelIdOf({ modelId: "gemini-2.0-flash" } as unknown as LanguageModel)).toBe(
      "gemini-2.0-flash"
    )
    expect(modelIdOf("google/gemini-2.5-flash")).toBe("google/gemini-2.5-flash")
  })
})

describe("generateThroughSeam", () => {
  it("makes the package's own call with no override when no seam is injected", async () => {
    const send = jest.fn<ReturnType<GenerationSend>, Parameters<GenerationSend>>(async () => ({
      text: "answer",
    }))
    await expect(generateThroughSeam(undefined, REQUEST, send)).resolves.toBe("answer")
    expect(Object.keys(send.mock.calls[0][0])).toHaveLength(0)
  })

  it("hands the request and the package's own call to an injected seam", async () => {
    const send: GenerationSend = jest.fn(async () => ({ text: "sent" }))
    const seam: GenerationSeam = async (_request, run) => (await run({ maxRetries: 0 })).text
    await expect(generateThroughSeam(seam, REQUEST, send)).resolves.toBe("sent")
    expect(send).toHaveBeenCalledWith({ maxRetries: 0 })
  })
})

// The vendored copy is pinned against `@cognia/provider-embedding`'s original
// by the host that satisfies both, in `lib/ai/ledgered-generation-seam.test.ts`
// — this package declares no package dependencies, test ones included.
