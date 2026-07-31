// Volcengine (火山方舟) Agent/Coding Plan windowed-usage source.
//
// Unlike the Bearer coding-plan providers (GLM/Kimi/MiniMax, which ship as
// declarative descriptors), Volcengine's usage OpenAPI requires a SigV4
// signature over an AccessKey ID + Secret — a second credential distinct from
// the inference bearer the account stores. So this is a hand-written source that
// reads the AK/SK from the preset's `x-cognia-volc-*` extraHeaders (an internal
// namespace the sidecar env-builder strips, so the account-wide AK/SK never
// rides on a chat request) and calls the Rust `subscription_volcengine_usage`
// command, which does the signing + GetAFPUsage/GetCodingPlanUsage probing.

import { volcengineUsage as defaultQuery } from "@/lib/subscription/core/transport"
import type { VolcengineUsageResult } from "@/lib/subscription/core/transport"

import { errorLimits, windowMeter } from "../meters"

import type {
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

export type VolcengineQueryFn = (
  accessKeyId: string,
  secretAccessKey: string,
  baseUrl: string
) => Promise<VolcengineUsageResult>

/** Preset extraHeaders keys holding the AK/SK (case-insensitive; `x-cognia-*`). */
const AK_KEYS = ["x-cognia-volc-access-key-id", "x-cognia-volc-accesskey-id", "x-cognia-volc-ak"]
const SK_KEYS = ["x-cognia-volc-secret-access-key", "x-cognia-volc-secretkey", "x-cognia-volc-sk"]

const LABEL_KEY: Record<string, string> = {
  session: "subscription.limits.meter.session",
  weekly: "subscription.limits.meter.weekly",
  monthly: "subscription.limits.meter.monthly",
}

/** Case-insensitive lookup of the first non-empty value among `keys`. */
function headerLookup(headers: Record<string, string> | undefined, keys: string[]): string | null {
  if (!headers) return null
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  for (const k of keys) {
    const v = lower[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

export interface VolcengineLimitsSourceOptions {
  /** The usage query. Tests inject a stub; defaults to the Rust command. */
  query?: VolcengineQueryFn
}

/**
 * Build the Volcengine limits source. Matches the `volcengine-agentplan` relay
 * preset (or any `volces.com` baseUrl). Returns `null` when the AK/SK aren't
 * configured (quota simply unavailable) or when the account has no subscription;
 * surfaces an auth failure inline so the user knows to fix the AK/SK.
 */
export function createVolcengineLimitsSource(
  options: VolcengineLimitsSourceOptions = {}
): LimitsSource {
  const query = options.query ?? defaultQuery

  return {
    key: "volcengine",
    matches(q) {
      if (q.providerKey === "volcengine-agentplan") return true
      return q.baseUrl?.includes("volces.com") ?? false
    },
    async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
      if (!ctx.baseUrl) return null
      const accessKeyId = headerLookup(ctx.presetHeaders, AK_KEYS)
      const secretAccessKey = headerLookup(ctx.presetHeaders, SK_KEYS)
      // AK/SK not configured → quota unavailable (don't error, just no meters).
      if (!accessKeyId || !secretAccessKey) return null

      let result: VolcengineUsageResult
      try {
        result = await query(accessKeyId, secretAccessKey, ctx.baseUrl)
      } catch (err) {
        return errorLimits(ctx, "volcengine", err instanceof Error ? err.message : String(err))
      }

      if (!result.ok) {
        // Surface an auth failure inline; a "no subscription" soft error → null
        // so the runner falls through (nothing else matches, UI shows "no data").
        return result.auth_error
          ? errorLimits(ctx, "volcengine", result.error ?? "Volcengine authentication failed")
          : null
      }

      const meters: LimitsMeter[] = []
      for (const tier of result.tiers) {
        const labelKey = LABEL_KEY[tier.name] ?? LABEL_KEY.session
        const parsed = tier.resets_at ? Date.parse(tier.resets_at) : NaN
        meters.push(
          windowMeter(tier.name, labelKey, {
            utilization: tier.utilization,
            resetAt: Number.isFinite(parsed) ? parsed : null,
          })
        )
      }
      if (meters.length === 0) return null

      return {
        provider: "volcengine",
        accountId: ctx.accountId,
        accountLabel: ctx.accountLabel,
        fetchedAt: ctx.now,
        meters,
      }
    },
  }
}

/** Default instance used by the registry. */
export const volcengineLimitsSource = createVolcengineLimitsSource()
