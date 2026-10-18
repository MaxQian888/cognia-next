import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"

/** SIWC always uses HTTP/SSE, including callers of AI SDK generateText. */
export function withSiwcStreamingGeneration(model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doStream: (options) => model.doStream(options),
    async doGenerate(options) {
      const result = await model.doStream(options)
      const reader = result.stream.getReader()
      const content: LanguageModelV4Content[] = []
      const blocks = new Map<string, { type: "text" | "reasoning"; text: string }>()
      const warnings: LanguageModelV4GenerateResult["warnings"] = []
      let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined
      let response: LanguageModelV4GenerateResult["response"] = result.response
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          const part = next.value
          switch (part.type) {
            case "error":
              throw part.error instanceof Error ? part.error : new Error("SIWC generation failed")
            case "stream-start":
              warnings.push(...part.warnings)
              break
            case "response-metadata": {
              const { type: _type, ...metadata } = part
              response = { ...response, ...metadata }
              break
            }
            case "text-start":
            case "reasoning-start": {
              const block = {
                type: part.type === "text-start" ? ("text" as const) : ("reasoning" as const),
                text: "",
                ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
              }
              blocks.set(`${block.type}:${part.id}`, block)
              content.push(block)
              break
            }
            case "text-delta":
            case "reasoning-delta": {
              const type = part.type === "text-delta" ? "text" : "reasoning"
              let block = blocks.get(`${type}:${part.id}`)
              if (!block) {
                block = { type, text: "" }
                blocks.set(`${type}:${part.id}`, block)
                content.push(block)
              }
              block.text += part.delta
              break
            }
            case "finish":
              finish = part
              break
            case "text-end":
            case "reasoning-end": {
              const type = part.type === "text-end" ? "text" : "reasoning"
              const block = blocks.get(`${type}:${part.id}`)
              if (block && part.providerMetadata)
                Object.assign(block, { providerMetadata: part.providerMetadata })
              break
            }
            case "tool-call":
            case "tool-result":
            case "tool-approval-request":
            case "file":
            case "reasoning-file":
            case "source":
            case "custom":
              content.push(part)
              break
          }
        }
        if (!finish || finish.finishReason.unified === "error")
          throw new Error("SIWC generation ended without successful completion")
        return {
          content,
          finishReason: finish.finishReason,
          usage: finish.usage,
          warnings,
          ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
          ...(result.request ? { request: result.request } : {}),
          ...(response ? { response } : {}),
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
  }
}
