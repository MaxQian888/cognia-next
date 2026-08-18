/**
 * Provider-usage alias normalization — the renderer-side mirror.
 *
 * Hand-mirrors `sidecar/dispatch/usage-normalize.mjs` because the sidecar
 * cannot import from `lib/`. `usage-normalize.parity.test.ts` imports both and
 * asserts they agree across a provider matrix, so editing one without the other
 * goes red.
 *
 * See the sidecar module for why this exists: the same alias table used to be
 * copied into three files, which is why Anthropic's cache-TTL split and the
 * `server_tool_use` counters reached none of them.
 */

/** Loose provider usage block — every provider spells these differently. */
export interface RawProviderUsage {
  promptTokens?: number
  inputTokens?: number
  input_tokens?: number
  completionTokens?: number
  outputTokens?: number
  output_tokens?: number
  contextInputTokens?: number
  cacheCreationInputTokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cacheCreation?: {
    ephemeral5mInputTokens?: number
    ephemeral1hInputTokens?: number
  }
  cacheReadInputTokens?: number
  cache_read_input_tokens?: number
  cachedInputTokens?: number
  prompt_cache_hit_tokens?: number
  promptCacheHitTokens?: number
  reasoningTokens?: number
  reasoning_tokens?: number
  inputTokenDetails?: { cacheWriteTokens?: number; cacheReadTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
  server_tool_use?: Record<string, number>
  serverToolUse?: Record<string, number>
}

/** Cache-creation tokens split by billing TTL. */
export interface CacheCreationSplit {
  total: number
  ephemeral5m: number
  ephemeral1h: number
}

/** Normalized snake_case usage block, as carried on a `result` message. */
export interface NormalizedUsageBlock {
  input_tokens: number
  output_tokens: number
  context_input_tokens?: number
  cache_creation_input_tokens: number
  cache_creation?: {
    ephemeral_5m_input_tokens: number
    ephemeral_1h_input_tokens: number
  }
  cache_read_input_tokens: number
  reasoning_tokens: number
  server_tool_use?: Record<string, number>
}

/** First defined, finite, non-negative number among the candidates, else 0. */
function firstNumber(...candidates: Array<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c
  }
  return 0
}

/**
 * Cache-creation tokens split by TTL. The two TTLs bill differently (1.25× vs
 * 2× base input), so collapsing them under-bills 1-hour writes. A flat total
 * with no split is left un-split and priced at the 5-minute rate downstream,
 * matching Anthropic's default TTL.
 */
export function normalizeCacheCreation(usage: RawProviderUsage | undefined): CacheCreationSplit {
  const detail = usage?.cache_creation ?? usage?.cacheCreation ?? undefined
  const ephemeral5m = firstNumber(
    (detail as { ephemeral_5m_input_tokens?: number } | undefined)?.ephemeral_5m_input_tokens,
    (detail as { ephemeral5mInputTokens?: number } | undefined)?.ephemeral5mInputTokens
  )
  const ephemeral1h = firstNumber(
    (detail as { ephemeral_1h_input_tokens?: number } | undefined)?.ephemeral_1h_input_tokens,
    (detail as { ephemeral1hInputTokens?: number } | undefined)?.ephemeral1hInputTokens
  )
  const flat = firstNumber(
    usage?.cacheCreationInputTokens,
    usage?.cache_creation_input_tokens,
    usage?.inputTokenDetails?.cacheWriteTokens
  )
  const total = flat > 0 ? flat : ephemeral5m + ephemeral1h
  return { total, ephemeral5m, ephemeral1h }
}

/**
 * Server-side tool invocation counters. Billed per call independently of
 * tokens — web search is $10/1,000 requests — so dropping them made that spend
 * structurally invisible.
 */
export function normalizeServerToolUse(
  usage: RawProviderUsage | undefined
): Record<string, number> | undefined {
  const raw = usage?.server_tool_use ?? usage?.serverToolUse
  if (!raw || typeof raw !== "object") return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    out[key.replace(/_requests$/, "")] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Normalize any provider usage block into the renderer-facing shape. */
export function normalizeUsageBlock(usage: RawProviderUsage | undefined): NormalizedUsageBlock {
  const u = usage ?? {}
  const cacheCreation = normalizeCacheCreation(u)
  const serverToolUse = normalizeServerToolUse(u)
  return {
    input_tokens: firstNumber(u.promptTokens, u.inputTokens, u.input_tokens),
    output_tokens: firstNumber(u.completionTokens, u.outputTokens, u.output_tokens),
    ...(typeof u.contextInputTokens === "number"
      ? { context_input_tokens: u.contextInputTokens }
      : {}),
    cache_creation_input_tokens: cacheCreation.total,
    ...(cacheCreation.ephemeral5m > 0 || cacheCreation.ephemeral1h > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: cacheCreation.ephemeral5m,
            ephemeral_1h_input_tokens: cacheCreation.ephemeral1h,
          },
        }
      : {}),
    cache_read_input_tokens: firstNumber(
      u.cacheReadInputTokens,
      u.cache_read_input_tokens,
      u.cachedInputTokens,
      u.inputTokenDetails?.cacheReadTokens,
      u.prompt_cache_hit_tokens,
      u.promptCacheHitTokens
    ),
    reasoning_tokens: firstNumber(
      u.reasoningTokens,
      u.reasoning_tokens,
      u.outputTokenDetails?.reasoningTokens
    ),
    ...(serverToolUse ? { server_tool_use: serverToolUse } : {}),
  }
}

/**
 * A provider payload that may spell the token counts either flat (`inputTokens:
 * number`) or nested (`inputTokens: { total, cacheRead, cacheWrite }`). Both
 * occur in the wild, so the field is widened by omission rather than
 * intersected with {@link RawProviderUsage} — intersecting `number` with an
 * object type yields `never`.
 */
type NestedProviderUsage = Omit<RawProviderUsage, "inputTokens" | "outputTokens"> & {
  inputTokens?: number | { total?: number; cacheRead?: number; cacheWrite?: number }
  outputTokens?: number | { total?: number; reasoning?: number }
}

/** AI SDK v7 nested usage shape used by the feature-call path. */
export interface LanguageModelUsageShape {
  inputTokens: {
    total: number | undefined
    noCache: number | undefined
    cacheRead: number | undefined
    cacheWrite: number | undefined
  }
  outputTokens: {
    total: number | undefined
    text: number | undefined
    reasoning: number | undefined
  }
}

/**
 * First defined finite number among the candidates, or `undefined`.
 *
 * Distinct from {@link firstNumber}: the nested shape must preserve "not
 * reported" as `undefined` rather than collapsing it to 0, because 0 there
 * means "the provider reported zero".
 */
function firstNumberOrUndefined(...candidates: Array<number | undefined>): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c
  }
  return undefined
}

/**
 * Normalize any provider usage block into the AI SDK v7 nested
 * `LanguageModelUsage` shape. Shares the alias table with
 * {@link normalizeUsageBlock} — the two differ only in output shape.
 */
export function toLanguageModelUsage(
  usage: RawProviderUsage | undefined = {}
): LanguageModelUsageShape {
  // `RawProviderUsage` declares the flat `inputTokens?: number` spelling, but
  // the AI SDK v7 payload nests them. Intersecting the two collapses the field
  // to `never`, so widen by omission instead of intersection.
  const u = (usage ?? {}) as NestedProviderUsage
  const nestedIn = typeof u.inputTokens === "object" ? u.inputTokens : undefined
  const flatIn = typeof u.inputTokens === "number" ? u.inputTokens : undefined
  const nestedOut = typeof u.outputTokens === "object" ? u.outputTokens : undefined
  const flatOut = typeof u.outputTokens === "number" ? u.outputTokens : undefined

  const input = firstNumberOrUndefined(u.promptTokens, nestedIn?.total, flatIn)
  const output = firstNumberOrUndefined(u.completionTokens, nestedOut?.total, flatOut)
  const cacheRead = firstNumberOrUndefined(
    u.cachedInputTokens,
    u.inputTokenDetails?.cacheReadTokens,
    nestedIn?.cacheRead,
    u.cacheReadInputTokens,
    u.prompt_cache_hit_tokens,
    u.promptCacheHitTokens
  )
  const cacheWrite = firstNumberOrUndefined(
    u.cacheCreationInputTokens,
    u.inputTokenDetails?.cacheWriteTokens,
    nestedIn?.cacheWrite
  )
  const reasoning = firstNumberOrUndefined(
    u.reasoningTokens,
    u.outputTokenDetails?.reasoningTokens,
    nestedOut?.reasoning
  )
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0)),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  }
}
