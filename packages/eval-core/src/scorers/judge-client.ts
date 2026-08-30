/**
 * The minimum an LLM has to do for a judge or RAG scorer: answer a prompt with
 * text.
 *
 * Declared here rather than imported so the scorers compile inside this
 * zero-`@/` package. The app's `LlmClient` (`lib/twin/distill/llm.ts`) satisfies
 * this structurally, so callers pass exactly what they passed before — the
 * narrower type just records that scoring never needed streaming, usage
 * accounting, or any of the rest of that interface.
 */
export interface EvalJudgeClientCallOptions {
  system?: string
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
  abortSignal?: AbortSignal
}

export interface EvalJudgeClient {
  complete(prompt: string, options?: EvalJudgeClientCallOptions): Promise<string>
}
