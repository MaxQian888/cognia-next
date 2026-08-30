/**
 * LLM client contract for the memory core — vendored from
 * `lib/twin/distill/llm.ts` so this package stays free of `@/` app imports.
 *
 * Only the *type* surface lives here; the concrete provider-aware factory
 * (`createLlmClient`, which pulls in the `ai` SDK + provider adapters) stays
 * app-side and is passed in by the caller. Twin and memory keep structurally
 * identical `LlmClient` shapes, so an app-built client is assignable to this
 * contract via TypeScript structural typing (a shared `@cognia/llm-client`
 * micro-package is a future consolidation, out of scope here).
 */

export interface LlmClientCallOptions {
  /** System / role-priming prompt. */
  system?: string
  /** Maximum tokens in the response. */
  maxTokens?: number
  /** Sampling temperature. Defaults to 0 for distill/consolidation calls. */
  temperature?: number
  /** Stop sequences passed verbatim to the provider. */
  stopSequences?: string[]
  /** Abort the in-flight call (forwarded to the AI SDK). */
  abortSignal?: AbortSignal
}

/** Cumulative token-usage snapshot (optional; mocks may omit it). */
export interface LlmUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Prompt-cache READ tokens (billed at a discount). Additive to `inputTokens`. */
  cacheReadTokens?: number
  /** Prompt-cache WRITE/creation tokens (billed at a premium). */
  cacheCreationTokens?: number
}

export interface LlmClient {
  /** Ask the LLM with a free-form prompt; return the raw text response. */
  complete(prompt: string, options?: LlmClientCallOptions): Promise<string>
  /** Streaming variant — yields text deltas. Optional so mocks stay valid. */
  stream?(prompt: string, options?: LlmClientCallOptions): AsyncIterable<string>
  /** Cumulative tokens consumed since construction. Optional (mocks ignore it). */
  getUsageSnapshot?(): LlmUsageSnapshot
  /**
   * Which provider/model this client actually resolved to.
   *
   * Optional so mocks stay valid. Present on production clients so a caller that
   * persists model-derived output (memory's `Memory.extractor`) can record what
   * produced it — without that, output from a prompt or model later found to be
   * bad is indistinguishable from good rows and cannot be re-derived in bulk.
   */
  readonly provider?: string
  readonly model?: string
}
