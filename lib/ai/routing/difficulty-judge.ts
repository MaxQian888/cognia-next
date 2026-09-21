/**
 * Second-opinion difficulty judge — the optional model tier of Auto routing
 * (ADR-0043 Phase 10).
 *
 * Structurally the same thing as `lib/claude/permissions/command-judge.ts`, and
 * deliberately so: a deterministic classifier handles the common cases offline,
 * and a cheap background model is consulted only where the deterministic answer
 * is genuinely uncertain. That module's shape — PII gate before the call, short
 * JSON-only reply, hard timeout, cache with a TTL and an LRU bound, `null` on
 * anything unexpected — is the shape a judge has to have to be safe to add to a
 * hot path, so it is reused rather than reinvented.
 *
 * What it is NOT: an always-on classifier. `ProviderRoutingEngine` calls this
 * only when the deterministic score sits inside the uncertainty band around a
 * tier boundary. An unambiguous prompt never reaches it, so the median request
 * pays 0 ms and only the genuinely ambiguous minority pays the round trip.
 *
 * Failure is always `null`, never a throw and never a guess: the caller keeps
 * the deterministic tier, so this layer can only improve a decision the router
 * was already unsure about.
 *
 * Router + Fusion (ADR-0188 D18, B5): the opt-in LLM classifier absorbs this
 * judge. Only while the `utilityLedger` surface — the one the judge's own call
 * is booked on — is on AND `llmClassifier.enabled`, a consultation is answered
 * by one classification (ledgered, PII-gated, 1500 ms, HMAC-cached) whose labels
 * name the tier. Otherwise — every user by default — the judge below runs
 * exactly as it always has, and no Router + Fusion module is loaded.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RoutingDifficultyTier } from "@cognia/provider-types/auto-router"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii } from "@cognia/redact"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { RouterFusionInfrastructureError } from "@/lib/router-fusion/gate/faults"
import { breakerThresholdOf, routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"
import { runOrdinaryWithFallback } from "@/lib/router-fusion/gate/guard"

export interface DifficultyVerdict {
  tier: RoutingDifficultyTier
  /** Model-reported confidence in [0, 1]; absent when it did not supply one. */
  confidence?: number
}

/**
 * Hard ceiling on the judge's round trip.
 *
 * Sized against the published economics of LLM routing: a judge call costs
 * roughly 400 ms, while the always-on deterministic path must stay under a few
 * tens of milliseconds. Those are two different budgets for two different
 * layers, and conflating them is what makes people believe routing is slow.
 */
export const DIFFICULTY_JUDGE_TIMEOUT_MS = 400

const CACHE_TTL_MS = 5 * 60 * 1_000
const MAX_CACHE = 200
/** Enough text to judge intent; the tail rarely changes the answer. */
const PROMPT_EXCERPT = 1_500

interface CacheEntry {
  at: number
  value: DifficultyVerdict | null
}
const cache = new Map<string, CacheEntry>()

/** Test seam — clear the memoization cache. */
export function __resetDifficultyJudgeCache(): void {
  cache.clear()
}

const SYSTEM_PROMPT =
  "You classify how much model capability a request needs. " +
  '"fast" = short factual answers, rewriting, formatting, simple lookups. ' +
  '"balanced" = ordinary multi-step work, everyday coding, summarising a document. ' +
  '"powerful" = hard reasoning, novel algorithms, long multi-constraint tasks, subtle debugging. ' +
  'Respond with ONLY a JSON object: {"tier": "fast"|"balanced"|"powerful", "confidence": 0..1}. ' +
  "No prose, no code fences."

function coerceTier(value: unknown): RoutingDifficultyTier | null {
  return value === "fast" || value === "balanced" || value === "powerful" ? value : null
}

function coerceConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

function evict(): void {
  if (cache.size <= MAX_CACHE) return
  const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at)[0]
  if (oldest) cache.delete(oldest[0])
}

export interface JudgeDifficultyInput {
  promptText: string
  /** Included in the prompt as a prior, so the judge is nudging, not guessing. */
  deterministicTier?: RoutingDifficultyTier
  timeoutMs?: number
  /**
   * Cache TTL in ms; defaults to {@link CACHE_TTL_MS}. `0` disables the cache
   * entirely — no reads, no writes — for hosts whose settings turn verdict
   * caching off.
   */
  cacheTtlMs?: number
  now?: () => number
}

/** The surface the judge's own call is booked on: it is a background utility call. */
const JUDGE_SURFACE = "utilityLedger" as const

/** Test seam: where the gate reads the settings from. */
export interface JudgeDifficultyRouting {
  settings?: () => Promise<AppSettings | null>
}

async function gateSettings(read: () => Promise<AppSettings | null>): Promise<AppSettings | null> {
  try {
    return await read()
  } catch (error) {
    // An unreadable switch never turns Router + Fusion on.
    console.warn("[router-fusion] settings unreadable; the difficulty judge runs as before", error)
    return null
  }
}

/**
 * Ask a cheap model which tier this prompt needs.
 *
 * Returns `null` — never throws — when the prompt is empty, carries PII, the
 * model fails or times out, or the reply cannot be parsed. Every one of those
 * means "the deterministic tier stands".
 *
 * With Router + Fusion's LLM classifier absorbing the judge (see the module
 * note), the classifier answers instead; an infrastructure fault reaching it
 * sends the consultation down the original path below, unledgered, and counts
 * towards the surface breaker (D38).
 */
export async function judgeDifficulty(
  client: LlmClient,
  input: JudgeDifficultyInput,
  routing: JudgeDifficultyRouting = {}
): Promise<DifficultyVerdict | null> {
  const settings = await gateSettings(routing.settings ?? currentRouterFusionGateSettings)
  if (
    routerFusionGate(settings, JUDGE_SURFACE) !== "on" ||
    settings?.routerFusion?.llmClassifier?.enabled !== true
  ) {
    return judgeDifficultyDirect(client, input)
  }
  const absorbedBy = settings
  return runOrdinaryWithFallback<DifficultyVerdict | null>({
    surface: JUDGE_SURFACE,
    threshold: breakerThresholdOf(absorbedBy),
    fusion: async () => {
      const classifier = await import("@/lib/router-fusion/routing/llm-classifier").catch(
        (error: unknown) => {
          throw new RouterFusionInfrastructureError(
            "import_failed",
            `The Router + Fusion classifier could not be loaded: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error
          )
        }
      )
      return classifier.judgeDifficultyWithClassifier(absorbedBy, {
        promptText: input.promptText,
      })
    },
    onBypass: (notice) => {
      console.warn(
        "[router-fusion] the difficulty judge ran on the original path, unledgered",
        notice.fault
      )
    },
    original: () => judgeDifficultyDirect(client, input),
  })
}

/** The judge itself: what `judgeDifficulty` has always done. */
async function judgeDifficultyDirect(
  client: LlmClient,
  input: JudgeDifficultyInput
): Promise<DifficultyVerdict | null> {
  const now = input.now ?? Date.now
  const trimmed = (input.promptText ?? "").trim().slice(0, PROMPT_EXCERPT)
  if (!trimmed) return null

  const cacheTtlMs = input.cacheTtlMs ?? CACHE_TTL_MS
  const cacheKey = `${input.deterministicTier ?? "-"}::${trimmed}`
  const cached = cacheTtlMs > 0 ? cache.get(cacheKey) : undefined
  if (cached && now() - cached.at < cacheTtlMs) return cached.value

  // The prompt is the user's own text. It never leaves for a routing decision
  // if it carries anything the redaction gate objects to — a routing hint is
  // not worth a disclosure, and the deterministic score already answers.
  if (!hasNoLeakingPii(trimmed)) return null

  let result: DifficultyVerdict | null = null
  try {
    const prior = input.deterministicTier
      ? `\nA heuristic guessed: ${input.deterministicTier}. Correct it only if clearly wrong.`
      : ""
    const text = await withTimeout(
      client.complete(`Request:\n${trimmed}${prior}`, {
        system: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 24,
      }),
      input.timeoutMs ?? DIFFICULTY_JUDGE_TIMEOUT_MS
    )
    if (text === null) {
      // Timed out. Deliberately NOT cached: the next request may be answered
      // in time, and caching a timeout would turn one slow moment into five
      // minutes of a disabled judge.
      return null
    }
    const raw = extractJson<{ tier?: unknown; confidence?: unknown }>(text)
    const tier = coerceTier(raw.tier)
    if (tier) {
      const confidence = coerceConfidence(raw.confidence)
      result = { tier, ...(confidence !== undefined ? { confidence } : {}) }
    }
  } catch {
    result = null
  }

  if (cacheTtlMs > 0) {
    cache.set(cacheKey, { at: now(), value: result })
    evict()
  }
  return result
}

/** Resolve to `null` on expiry, with the timer cleared on either outcome. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Bind the judge to the engine's injected seam.
 *
 * The engine takes a plain function so `@cognia/provider-routing` stays free of
 * any LLM dependency — the same reason `getPricing` and `getCapabilities` are
 * injected. A host with no utility client simply passes nothing and keeps a
 * purely deterministic router.
 */
export function createDifficultyJudge(
  loadClient: () => LlmClient | null,
  options: { timeoutMs?: number; cacheTtlMs?: number } = {}
): (input: {
  promptText: string
  deterministicTier: RoutingDifficultyTier
}) => Promise<DifficultyVerdict | null> {
  return async (input) => {
    const client = loadClient()
    if (!client) return null
    return judgeDifficulty(client, {
      promptText: input.promptText,
      deterministicTier: input.deterministicTier,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    })
  }
}
