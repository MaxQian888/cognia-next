/**
 * Read-only derivations that turn the memory tables into the numbers the
 * Settings → Memory pane shows. Every function here is pure over already-loaded
 * rows — the Dexie reads live in `lib/db/memory-governance.ts` and the hook, so
 * these stay trivially unit-testable without a database.
 *
 * Two things are deliberately *not* estimated here:
 *  - whether recall is actually hybrid (that is `describeMemoryRetrievalMode`
 *    in `lib/memory/runtime/build-deps.ts`, which reads the live backend), and
 *  - what a given query would recall (that is `applyMemoryContext`, the same
 *    entry point a real turn uses).
 */

import { createContextManager } from "@cognia/rag/context-manager"
import { computeMemoryStats, type MemoryStats } from "@/lib/memory/history-filter"
import type { Memory, MemoryScope } from "@/types/memory/memory"
import {
  MEMORY_JOB_KINDS,
  type MemoryAuditEvent,
  type MemoryJob,
  type MemoryJobKind,
} from "@/types/memory/governance"

/**
 * Audit `reason` values written by the decay and PII-gate instrumentation.
 * The presence of any of these is what makes a maintenance window reportable
 * exactly rather than heuristically — writers and reader must agree, so both
 * sides are pinned by tests.
 */
export const MEMORY_DECAY_REASONS = ["idle", "capacity"] as const
export const MEMORY_PII_BLOCK_REASON = "pii_blocked"
export const INSTRUMENTED_MAINTENANCE_REASONS = [
  ...MEMORY_DECAY_REASONS,
  MEMORY_PII_BLOCK_REASON,
] as const

const SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]

export type MemoryScopeCounts = Record<MemoryScope, number>

export interface MemoryCorpusInsights {
  stats: MemoryStats
  /** Active rows per scope. */
  byScope: MemoryScopeCounts
  vector: {
    /** Active rows carrying a `vectorDocId`. */
    embedded: number
    active: number
    /** `embedded / active`, or 0 when there is nothing active. */
    coverage: number
  }
  /**
   * Mean estimated tokens of one recalled line, using the same estimator and
   * the same `- ${text}` framing the real packer applies in
   * `applyMemoryContext`. 0 when there is nothing active.
   */
  averageTokens: number
}

/** One pass over the corpus — everything the overview and budget bar need. */
export function computeMemoryCorpusInsights(memories: Memory[]): MemoryCorpusInsights {
  const stats = computeMemoryStats(memories)
  const byScope = Object.fromEntries(SCOPES.map((s) => [s, 0])) as MemoryScopeCounts
  // `estimateTokens` is chars/`charsPerToken` — `maxTokens` never enters into it.
  const counter = createContextManager()
  let embedded = 0
  let tokenTotal = 0

  for (const memory of memories) {
    if (memory.status !== "active") continue
    byScope[memory.scope] = (byScope[memory.scope] ?? 0) + 1
    if (memory.vectorDocId) embedded++
    tokenTotal += counter.estimateTokens(`- ${memory.text}`)
  }

  return {
    stats,
    byScope,
    vector: {
      embedded,
      active: stats.active,
      coverage: stats.active > 0 ? embedded / stats.active : 0,
    },
    averageTokens: stats.active > 0 ? tokenTotal / stats.active : 0,
  }
}

export interface RecallBudgetEstimate {
  /** How many memories could be injected — `topK` capped by what actually exists. */
  lines: number
  /** Estimated tokens those lines would consume. */
  estimatedTokens: number
  tokenBudget: number
  /** `estimatedTokens / tokenBudget`, clamped to [0, 1] for the bar width. */
  fill: number
  /** True when the estimate exceeds the budget — the packer would drop lines. */
  overBudget: boolean
}

/**
 * The upper-bound cost of a turn's recall, from config alone. Deliberately does
 * not run retrieval: this has to update on every slider frame, and the honest
 * per-query answer is what the dry-run sandbox is for.
 */
export function estimateRecallBudget(input: {
  averageTokens: number
  activeCount: number
  topK: number
  tokenBudget: number
}): RecallBudgetEstimate {
  const lines = Math.max(0, Math.min(input.topK, input.activeCount))
  const estimatedTokens = Math.round(lines * input.averageTokens)
  const tokenBudget = Math.max(1, input.tokenBudget)
  return {
    lines,
    estimatedTokens,
    tokenBudget: input.tokenBudget,
    fill: Math.max(0, Math.min(1, estimatedTokens / tokenBudget)),
    overBudget: estimatedTokens > input.tokenBudget,
  }
}

export interface MemoryJobKindSummary {
  kind: MemoryJobKind
  queued: number
  running: number
  /** Rows that failed but are still within the retry budget (status back to `queued`). */
  retrying: number
  /** Rows that exhausted retries. */
  failed: number
  lastCompletedAt?: number
  lastErrorCode?: string
}

// Derived so a new job kind shows up in the console instead of being invisible.
const JOB_KINDS: readonly MemoryJobKind[] = MEMORY_JOB_KINDS

/**
 * Queue health per job kind. `retrying` and `queued` are distinguishable only
 * by `retryCount` — `failMemoryJob` puts a retryable failure back to `queued`
 * with an `errorCode`, and only flips to `failed` once retries run out.
 */
export function summarizeMemoryJobs(jobs: MemoryJob[]): MemoryJobKindSummary[] {
  return JOB_KINDS.map((kind) => {
    const own = jobs.filter((job) => job.kind === kind)
    const summary: MemoryJobKindSummary = {
      kind,
      queued: 0,
      running: 0,
      retrying: 0,
      failed: 0,
    }
    for (const job of own) {
      if (job.status === "running") summary.running++
      else if (job.status === "queued" || job.status === "retry_wait") {
        if (job.retryCount > 0) summary.retrying++
        else summary.queued++
      } else if (job.status === "failed") {
        summary.failed++
        summary.lastErrorCode ??= job.errorCode
      } else if (
        (job.status === "succeeded" || job.status === "no_output") &&
        job.completedAt !== undefined
      ) {
        if (summary.lastCompletedAt === undefined || job.completedAt > summary.lastCompletedAt) {
          summary.lastCompletedAt = job.completedAt
        }
      }
    }
    return summary
  })
}

/** Which accounting the maintenance summary is reporting. */
export type MaintenanceAccounting =
  /** The whole window is covered by instrumentation — the split is exact. */
  | { kind: "exact" }
  /**
   * Instrumentation started inside the window. The split is exact from
   * `preciseSince` onward; `unattributed` rows fell off before that.
   */
  | { kind: "partial"; preciseSince: number; unattributed: number }
  /** No instrumented event exists at all — the single total is an estimate. */
  | { kind: "estimated" }

export interface MemoryMaintenanceSummary {
  /** Rows invalidated because they sat unused past `maxIdleDays`. */
  idle: number
  /** Rows invalidated because a scope exceeded `maxActivePerScope`. */
  capacity: number
  /** Writes the PII gate refused. */
  piiBlocked: number
  /**
   * Every automatic invalidation in the window, however attributed. Equals
   * `idle + capacity` under `exact`, and is the only trustworthy number under
   * `estimated`.
   */
  autoInvalidated: number
  accounting: MaintenanceAccounting
}

/**
 * Reconcile the two data sources for "what did maintenance do lately".
 *
 * The precise source is the audit trail, which only exists from the moment the
 * instrumentation shipped. The heuristic source is the `memories` table itself:
 * a row that is `invalidated` inside the window with no `supersededById` was
 * almost certainly retired by decay rather than by consolidation (which links
 * the superseding row) or by the user (whose deletes are hard deletes). That
 * heuristic cannot tell idle from capacity, which is why it only ever produces
 * a single total.
 */
export function summarizeMemoryMaintenance(input: {
  events: MemoryAuditEvent[]
  memories: Memory[]
  windowStart: number
  /** Earliest instrumented audit event ever, or `undefined` if none exists. */
  preciseSince?: number
}): MemoryMaintenanceSummary {
  const inWindow = input.events.filter((event) => event.createdAt >= input.windowStart)
  const idle = inWindow.filter((e) => e.action === "invalidated" && e.reason === "idle").length
  const capacity = inWindow.filter(
    (e) => e.action === "invalidated" && e.reason === "capacity"
  ).length
  const piiBlocked = inWindow.filter((e) => e.reason === MEMORY_PII_BLOCK_REASON).length

  const heuristicTotal = input.memories.filter(
    (m) =>
      m.status === "invalidated" &&
      m.supersededById === undefined &&
      m.invalidatedAt !== undefined &&
      m.invalidatedAt >= input.windowStart
  ).length

  if (input.preciseSince === undefined) {
    return {
      idle: 0,
      capacity: 0,
      piiBlocked: 0,
      autoInvalidated: heuristicTotal,
      accounting: { kind: "estimated" },
    }
  }

  if (input.preciseSince <= input.windowStart) {
    return {
      idle,
      capacity,
      piiBlocked,
      autoInvalidated: idle + capacity,
      accounting: { kind: "exact" },
    }
  }

  // Instrumentation began mid-window: attribute what we can, and count the
  // rest rather than silently under-reporting.
  const unattributed = Math.max(0, heuristicTotal - (idle + capacity))
  return {
    idle,
    capacity,
    piiBlocked,
    autoInvalidated: idle + capacity + unattributed,
    accounting: { kind: "partial", preciseSince: input.preciseSince, unattributed },
  }
}
