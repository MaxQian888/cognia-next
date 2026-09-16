/**
 * Usage → mutually exclusive billing buckets (DESIGN §6.4, BUD-04/BUD-05).
 *
 * Providers disagree on what their totals include: OpenAI-compatible
 * `prompt_tokens` already contains `cached_tokens`; Anthropic's native
 * `input_tokens` excludes both cache reads and cache writes; some report
 * reasoning tokens inside `output_tokens` and some beside it. The adapter
 * DECLARES those semantics, and this module turns a raw report into buckets
 * that can be summed without double counting. A report that contradicts its
 * declared semantics (a subset larger than its total) is refused, never
 * clamped into a plausible-looking bill.
 */

import type { BillableItem, CostStatus, RateCard, Usage } from "../contracts/schemas"
import { addMicrousd, costForQuantity, costPerCall, type Microusd } from "../money/microusd"

export interface UsageSemantics {
  /** `inputTokens` already contains `cacheReadTokens`. */
  inputIncludesCacheRead: boolean
  /** `inputTokens` already contains the cache-write tokens. */
  inputIncludesCacheWrite: boolean
  /** `outputTokens` already contains `reasoningTokens`. */
  outputIncludesReasoning: boolean
}

export interface RawUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  /** Cache writes split by TTL when the provider reports it. */
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  /** Flat cache-write total when the TTL split is not reported (priced at the 5m rate). */
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Flat per-call charges, e.g. `{ web_search: 3 }`. */
  perCall?: Record<string, number>
}

export interface NormalizedUsage {
  input_uncached_tokens: number
  input_cache_read_tokens: number
  input_cache_write_5m_tokens: number
  input_cache_write_1h_tokens: number
  output_tokens: number
  reasoning_tokens: number
  reasoning_included_in_output: boolean
  per_call: Record<string, number>
  /** The raw figures kept for diagnostics; never summed. */
  diagnostics: {
    reported_input_tokens: number
    reported_output_tokens: number
    semantics: UsageSemantics
  }
}

export class UsageInconsistentError extends Error {
  readonly code = "USAGE_INCONSISTENT"
  constructor(message: string) {
    super(message)
    this.name = "UsageInconsistentError"
  }
}

function count(value: number | undefined, field: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageInconsistentError(`${field} must be a non-negative integer, got ${value}`)
  }
  return value
}

export function normalizeUsage(raw: RawUsage, semantics: UsageSemantics): NormalizedUsage {
  const input = count(raw.inputTokens, "inputTokens")
  const output = count(raw.outputTokens, "outputTokens")
  const cacheRead = count(raw.cacheReadTokens, "cacheReadTokens")
  const split5m = count(raw.cacheWrite5mTokens, "cacheWrite5mTokens")
  const split1h = count(raw.cacheWrite1hTokens, "cacheWrite1hTokens")
  const flatWrite = count(raw.cacheWriteTokens, "cacheWriteTokens")
  const reasoning = count(raw.reasoningTokens, "reasoningTokens")

  if (flatWrite > 0 && split5m + split1h > 0 && flatWrite !== split5m + split1h) {
    throw new UsageInconsistentError(
      `cache-write total ${flatWrite} disagrees with its TTL split ${split5m}+${split1h}`
    )
  }
  const hasSplit = split5m + split1h > 0
  const write5m = hasSplit ? split5m : flatWrite
  const write1h = hasSplit ? split1h : 0
  const writeTotal = write5m + write1h

  let uncached = input
  if (semantics.inputIncludesCacheRead) {
    if (cacheRead > uncached) {
      throw new UsageInconsistentError(`cache reads ${cacheRead} exceed the input total ${input}`)
    }
    uncached -= cacheRead
  }
  if (semantics.inputIncludesCacheWrite) {
    if (writeTotal > uncached) {
      throw new UsageInconsistentError(
        `cache writes ${writeTotal} exceed the remaining input ${uncached}`
      )
    }
    uncached -= writeTotal
  }
  if (semantics.outputIncludesReasoning && reasoning > output) {
    throw new UsageInconsistentError(`reasoning ${reasoning} exceeds the output total ${output}`)
  }

  const perCall: Record<string, number> = {}
  for (const [kind, calls] of Object.entries(raw.perCall ?? {})) {
    const n = count(calls, `perCall.${kind}`)
    if (n > 0) perCall[kind] = n
  }

  return {
    input_uncached_tokens: uncached,
    input_cache_read_tokens: cacheRead,
    input_cache_write_5m_tokens: write5m,
    input_cache_write_1h_tokens: write1h,
    output_tokens: output,
    reasoning_tokens: reasoning,
    reasoning_included_in_output: semantics.outputIncludesReasoning,
    per_call: perCall,
    diagnostics: { reported_input_tokens: input, reported_output_tokens: output, semantics },
  }
}

/** Per-call prices a rate card may carry beyond the token buckets (USD per call). */
export type PerCallPrices = Record<string, string>

export interface PricedUsage {
  items: BillableItem[]
  total_microusd: Microusd
}

/**
 * Price normalized usage into billable items. Reasoning reported beside the
 * output total is billed at the output rate as `reasoning_separate`; reasoning
 * already inside the output total is NOT billed again (BUD-05). A per-call
 * charge without a configured price is refused — an unknown price is never $0.
 */
export function priceUsage(
  usage: NormalizedUsage,
  card: RateCard,
  perCallPrices: PerCallPrices = {}
): PricedUsage {
  const rateVersion = card.id
  const items: BillableItem[] = []
  const push = (kind: BillableItem["kind"], quantity: number, unit: string, amount: Microusd) => {
    if (quantity > 0)
      items.push({ kind, quantity, unit, amount_microusd: amount, rate_version: rateVersion })
  }
  push(
    "ordinary_input",
    usage.input_uncached_tokens,
    "token",
    costForQuantity(usage.input_uncached_tokens, card.ordinary_input_per_million)
  )
  push(
    "cache_read",
    usage.input_cache_read_tokens,
    "token",
    costForQuantity(usage.input_cache_read_tokens, card.cache_read_per_million)
  )
  push(
    "cache_write_5m",
    usage.input_cache_write_5m_tokens,
    "token",
    costForQuantity(usage.input_cache_write_5m_tokens, card.cache_write_5m_per_million)
  )
  push(
    "cache_write_1h",
    usage.input_cache_write_1h_tokens,
    "token",
    costForQuantity(usage.input_cache_write_1h_tokens, card.cache_write_1h_per_million)
  )
  push(
    "output",
    usage.output_tokens,
    "token",
    costForQuantity(usage.output_tokens, card.output_per_million)
  )
  if (!usage.reasoning_included_in_output) {
    push(
      "reasoning_separate",
      usage.reasoning_tokens,
      "token",
      costForQuantity(usage.reasoning_tokens, card.output_per_million)
    )
  }
  for (const [kind, calls] of Object.entries(usage.per_call)) {
    const price = perCallPrices[kind]
    if (price === undefined) {
      throw new UsageInconsistentError(
        `no per-call price configured for ${kind} on rate card ${card.id}`
      )
    }
    push(kind === "request" ? "request" : "tool", calls, `call:${kind}`, costPerCall(calls, price))
  }
  return { items, total_microusd: addMicrousd(...items.map((item) => item.amount_microusd)) }
}

/** The contract `Usage` object for a priced, normalized report. */
export function toContractUsage(
  usage: NormalizedUsage,
  priced: PricedUsage,
  costStatus: CostStatus,
  rawUsageArtifactId: string | null
): Usage {
  return {
    input_uncached_tokens: usage.input_uncached_tokens,
    input_cache_read_tokens: usage.input_cache_read_tokens,
    input_cache_write_tokens: usage.input_cache_write_5m_tokens + usage.input_cache_write_1h_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    reasoning_included_in_output: usage.reasoning_included_in_output,
    billable_items: priced.items,
    cost_status: costStatus,
    raw_usage_artifact_id: rawUsageArtifactId,
  }
}
