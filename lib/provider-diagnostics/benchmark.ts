import type { EmbeddingModel, LanguageModel } from "ai"
import { embedMany, streamText } from "ai"
import { hasNoLeakingPii } from "@cognia/redact"
import type { ProviderBenchmarkMetrics } from "@cognia/provider-types"

export const PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION = "provider-diagnostics-text-v1"
export const PROVIDER_DIAGNOSTIC_TEXT_PROMPT =
  "Reply with exactly the single uppercase word PONG and no other text."
export const PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION = "provider-diagnostics-embedding-v1"
export const PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES = [
  "provider diagnostic alpha",
  "provider diagnostic bravo",
  "provider diagnostic charlie",
  "provider diagnostic delta",
  "provider diagnostic echo",
  "provider diagnostic foxtrot",
  "provider diagnostic golf",
  "provider diagnostic hotel",
] as const

export interface ProviderDiagnosticPrice {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  version: string
}

export interface ProviderTextBenchmarkInput {
  model?: LanguageModel
  maxOutputTokens: number
  signal?: AbortSignal
  price?: ProviderDiagnosticPrice
}

interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

interface StreamResult {
  textStream: AsyncIterable<string>
  usage: PromiseLike<StreamUsage> | StreamUsage
}

interface BenchmarkDependencies {
  streamTextImpl?: (options: {
    model?: LanguageModel
    prompt: string
    maxOutputTokens: number
    abortSignal?: AbortSignal
  }) => StreamResult
  now?: () => number
  piiGate?: (text: string) => boolean
}

interface EmbeddingBenchmarkDependencies {
  embedManyImpl?: (options: {
    model?: EmbeddingModel
    values: string[]
    abortSignal?: AbortSignal
  }) => Promise<{ embeddings: number[][]; usage?: { tokens?: number } }>
  now?: () => number
  piiGate?: (text: string) => boolean
}

export interface ProviderEmbeddingBenchmarkInput {
  model?: EmbeddingModel
  signal?: AbortSignal
  price?: Pick<ProviderDiagnosticPrice, "inputPerMillionUsd" | "version">
}

export interface ProviderEmbeddingBenchmarkResult {
  promptVersion: typeof PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION
  pricingVersion?: string
  metrics: ProviderBenchmarkMetrics
}

export interface ProviderTextBenchmarkResult {
  promptVersion: typeof PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION
  pricingVersion?: string
  metrics: ProviderBenchmarkMetrics
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))
}

export async function runProviderTextBenchmark(
  input: ProviderTextBenchmarkInput,
  dependencies: BenchmarkDependencies = {}
): Promise<ProviderTextBenchmarkResult> {
  const piiGate = dependencies.piiGate ?? hasNoLeakingPii
  if (!piiGate(PROVIDER_DIAGNOSTIC_TEXT_PROMPT)) {
    throw new Error("Provider diagnostic prompt failed the outbound PII gate")
  }
  if (!input.model && !dependencies.streamTextImpl) {
    throw new Error("Provider diagnostic benchmark requires a resolved model")
  }
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const commonOptions = {
    prompt: PROVIDER_DIAGNOSTIC_TEXT_PROMPT,
    maxOutputTokens: Math.min(64, Math.max(1, input.maxOutputTokens)),
    abortSignal: input.signal,
  }
  const result = dependencies.streamTextImpl
    ? dependencies.streamTextImpl({ ...commonOptions, model: input.model })
    : (streamText({ ...commonOptions, model: input.model! }) as unknown as StreamResult)

  let firstTextAt: number | undefined
  let output = ""
  for await (const chunk of result.textStream) {
    const observedAt = now()
    output += chunk
    if (firstTextAt === undefined && chunk.length > 0) firstTextAt = observedAt
  }
  const completedAt = now()
  const usage: StreamUsage = await Promise.resolve(result.usage).catch(() => ({}))
  const actualOutputTokens = finiteTokenCount(usage.outputTokens)
  const outputTokens = actualOutputTokens ?? estimateTokens(output)
  const actualInputTokens = finiteTokenCount(usage.inputTokens)
  const inputTokens = actualInputTokens ?? estimateTokens(PROVIDER_DIAGNOSTIC_TEXT_PROMPT)
  const reasoningTokens = finiteTokenCount(usage.reasoningTokens)
  const generationDurationMs =
    firstTextAt === undefined ? undefined : Math.max(0, completedAt - firstTextAt)
  const estimatedCostUsd = input.price
    ? ((inputTokens ?? 0) * input.price.inputPerMillionUsd +
        outputTokens * input.price.outputPerMillionUsd) /
      1_000_000
    : undefined

  return {
    promptVersion: PROVIDER_DIAGNOSTIC_TEXT_PROMPT_VERSION,
    ...(input.price ? { pricingVersion: input.price.version } : {}),
    metrics: {
      ...(firstTextAt === undefined ? {} : { ttftMs: Math.max(0, firstTextAt - startedAt) }),
      totalDurationMs: Math.max(0, completedAt - startedAt),
      ...(generationDurationMs === undefined ? {} : { generationDurationMs }),
      ...(generationDurationMs && outputTokens > 0
        ? { outputTokensPerSecond: outputTokens / (generationDurationMs / 1_000) }
        : {}),
      inputTokens,
      outputTokens,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      usageEstimated: actualOutputTokens === undefined || actualInputTokens === undefined,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    },
  }
}

export async function runProviderEmbeddingBenchmark(
  input: ProviderEmbeddingBenchmarkInput,
  dependencies: EmbeddingBenchmarkDependencies = {}
): Promise<ProviderEmbeddingBenchmarkResult> {
  const piiGate = dependencies.piiGate ?? hasNoLeakingPii
  if (!PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES.every((value) => piiGate(value))) {
    throw new Error("Provider diagnostic embedding payload failed the outbound PII gate")
  }
  if (!input.model && !dependencies.embedManyImpl) {
    throw new Error("Provider diagnostic embedding benchmark requires a resolved model")
  }
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const embeddingOptions = {
    values: [...PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES],
    abortSignal: input.signal,
  }
  const result = dependencies.embedManyImpl
    ? await dependencies.embedManyImpl({ ...embeddingOptions, model: input.model })
    : await embedMany({ ...embeddingOptions, model: input.model! })
  const completedAt = now()
  const durationMs = Math.max(0, completedAt - startedAt)
  const inputTokens = finiteTokenCount(result.usage?.tokens)
  const estimatedInputTokens = PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES.reduce(
    (total, value) => total + estimateTokens(value),
    0
  )
  const effectiveInputTokens = inputTokens ?? estimatedInputTokens
  const dimensions = result.embeddings[0]?.length
  const estimatedCostUsd = input.price
    ? (effectiveInputTokens * input.price.inputPerMillionUsd) / 1_000_000
    : undefined
  return {
    promptVersion: PROVIDER_DIAGNOSTIC_EMBEDDING_PROMPT_VERSION,
    ...(input.price ? { pricingVersion: input.price.version } : {}),
    metrics: {
      totalDurationMs: durationMs,
      inputTokens: effectiveInputTokens,
      usageEstimated: inputTokens === undefined,
      embeddingBatchSize: PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES.length,
      ...(durationMs > 0
        ? {
            embeddingItemsPerSecond:
              PROVIDER_DIAGNOSTIC_EMBEDDING_VALUES.length / (durationMs / 1_000),
          }
        : {}),
      ...(dimensions === undefined ? {} : { embeddingDimensions: dimensions }),
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    },
  }
}
