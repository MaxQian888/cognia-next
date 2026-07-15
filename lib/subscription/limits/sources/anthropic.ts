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
import { classifyUsageError, fetchOAuthUsage } from "@/lib/subscription/anthropic/usage-endpoint"
import type { OAuthUsageResult } from "@/lib/subscription/anthropic/usage-endpoint"

import { errorLimits, windowMeter } from "../meters"

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
) => Promise<OAuthUsageResult>

export interface AnthropicLimitsSourceOptions {
  /** Free OAuth-usage fetcher (primary). Tests inject a stub. */
  fetchUsage?: FetchUsageFn
  /** Paid probe (fallback). Tests inject a stub. Pass `null` to disable the fallback. */
  probe?: ProbeFn | null
}

/** Assemble a successful snapshot for this account. */
function snapshotOf(ctx: LimitsSourceContext, meters: LimitsMeter[]): ProviderLimits {
  return {
    provider: "anthropic",
    accountId: ctx.accountId,
    accountLabel: ctx.accountLabel,
    fetchedAt: ctx.now,
    meters,
  }
}

/**
 * `fetchOAuthUsage` reports failures rather than throwing, but an injected stub
 * may still throw — normalize both into the same result shape.
 */
async function callUsage(
  fetchUsage: FetchUsageFn,
  token: string,
  ctx: LimitsSourceContext
): Promise<OAuthUsageResult> {
  try {
    return await fetchUsage(token, { authedGet: ctx.authedGet })
  } catch (err) {
    return classifyUsageError(err)
  }
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

      // 1) Free OAuth usage endpoint (no token cost, 4+ windows).
      let result = await callUsage(fetchUsage, token, ctx)

      // 1b) Reactive refresh + retry — now driven by a real 401/403 rather than
      // an empty-list guess, so a throttled or reshaped response no longer
      // burns a token refresh. This is the seam that keeps the panel alive past
      // the ~8h bearer expiry.
      if (!result.ok && result.kind === "auth" && ctx.refreshToken) {
        const refreshed = await ctx.refreshToken().catch(() => null)
        if (refreshed && refreshed !== token) {
          token = refreshed
          result = await callUsage(fetchUsage, token, ctx)
        }
      }

      if (result.ok && result.meters.length > 0) {
        return snapshotOf(ctx, result.meters)
      }

      // A throttle / outage / expired bearer / broken contract is NOT "no
      // windows". Surface it (cc-switch returns the HTTP status + body the same
      // way) instead of silently returning null — which rendered as a blank
      // panel next to a stale number, with nothing in the log. The paid probe
      // shares the same bearer and endpoint, so it would fail identically:
      // skipping it here also saves ~10 tokens per poll.
      if (!result.ok) {
        return errorLimits(ctx, "anthropic", result.message)
      }

      // 2) Paid probe fallback — only when the endpoint genuinely reported no
      // windows (a well-formed response we simply have no meters for).
      if (probe) {
        try {
          // `probeOnce` only reads `accessToken`; the rest of the shape is unused.
          const outcome = await probe({ accessToken: token } as AnthropicCredentialData)
          const meters = metersFromProbe(outcome, ctx.now)
          if (meters.length > 0) return snapshotOf(ctx, meters)
        } catch {
          // The probe is a best-effort fallback; its failure is not the story.
        }
      }

      return null
    },
  }
}

/** Default instance used by the registry. */
export const anthropicLimitsSource = createAnthropicLimitsSource()
