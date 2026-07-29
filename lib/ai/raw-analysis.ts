import {
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModelMiddleware,
  type ProviderMetadata,
} from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"

export const RAW_ANALYSIS_SOURCE = "raw-analysis" as const

function markRawAnalysis<T extends { providerMetadata?: ProviderMetadata }>(part: T): T {
  return {
    ...part,
    providerMetadata: {
      ...(part.providerMetadata ?? {}),
      cognia: {
        ...(part.providerMetadata?.cognia ?? {}),
        reasoningSource: RAW_ANALYSIS_SOURCE,
      },
    },
  }
}

/** Tag reasoning emitted by a provider known to expose raw chain-of-thought. */
export function rawAnalysisProvenanceMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      return {
        ...result,
        content: result.content.map((part) =>
          part.type === "reasoning" ? markRawAnalysis(part) : part
        ),
      }
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              controller.enqueue(
                part.type === "reasoning-start" ||
                  part.type === "reasoning-delta" ||
                  part.type === "reasoning-end"
                  ? markRawAnalysis(part)
                  : part
              )
            },
          })
        ),
      }
    },
  }
}

/**
 * gpt-oss raw mode places chain-of-thought in `<think>` text. Extract it,
 * attach provenance, and let the event boundary discard it before rendering
 * or persistence. Other models keep their existing behavior.
 */
export function protectRawAnalysis(model: LanguageModelV3, modelId: string): LanguageModelV3 {
  if (!/gpt-oss/i.test(modelId)) return model
  const extracted = wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  })
  return wrapLanguageModel({
    model: extracted,
    middleware: rawAnalysisProvenanceMiddleware(),
  })
}
