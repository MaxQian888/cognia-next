/**
 * The plugin contract's share of `lib/claude/adapter.ts`, which re-exports these.
 */
export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  /**
   * Authoritative tokens currently occupying the live context. External agents
   * such as Codex report this independently from per-turn billable usage.
   */
  contextTokens?: number
  /** Authoritative live model context-window size, when the provider reports it. */
  contextWindow?: number
  /**
   * Prompt tokens occupying the *current* context window after the turn, when
   * that differs from `inputTokens`. On the ai-sdk channel a turn runs a manual
   * agent loop of several legs, and `inputTokens` SUMS every leg's prompt (the
   * correct cumulative-billing figure, since the API re-charges each leg). The
   * window, however, holds only the LAST leg's prompt — so window math must use
   * this field when present. `undefined` on single-result channels (native
   * Anthropic), where `inputTokens` already equals the window prompt.
   */
  contextInputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  /**
   * Cache-creation tokens split by TTL, when the provider reports it. Anthropic
   * bills a 5-minute write at 1.25× base input and a 1-hour write at 2×, so the
   * two cannot share `cacheCreationInputTokens` without under-billing the
   * 1-hour case. `undefined` when the provider reports only the flat total.
   */
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  /**
   * Server-side tool invocation counts (`usage.server_tool_use`), normalized to
   * bare tool names. These are billed per call independently of tokens — web
   * search is $10 per 1,000 requests — so a turn's cost is incomplete without
   * them. `undefined` when the provider reported none.
   */
  serverToolUse?: Record<string, number>
  /**
   * Reasoning / "thinking" tokens reported separately by the provider (a subset
   * of output tokens, already billed at the output rate). Surfaced for
   * observability; `undefined` when the provider bundles thinking into output
   * (native Anthropic) or the model doesn't reason.
   */
  reasoningTokens?: number
  totalCostUsd?: number
  /**
   * Provider-reported cost in the provider's own unit, when it named one that
   * is not USD (Devin reports ACU). Carried verbatim with its label — never
   * converted or summed into {@link totalCostUsd}, which stays USD-only.
   */
  providerCost?: { amount: number; currency?: string }
  durationMs?: number
}
