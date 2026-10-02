/**
 * Public probe summaries: what each registered observer is, what it runs and
 * whether it is currently reporting. Observer health is published separately
 * from service health so a stopped probe reads as "monitoring degraded", never
 * as an outage of the relay.
 */

import {
  type ProbeHealth,
  type ProbeSummary,
  type ReasonCode,
} from "../../../../../lib/status/contract"
import { minuteOf, toIso } from "../../../../../lib/status/derive"
import { loadRecentEvidence, runSucceeded, type RecentEvidence, type RecentRun } from "./evidence"
import {
  freshnessForCadence,
  referenceForMinute,
  type ProbeRecord,
  type Registry,
} from "../registry/registry"

function fastestCadence(probe: ProbeRecord): number | null {
  const cadences = probe.profiles.flatMap((profile) =>
    [profile.httpCadenceSeconds, profile.protocolCadenceSeconds].filter(
      (value): value is number => value !== null
    )
  )
  return cadences.length === 0 ? null : Math.min(...cadences)
}

interface LastSeen {
  attemptMs: number | null
  successMs: number | null
  latestRun: RecentRun | null
}

function lastSeenFromRecent(probeId: string, evidence: RecentEvidence): LastSeen {
  let latestRun: RecentRun | null = null
  let successMs: number | null = null
  for (const run of evidence.runs) {
    if (run.probeId !== probeId) continue
    if (!latestRun || run.finishedAtMs > latestRun.finishedAtMs) latestRun = run
    if (runSucceeded(run) && (successMs === null || run.finishedAtMs > successMs)) {
      successMs = run.finishedAtMs
    }
  }
  return { attemptMs: latestRun?.finishedAtMs ?? null, successMs, latestRun }
}

/**
 * Older history for a probe that has been quiet for the whole recent window.
 * Uses the (probe_id, profile_id, scheduled_at) index; bounded to 60 rows.
 */
async function lastSeenFromHistory(db: D1Database, probeId: string): Promise<LastSeen> {
  const rows = await db
    .prepare(
      `SELECT finished_at, checks_json FROM probe_runs WHERE probe_id = ?
       ORDER BY scheduled_at DESC LIMIT 60`
    )
    .bind(probeId)
    .all<{ finished_at: number; checks_json: string }>()
  const list = rows.results ?? []
  const attemptMs = list[0]?.finished_at ?? null
  const success = list.find((row) => runSucceeded({ checks: JSON.parse(row.checks_json) }))
  return { attemptMs, successMs: success?.finished_at ?? null, latestRun: null }
}

export function probeHealth(
  probe: ProbeRecord,
  seen: LastSeen,
  nowMs: number
): { health: ProbeHealth; reason: ReasonCode | null } {
  // Disabled or retired is an operator decision; not yet enrolled is simply
  // "no evidence yet".
  if (probe.disabled || (probe.retiredAtMs !== null && nowMs >= probe.retiredAtMs)) {
    return { health: "disabled", reason: null }
  }
  if (nowMs < probe.enrolledAtMs) return { health: "unknown", reason: "missing" }
  if (seen.attemptMs === null) return { health: "unknown", reason: "missing" }
  const freshMs = freshnessForCadence(fastestCadence(probe))
  if (nowMs - seen.attemptMs > freshMs) return { health: "stale", reason: "stale" }
  if (seen.latestRun && !runSucceeded(seen.latestRun))
    return { health: "error", reason: "runner_error" }
  return { health: "healthy", reason: null }
}

export async function summarizeProbes(
  db: D1Database,
  registry: Registry,
  nowMs: number,
  evidence?: RecentEvidence
): Promise<ProbeSummary[]> {
  const recent = evidence ?? (await loadRecentEvidence(db, nowMs))
  const reference = referenceForMinute(registry, minuteOf(nowMs))
  const summaries: ProbeSummary[] = []
  for (const probe of registry.probes.values()) {
    if (probe.retiredAtMs !== null && probe.retiredAtMs <= nowMs) continue
    let seen = lastSeenFromRecent(probe.id, recent)
    if (seen.attemptMs === null) seen = await lastSeenFromHistory(db, probe.id)
    const { health, reason } = probeHealth(probe, seen, nowMs)
    summaries.push({
      id: probe.id,
      label: probe.label,
      source: probe.source,
      location: probe.location,
      provider: probe.provider,
      profiles: probe.profiles.map((profile) => ({
        id: profile.id,
        cadenceSeconds: Math.min(
          ...[profile.httpCadenceSeconds, profile.protocolCadenceSeconds].filter(
            (value): value is number => value !== null
          )
        ),
        simulatedOrigin: profile.id !== "native",
      })),
      reference: reference?.probeId === probe.id,
      enrolledAt: toIso(probe.enrolledAtMs),
      lastAttemptAt: seen.attemptMs === null ? null : toIso(seen.attemptMs),
      lastSuccessAt: seen.successMs === null ? null : toIso(seen.successMs),
      health,
      reason,
    })
  }
  return summaries
}
