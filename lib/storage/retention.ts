/**
 * Storage retention sweeper — the upper-bound time window for otherwise
 * unbounded Dexie tables.
 *
 * Several tables self-cap with an LRU ring buffer (audit logs, telemetry), but
 * `agentTraces` has neither a cap nor a scheduled prune: its `pruneOlderThan`
 * helper existed yet had no production caller, so spans accumulated forever and
 * every read fell back to a full-table scan justified by a "low thousands of
 * rows" assumption nothing enforced. This module enforces it.
 *
 * Mirrors `lib/automation/audit-retention.ts`:
 *  - `pruneRetainedTables(days)` — one-shot prune of every {@link RetentionTarget}
 *    older than `now() - days`. `days <= 0` means "keep everything". Returns the
 *    per-target removed counts so a diagnostics surface can show how hard
 *    retention is cutting.
 *  - `startStorageRetentionSweeper()` — boot-time wiring: an initial prune plus a
 *    daily `setInterval`, returning an unsubscribe handle. Each sweep re-reads
 *    the live `storageRetention.traceRetentionDays` so a Settings change takes
 *    effect on the next sweep. Never throws.
 */

import { pruneOlderThan as pruneAgentTraces } from "@/lib/db/agent-traces"
import { deleteExpiredEvalArtifacts } from "@/lib/db/eval-lab"
import { purgeOcrCacheOlderThan } from "@/lib/db/ocr-results"
import { pruneExpiredWorkSubmissionPayloads } from "@/lib/db/work-submissions"
import { recoverEvalQueueOnStartup } from "@/lib/ai/eval/recovery"
import { getSettings, DEFAULTS } from "@/lib/db/settings"
import { centralRetentionExecutorIds, policyForTable } from "@/lib/data-governance/table-catalog"
import { pruneExpiredWorkflowAppData } from "@/lib/workflow/apps/retention-service"
import { pruneOnlineEvalData } from "@/lib/db/eval-online"
import {
  SITE_ARTIFACT_GC_DEFAULTS,
  collectUnreferencedSiteArtifacts,
} from "@/lib/sites/artifact-gc"

const MS_PER_DAY = 86_400_000
/** Re-sweep cadence — once per day matches the resolution of `traceRetentionDays`. */
export const RETENTION_SWEEP_INTERVAL_MS = MS_PER_DAY

export type Unsubscribe = () => void

/** A prunable table: `prune` deletes every row older than the absolute epoch
 * cutoff and returns the count removed. */
export interface RetentionTarget {
  id: string
  policy?: "configured-window" | "row-expiry"
  prune: (cutoffEpochMs: number) => Promise<number>
}

/** The tables the sweeper manages. Extensible — add a `{ id, prune }` entry to
 * bring another unbounded table under the same time-window policy. */
const RETENTION_EXECUTORS: Record<string, Omit<RetentionTarget, "id">> = {
  // Sites build archives (ADR-0084). The cutoff carries the configured window;
  // the reference rules — serving deployments, the rollback target, anything
  // behind an unfinished operation — are the collector's own and are not
  // negotiable by a setting.
  siteArtifacts: {
    policy: "configured-window",
    prune: async (cutoff) => {
      const now = Date.now()
      const report = await collectUnreferencedSiteArtifacts({
        now,
        keepDays: Math.max(0, (now - cutoff) / MS_PER_DAY),
        keepReadyVersionsPerSite: SITE_ARTIFACT_GC_DEFAULTS.keepReadyVersionsPerSite,
      })
      return report.deletedDigests.length
    },
  },
  agentTraces: {
    policy: "configured-window",
    prune: (cutoff) => pruneAgentTraces(cutoff),
  },
  evalArtifacts: {
    policy: "row-expiry",
    prune: async () => {
      const removed = await deleteExpiredEvalArtifacts()
      return removed.samplesDeleted + removed.assetsDeleted
    },
  },
  ocrResults: {
    policy: "configured-window",
    prune: (cutoff) => {
      const now = Date.now()
      return purgeOcrCacheOlderThan(Math.max(0, now - cutoff), now)
    },
  },
  // Frozen submission input/context expire on their own `expiresAt`, not the
  // user's trace window: a replay must stay possible for the full retention
  // period regardless of how aggressively traces are pruned.
  workSubmissions: {
    policy: "row-expiry",
    prune: () => pruneExpiredWorkSubmissionPayloads(Date.now()),
  },
  workflowAppData: {
    policy: "row-expiry",
    prune: () => pruneExpiredWorkflowAppData(Date.now()),
  },
  // Online-evaluation bookkeeping (ADR-0101). Each of the three tables has its
  // own window, and the windows are READ FROM THE CATALOG rather than restated
  // here — a constant copied out of a policy is a constant that drifts from it.
  evalOnline: {
    policy: "row-expiry",
    prune: () => {
      const now = Date.now()
      const windowFor = (table: string, fallbackDays: number) =>
        now - (policyForTable(table)?.retentionPolicy.days ?? fallbackDays) * MS_PER_DAY
      return pruneOnlineEvalData({
        observationsBefore: windowFor("evalObservations", 90),
        queueBefore: windowFor("evalOnlineQueue", 7),
        budgetBefore: windowFor("evalOnlineBudget", 90),
      })
    },
  },
}

function governedRetentionTargets(): RetentionTarget[] {
  return centralRetentionExecutorIds().map((id) => {
    const executor = RETENTION_EXECUTORS[id]
    if (!executor) throw new Error(`Missing central retention executor: ${id}`)
    return { id, ...executor }
  })
}

export const RETENTION_TARGETS: RetentionTarget[] = governedRetentionTargets()

export interface RetentionResult {
  id: string
  removed: number
}

export type RetentionDaysByTarget = Readonly<Record<string, number>>

/**
 * Prune configured-window targets older than `now() - days`; `days <= 0`
 * disables only those targets. Independently expiring rows still run so a
 * trace "keep forever" preference cannot retain expired eval artifacts. Each
 * target is isolated: one failure does not abort the remaining executors.
 */
export async function pruneRetainedTables(
  days: number,
  targets: RetentionTarget[] = RETENTION_TARGETS,
  retentionDaysByTarget: RetentionDaysByTarget = {}
): Promise<RetentionResult[]> {
  const out: RetentionResult[] = []
  for (const target of targets) {
    const policy = target.policy ?? "configured-window"
    let cutoff = Date.now()
    if (policy === "configured-window") {
      const targetDays = retentionDaysByTarget[target.id] ?? days
      if (!Number.isFinite(targetDays) || targetDays <= 0) continue
      cutoff -= targetDays * MS_PER_DAY
    }
    try {
      const removed = await target.prune(cutoff)
      out.push({ id: target.id, removed })
    } catch (err) {
      console.warn(`storage retention prune failed for ${target.id}`, err)
      out.push({ id: target.id, removed: 0 })
    }
  }
  return out
}

interface RetentionWindows {
  traceRetentionDays: number
  ocrCacheTtlDays: number
}

function defaultRetentionWindows(): RetentionWindows {
  return {
    traceRetentionDays: DEFAULTS.storageRetention?.traceRetentionDays ?? 30,
    ocrCacheTtlDays: DEFAULTS.ocrSettings?.cacheTtlDays ?? 30,
  }
}

async function readRetentionWindows(): Promise<RetentionWindows> {
  try {
    const settings = await getSettings()
    const defaults = defaultRetentionWindows()
    return {
      traceRetentionDays:
        settings.storageRetention?.traceRetentionDays ?? defaults.traceRetentionDays,
      ocrCacheTtlDays: settings.ocrSettings?.cacheTtlDays ?? defaults.ocrCacheTtlDays,
    }
  } catch {
    return defaultRetentionWindows()
  }
}

async function sweepOnce(): Promise<void> {
  const windows = await readRetentionWindows()
  await pruneRetainedTables(windows.traceRetentionDays, RETENTION_TARGETS, {
    ocrResults: windows.ocrCacheTtlDays,
  })
}

/**
 * Run an initial prune and schedule a recurring one every 24h. Returns an
 * `Unsubscribe` that cancels the timer. Never throws — a failed sweep is logged
 * and the timer keeps running for the next window.
 */
export async function startStorageRetentionSweeper(): Promise<Unsubscribe> {
  await recoverEvalQueueOnStartup().catch((err) =>
    console.warn("evaluation queue recovery failed", err)
  )
  await sweepOnce().catch((err) => console.warn("storage retention sweep failed", err))
  const id = setInterval(() => {
    void sweepOnce().catch((err) => console.warn("storage retention sweep failed", err))
  }, RETENTION_SWEEP_INTERVAL_MS)
  return () => clearInterval(id)
}
