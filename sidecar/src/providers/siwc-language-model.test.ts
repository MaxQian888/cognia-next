import assert from "node:assert/strict"
import { test } from "node:test"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { withSiwcStreamingGeneration } from "./siwc-language-model.ts"

function model(parts: LanguageModelV4StreamPart[]): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "openai.responses",
    modelId: "m",
    supportedUrls: {},
    doGenerate() {
      throw new Error("SIWC must never issue a non-stream request")
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
        response: { headers: { "x-request-id": "r" } },
      }
    },
  }
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 2, reasoning: 1 },
}

test("SIWC generateText model consumes streaming text, reasoning, tool names and usage", async () => {
  const wrapper = withSiwcStreamingGeneration(
    model([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "response-one", modelId: "m" },
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", delta: "thinking" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "hello" },
      { type: "text-delta", id: "text", delta: " world" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "lookup",
        input: "{}",
        providerMetadata: { openai: { namespace: "functions" } },
      },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "completed" } },
    ])
  )
  const result = await wrapper.doGenerate({ prompt: [] })
  assert.deepEqual(result.content.slice(0, 2), [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "hello world" },
  ])
  assert.equal(result.content[2]!.type, "tool-call")
  assert.deepEqual(result.usage, usage)
  assert.equal(result.response!.id, "response-one")
  assert.equal(result.response!.headers!["x-request-id"], "r")
})

test("SIWC generation rejects late failures and missing terminal completion", async () => {
  for (const tail of [
    [],
    [{ type: "error", error: new Error("usage limit") }],
  ] as LanguageModelV4StreamPart[][]) {
    const wrapper = withSiwcStreamingGeneration(
      model([{ type: "text-delta", id: "t", delta: "provisional" }, ...tail])
    )
    await assert.rejects(
      Promise.resolve(wrapper.doGenerate({ prompt: [] })),
      /usage limit|successful completion/
    )
  }
})
