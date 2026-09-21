/**
 * The generation seam of the pure packages (ADR-0188 D27).
 *
 * A handful of package functions make one LLM generation of their own: semantic
 * chunking here, and query expansion, rerank, retrieval grading, answer
 * grounding, RAG evaluation and contextual retrieval in `@cognia/rag`. D27 puts
 * every generation on an enabled surface through the Router + Fusion
 * CallLedger, but a package has no `@/` imports and cannot reach the ledger.
 * So each of those functions takes an optional `generate` seam, and the host
 * decides what runs:
 *
 *  - Nothing injected: the function calls `generateText` on its model exactly
 *    as it always has — `send({})` is that very call, with no key added. This is
 *    every call while Router + Fusion is off (D37).
 *  - A seam injected: the function describes the call (`GenerationRequest`) and
 *    hands the seam `send`, its own `generateText` call with the transport
 *    overrides the seam asks for. The host's seam
 *    (`lib/ai/ledgered-generation-seam.ts`) reserves the call on the ledger,
 *    calls `send` with the reservation's output bound and no hidden retries,
 *    and settles it from the usage `send` hands back.
 *
 * The package keeps its own prompt, model and parsing either way; the seam
 * never sees the model handle and cannot change what is asked.
 *
 * `@cognia/web-search` keeps a structurally identical copy in its own
 * `generation-seam.ts` (it has no package dependencies); the host's one seam
 * satisfies both.
 */

import type { LanguageModel } from "ai"

/** One generation a package function is about to make. */
export interface GenerationRequest {
  /**
   * Stable id of the package stage making the call, e.g. `rag.hyde`. The host
   * prefixes its own feature id, so the run list can tell the stages apart.
   */
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
 * What `send` resolves with: the text, and the provider's own usage report in
 * the AI SDK's shape (`generateText`'s `usage` and `providerMetadata`).
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
 * ledger refusal); the package treats that like any other failed call.
 */
export type GenerationSeam = (request: GenerationRequest, send: GenerationSend) => Promise<string>

/** The id a model is called by, whether it is a provider handle or a global model id. */
export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId
}

/**
 * The one branch every package call site takes. No seam: `send({})`, which is
 * the call exactly as it was before the seam existed. A seam: it decides.
 */
export async function generateThroughSeam(
  seam: GenerationSeam | undefined,
  request: GenerationRequest,
  send: GenerationSend
): Promise<string> {
  if (!seam) return (await send({})).text
  return seam(request, send)
}
