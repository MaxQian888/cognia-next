// Anthropic windowed-usage limits source.
//
// Primary reading is the FREE `GET /api/oauth/usage` endpoint
// (`anthropic/usage-endpoint.ts`) — zero token cost and it carries the
// 7-day opus/sonnet windows the header path can't show. Only when that yields
// nothing do we fall back to the paid `probeOnce` (`anthropic/usage-probe.ts`),
// which spends ~10 tokens. Both seams are injected so tests stay offline.

import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"
import type { ProbeOutcome } from "@/lib/subscription/anthropic/usage-probe"
import { summarizeCurrentWindow } from "@/lib/subscription/anthropic/usage-analytics"
import { fetchOAuthUsage } from "@/lib/subscription/anthropic/usage-endpoint"

import { windowMeter } from "../meters"

import type {
  AnthropicCredentialData,
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

export type ProbeFn = (credential: AnthropicCredentialData) => Promise<ProbeOutcome>
export type FetchUsageFn = (
  token: string,
  deps: { authedGet: LimitsSourceContext["authedGet"] }
) => Promise<LimitsMeter[]>

export interface AnthropicLimitsSourceOptions {
  /** Free OAuth-usage fetcher (primary). Tests inject a stub. */
  fetchUsage?: FetchUsageFn
  /** Paid probe (fallback). Tests inject a stub. Pass `null` to disable the fallback. */
  probe?: ProbeFn | null
}

/** Build the meters from a probe outcome (paid fallback path). */
function metersFromProbe(outcome: ProbeOutcome, now: number): LimitsMeter[] {
  if (!outcome.ok) return []
  const summary = summarizeCurrentWindow(outcome.snapshot, { now })
  if (!summary) return []
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
  return meters
}

/**
 * Build the Anthropic limits source. Tries the free OAuth usage endpoint first,
 * then the paid probe. Matches only the `anthropic` provider — the windows are
 * reported on a Pro/Max subscription session.
 */
export function createAnthropicLimitsSource(
  options: AnthropicLimitsSourceOptions = {}
): LimitsSource {
  const fetchUsage = options.fetchUsage ?? fetchOAuthUsage
  const probe = options.probe === undefined ? probeOnce : options.probe

  return {
    key: "anthropic",
    matches(q) {
      return q.provider === "anthropic"
    },
    async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
      if (!ctx.token) return null
      let token = ctx.token

      // 1) Free OAuth usage endpoint (no token cost, 4 windows).
      let meters: LimitsMeter[] = []
      try {
        meters = await fetchUsage(token, { authedGet: ctx.authedGet })
      } catch {
        meters = []
      }

      // 1b) Reactive refresh + retry. The free endpoint returns `[]` on a 401
      // (the error is swallowed one layer down in `fetchOAuthUsage`), so an
      // expired bearer is indistinguishable from "no windows" here. Refresh the
      // token once and retry before spending tokens on the paid probe. Mirrors
      // the (dormant) scheduler's 401 handling — this is the seam that keeps the
      // Claude quota panel working past the ~8h token expiry.
      if (meters.length === 0 && ctx.refreshToken) {
        const refreshed = await ctx.refreshToken().catch(() => null)
        if (refreshed && refreshed !== token) {
          token = refreshed
          try {
            meters = await fetchUsage(token, { authedGet: ctx.authedGet })
          } catch {
            meters = []
          }
        }
      }

      // 2) Paid probe fallback (only if the free endpoint gave nothing).
      if (meters.length === 0 && probe) {
        try {
          // `probeOnce` only reads `accessToken`; the rest of the shape is unused.
          const outcome = await probe({ accessToken: token } as AnthropicCredentialData)
          meters = metersFromProbe(outcome, ctx.now)
        } catch {
          meters = []
        }
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
