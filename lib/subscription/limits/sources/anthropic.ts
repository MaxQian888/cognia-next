// Anthropic windowed-usage limits source.
//
// Wraps the existing `probeOnce` (`anthropic/usage-probe.ts`) + the pure
// `summarizeCurrentWindow` analytics so the unified `/limits` panel shows the
// same 5h-session / 7d-week utilization the desktop Usage tab does. The probe
// is exposed as a constructor seam so tests stay offline.

import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"
import type { ProbeOutcome } from "@/lib/subscription/anthropic/usage-probe"
import { summarizeCurrentWindow } from "@/lib/subscription/anthropic/usage-analytics"

import { windowMeter } from "../meters"

import type {
  AnthropicCredentialData,
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

export type ProbeFn = (credential: AnthropicCredentialData) => Promise<ProbeOutcome>

/**
 * Build the Anthropic limits source. `probe` defaults to the shared
 * `probeOnce`; tests inject a stub. Matches only the `anthropic` provider —
 * the windows are reported on a Pro/Max subscription session.
 */
export function createAnthropicLimitsSource(probe: ProbeFn = probeOnce): LimitsSource {
  return {
    key: "anthropic",
    matches(q) {
      return q.provider === "anthropic"
    },
    async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
      if (!ctx.token) return null
      // `probeOnce` only reads `accessToken`; the rest of the shape is unused.
      let outcome: ProbeOutcome
      try {
        outcome = await probe({ accessToken: ctx.token } as AnthropicCredentialData)
      } catch {
        return null
      }
      if (!outcome.ok) return null

      const summary = summarizeCurrentWindow(outcome.snapshot, { now: ctx.now })
      if (!summary) return null

      const meters: LimitsMeter[] = []
      if (summary.fiveHour) {
        meters.push(
          windowMeter("session", "subscription.limits.meter.session", {
            utilization: summary.fiveHour.utilization,
            resetAt: summary.fiveHour.resetAt,
          })
        )
      }
      if (summary.sevenDay) {
        meters.push(
          windowMeter("weekly", "subscription.limits.meter.weekly", {
            utilization: summary.sevenDay.utilization,
            resetAt: summary.sevenDay.resetAt,
          })
        )
      }
      if (meters.length === 0) return null

      return {
        provider: "anthropic",
        accountId: ctx.accountId,
        accountLabel: ctx.accountLabel,
        fetchedAt: ctx.now,
        meters,
      }
    },
  }
}

/** Default instance used by the registry. */
export const anthropicLimitsSource = createAnthropicLimitsSource()
