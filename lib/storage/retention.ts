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
import { recoverEvalQueueOnStartup } from "@/lib/ai/eval/recovery"
import { getSettings, DEFAULTS } from "@/lib/db/settings"
import { centralRetentionExecutorIds } from "@/lib/data-governance/table-catalog"

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

/**
 * Prune configured-window targets older than `now() - days`; `days <= 0`
 * disables only those targets. Independently expiring rows still run so a
 * trace "keep forever" preference cannot retain expired eval artifacts. Each
 * target is isolated: one failure does not abort the remaining executors.
 */
export async function pruneRetainedTables(
  days: number,
  targets: RetentionTarget[] = RETENTION_TARGETS
): Promise<RetentionResult[]> {
  const configuredWindowEnabled = Number.isFinite(days) && days > 0
  const cutoff = configuredWindowEnabled ? Date.now() - days * MS_PER_DAY : Date.now()
  const out: RetentionResult[] = []
  for (const target of targets) {
    if (
      (target.policy ?? "configured-window") === "configured-window" &&
      !configuredWindowEnabled
    ) {
      continue
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

function defaultRetentionDays(): number {
  return DEFAULTS.storageRetention?.traceRetentionDays ?? 30
}

async function readRetentionDays(): Promise<number> {
  try {
    const settings = await getSettings()
    return settings.storageRetention?.traceRetentionDays ?? defaultRetentionDays()
  } catch {
    return defaultRetentionDays()
  }
}

async function sweepOnce(): Promise<void> {
  const days = await readRetentionDays()
  await pruneRetainedTables(days)
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
