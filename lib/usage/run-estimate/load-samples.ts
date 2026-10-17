/**
 * Read the run history an estimate is computed from (ADR-0232).
 *
 * On demand, never on a timer: a launch surface asks when it renders, and the
 * result is kept in memory for {@link SAMPLE_CACHE_TTL_MS} so several hints on
 * one page, or re-renders while a dialog is open, share one read. No table is
 * added and nothing is written; every source is an existing table read inside
 * the 90-day estimate window.
 */

import { getDb } from "@/lib/db/schema"
import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"

import { ESTIMATE_WINDOW_MS, type RunSample } from "./estimate"
import type { ExternalPresetResolver } from "./harness"
import { buildRunSamples, type ScheduledSessionRef } from "./samples"

export const SAMPLE_CACHE_TTL_MS = 5 * 60_000

/** What an estimate is computed against: the history and the agent lookup it was built with. */
export interface RunEstimateContext {
  samples: RunSample[]
  resolvePreset: ExternalPresetResolver
}

interface CacheEntry extends RunEstimateContext {
  at: number
  db: unknown
}

let cache: CacheEntry | null = null
let inflight: Promise<RunEstimateContext> | null = null

/** The preset each external-agent configuration on this device was made from. */
async function defaultPresetResolver(): Promise<ExternalPresetResolver> {
  const { useExternalAgentStore } = await import("@/stores/agent/external-agent-store")
  const agents = useExternalAgentStore.getState().agents ?? {}
  return (configId) => externalAgentPresetIdOf(agents[configId])
}

/** Sessions that can hold a scheduled task's conversation: plain chat rows only. */
function chatSessionIds(
  rows: readonly { sessionId: string; surface?: string; imported?: boolean }[]
) {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.imported) continue
    if (row.surface !== undefined && row.surface !== "chat") continue
    ids.add(row.sessionId)
  }
  return [...ids]
}

async function readSamples(now: number, resolvePreset: ExternalPresetResolver) {
  const db = getDb()
  const since = now - ESTIMATE_WINDOW_MS
  const [usageRows, goals, teamRuns, bestOfN] = await Promise.all([
    db.sessionUsage.where("at").aboveOrEqual(since).toArray(),
    db.chatGoals.where("updatedAt").aboveOrEqual(since).toArray(),
    db.executionRuns
      .where("kind")
      .equals("team")
      .filter((run) => (run.endedAt ?? 0) >= since)
      .toArray(),
    db.bestOfNRuns.where("updatedAt").aboveOrEqual(since).toArray(),
  ])
  const sessionIds = chatSessionIds(usageRows)
  const [teamChildRuns, sessions] = await Promise.all([
    teamRuns.length > 0
      ? db.agentTeamChildRuns
          .where("runId")
          .anyOf(teamRuns.map((run) => run.sourceId))
          .toArray()
      : Promise.resolve([]),
    sessionIds.length > 0 ? db.sessions.bulkGet(sessionIds) : Promise.resolve([]),
  ])
  const scheduledSessions: ScheduledSessionRef[] = []
  for (const session of sessions) {
    if (session?.origin?.kind === "scheduled-task") {
      scheduledSessions.push({ id: session.id, origin: session.origin })
    }
  }
  return buildRunSamples({
    usageRows,
    goals,
    teamRuns,
    teamChildRuns,
    bestOfN,
    scheduledSessions,
    resolvePreset,
  })
}

export interface LoadRunSamplesOptions {
  now?: number
  /** Injected in tests; defaults to the external-agent store. */
  resolvePreset?: ExternalPresetResolver
}

/**
 * Every run sample inside the estimate window, with the external-agent lookup
 * used to key them, from cache when fresh. Concurrent callers share one read.
 */
export async function loadRunEstimateContext(
  options: LoadRunSamplesOptions = {}
): Promise<RunEstimateContext> {
  const now = options.now ?? Date.now()
  const db = getDb()
  if (cache && cache.db === db && now - cache.at < SAMPLE_CACHE_TTL_MS) {
    return { samples: cache.samples, resolvePreset: cache.resolvePreset }
  }
  if (inflight) return inflight
  inflight = (async () => {
    const resolvePreset = options.resolvePreset ?? (await defaultPresetResolver())
    const samples = await readSamples(now, resolvePreset)
    cache = { at: now, db, samples, resolvePreset }
    return { samples, resolvePreset }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export function __resetRunSampleCacheForTesting(): void {
  cache = null
  inflight = null
}
