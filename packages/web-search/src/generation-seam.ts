/**
 * The generation seam of `@cognia/web-search` (ADR-0188 D27).
 *
 * Two things in this package make an LLM generation: the standalone answer
 * synthesis (`standalone-answer.ts`) and the Google AI provider, whose every
 * search is a Gemini `:generateContent` call (`providers/google-ai.ts`). D27
 * puts every generation on an enabled surface through the Router + Fusion
 * CallLedger, which a package cannot reach. So both take an optional seam and
 * the host decides what runs:
 *
 *  - Nothing injected: the package makes its call exactly as it always has —
 *    `send({})` is that very call, with nothing added. This is every call
 *    while Router + Fusion is off (D37).
 *  - A seam injected: the package describes the call and hands the seam
 *    `send`, its own request with the overrides the seam asks for. The host's
 *    seam (`lib/ai/ledgered-generation-seam.ts`) reserves the call, sends it
 *    with the reservation's output bound and no hidden retries, and settles it
 *    from the usage `send` hands back.
 *
 * This is a structurally identical copy of
 * `@cognia/provider-embedding/generation-seam` — this package has no package
 * dependencies — so the host's one seam satisfies both. `generation-seam.test.ts`
 * pins the two copies to each other.
 */

import type { LanguageModel } from "ai"

/** One generation the package is about to make. */
export interface GenerationRequest {
  /** Stable id of the package stage making the call, e.g. `web-search.google-ai`. */
  stage: string
  /** The model id the call runs on, for the ledger's price lookup. */
  modelId: string
  prompt: string
  system?: string
  temperature?: number
  abortSignal?: AbortSignal
}

/** What a seam may change about the call it reserved. Everything else is the package's own. */
export interface GenerationOverrides {
  /** The output bound the reservation was priced for. */
  maxOutputTokens?: number
  /** Transport retries; a ledgered call sets 0 so a retry is never a hidden, unreserved attempt. */
  maxRetries?: number
}

/**
 * What `send` resolves with: the text, and the provider's usage report in the
 * AI SDK's shape (`inputTokens`, `outputTokens`, `cachedInputTokens`, …).
 */
export interface GenerationSendResult {
  text: string
  usage?: unknown
  providerMetadata?: unknown
}

/** The package's own call, with the seam's overrides applied on top. */
export type GenerationSend = (overrides: GenerationOverrides) => Promise<GenerationSendResult>

/**
 * The host's generation seam. Contract: call `send` at most once, and resolve
 * with the text it produced or reject. A seam may reject without sending (a
 * ledger refusal).
 */
export type GenerationSeam = (request: GenerationRequest, send: GenerationSend) => Promise<string>

/** The id a model is called by, whether it is a provider handle or a global model id. */
export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId
}

/**
 * The one branch every call site takes. No seam: `send({})`, the call exactly
 * as it was before the seam existed. A seam: it decides.
 */
export async function generateThroughSeam(
  seam: GenerationSeam | undefined,
  request: GenerationRequest,
  send: GenerationSend
): Promise<string> {
  if (!seam) return (await send({})).text
  return seam(request, send)
}
