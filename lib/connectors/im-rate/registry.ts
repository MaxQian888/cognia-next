/**
 * IM rate-source resolver — the connector-side consumer of the plugin
 * `im-rate-source` overlay (mirrors `resolveLimitsSources` in
 * `lib/subscription/limits/registry.ts`, but IM-scoped and overlay-only).
 *
 * There are no built-in IM rate sources today, so the resolved list is exactly
 * the plugin overlay filtered by `matches`. `evaluateImRate` runs each matching
 * source in registration order and returns the FIRST block decision (advisory:
 * a source can only further restrict, never relax, the built-in policy). A
 * source that throws is treated as abstain so a buggy plugin can't wedge IM.
 */

import { listImRateSourceEntries } from "@/lib/plugin/registries/im-rate-source-registry"
import type { ImRateSource } from "@/types/connectors/im-rate-source"

/** Resolve the ordered IM rate sources matching a query (plugin overlay only). */
export function resolveImRateSources(q: { adapterId: string; platform: string }): ImRateSource[] {
  return listImRateSourceEntries()
    .map((e) => e.entry)
    .filter((s) => s.matches(q))
}

export interface ImRateBlock {
  reason: string
  /** The source key that produced the block (diagnostics). */
  key: string
}

/**
 * Evaluate every matching IM rate source. Returns the first `{allow:false}`
 * decision as an `ImRateBlock`, or `null` when all sources permit/abstain (send
 * proceeds). Never throws — a source error is swallowed as abstain.
 */
export async function evaluateImRate(ctx: {
  adapterId: string
  conversationKey: string
  platform: string
  now: number
}): Promise<ImRateBlock | null> {
  const sources = resolveImRateSources({ adapterId: ctx.adapterId, platform: ctx.platform })
  for (const source of sources) {
    let decision: { allow: boolean; reason?: string } | null = null
    try {
      decision = await source.evaluate(ctx)
    } catch {
      decision = null // a throwing source abstains — never wedge IM
    }
    if (decision && decision.allow === false) {
      return { reason: decision.reason ?? "plugin_rate_limited", key: source.key }
    }
  }
  return null
}
