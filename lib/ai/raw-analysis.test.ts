import type { LanguageModelV4 } from "@ai-sdk/provider"

import { protectRawAnalysis, RAW_ANALYSIS_SOURCE } from "./raw-analysis"

function fixtureModel(parts: Array<Record<string, unknown>>): LanguageModelV4 {
  return {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "openai/gpt-oss-20b",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      }),
    }),
  } as unknown as LanguageModelV4
}

describe("protectRawAnalysis", () => {
  it("extracts split gpt-oss think tags and marks every reasoning chunk", async () => {
    const model = protectRawAnalysis(
      fixtureModel([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "<thi" },
        { type: "text-delta", id: "text-1", delta: "nk>private analysis</think>" },
        { type: "text-delta", id: "text-1", delta: "Safe answer" },
        { type: "text-end", id: "text-1" },
      ]),
      "openai/gpt-oss-20b"
    )

    const result = await model.doStream({ prompt: [] } as never)
    const parts: Array<Record<string, unknown>> = []
    for await (const part of result.stream) parts.push(part as unknown as Record<string, unknown>)

    const reasoning = parts.filter((part) => String(part.type).startsWith("reasoning"))
    expect(reasoning.length).toBeGreaterThan(0)
    expect(
      reasoning.every(
        (part) =>
          (part.providerMetadata as { cognia?: { reasoningSource?: string } })?.cognia
            ?.reasoningSource === RAW_ANALYSIS_SOURCE
      )
    ).toBe(true)
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "Safe answer")).toBe(
      true
    )
  })

  it("leaves non-gpt-oss models untouched", () => {
    const model = fixtureModel([])
    expect(protectRawAnalysis(model, "gpt-4o")).toBe(model)
  })
})
