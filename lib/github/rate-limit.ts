/**
 * Wrap the GitHub `/rate_limit` endpoint into a strongly-typed snapshot.
 *
 * The endpoint is free (doesn't consume quota itself) and returns the
 * remaining headroom for every API surface — core, search, graphql, etc.
 * The Usage settings tab polls this for each registered repo to show a
 * live readout.
 */

import type { Octokit } from "@octokit/core"

export interface RateLimitBucket {
  limit: number
  used: number
  remaining: number
  /** Unix epoch seconds when this bucket resets. */
  reset: number
}

export interface RateLimitSnapshot {
  /** Repo this snapshot was taken for. */
  repoFullName: string
  /** Wall-clock ms the snapshot was captured. */
  capturedAt: number
  core: RateLimitBucket
  search: RateLimitBucket
  graphql: RateLimitBucket
}

const ZERO: RateLimitBucket = { limit: 0, used: 0, remaining: 0, reset: 0 }

interface RawResp {
  resources: {
    core?: RateLimitBucket
    search?: RateLimitBucket
    graphql?: RateLimitBucket
  }
}

export async function fetchRateLimit(
  octokit: Octokit,
  repoFullName: string,
  now: () => number = Date.now
): Promise<RateLimitSnapshot> {
  const resp = (await octokit.request("GET /rate_limit")) as { data: RawResp }
  const r = resp.data.resources ?? {}
  return {
    repoFullName,
    capturedAt: now(),
    core: r.core ?? ZERO,
    search: r.search ?? ZERO,
    graphql: r.graphql ?? ZERO,
  }
}

/**
 * Compute a 0–100 percent-remaining figure for the bar UI.
 */
export function percentRemaining(b: RateLimitBucket): number {
  if (!b.limit) return 0
  return Math.max(0, Math.min(100, Math.round((b.remaining / b.limit) * 100)))
}

/**
 * Format reset as "in X min" / "in X sec" for the Usage tab labels.
 */
export function formatReset(b: RateLimitBucket, now: number): string {
  if (!b.reset) return "—"
  const deltaSec = b.reset - Math.floor(now / 1000)
  if (deltaSec <= 0) return "now"
  if (deltaSec < 60) return `in ${deltaSec}s`
  if (deltaSec < 3600) return `in ${Math.round(deltaSec / 60)}m`
  return `in ${Math.round(deltaSec / 3600)}h`
}
