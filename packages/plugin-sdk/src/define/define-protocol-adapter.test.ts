import { defineProtocolAdapter } from "./define-protocol-adapter"

describe("defineProtocolAdapter", () => {
  it("returns the protocol adapter definition unchanged", () => {
    const def = {
      id: "variant",
      label: "OpenAI Variant",
      spec: {
        kind: "openai-compatible-variant",
        urlTemplate: "{baseURL}/chat",
        responsePaths: { textDelta: "choices[0].delta.content" },
      },
    } as const

    expect(defineProtocolAdapter(def)).toBe(def)
  })
})
