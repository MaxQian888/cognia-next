/**
 * Retention — how strongly a memory deserves to be KEPT, as opposed to how
 * relevant it is to a query (`retrieve/scoring.ts`).
 *
 * Ported from ai-memory's `decay.rs`:
 *
 *   time    = salience · e^(−λ · ageDays)
 *   access  = σ · ln(1 + accessCount) · e^(−μ · daysSinceAccess)
 *   retention = time + access
 *
 * `ageDays` counts from when the current text took effect (`revisedAt`, else
 * `createdAt`), so a rewrite is a fresh start. `daysSinceAccess` counts from
 * the last recall, and a memory that was never recalled gets no access term.
 * The access term can only ever ADD retention, which is why it is on by default:
 * memory you keep using decays slower, memory nobody touches fades on the time
 * curve alone.
 *
 * Salience is ai-memory's per-page feedback weight (0.25 … 2.0, default 1).
 * Cognia already records the same signal as `retrievalFeedback`, so salience is
 * derived from it rather than stored twice: each net helpful verdict adds a
 * step, each net unhelpful one removes a step, and a memory the user marked
 * outdated (`staleness: "stale"`) drops straight to the floor.
 *
 * Retention is used by forgetting only — eviction ranking and the lifecycle
 * sweep's cold selection. Recall ranking deliberately does not read it: a
 * memory must not rank higher merely because it was recalled before.
 *
 * Pure — no I/O, clock injected.
 */

import type { Memory } from "../types/memory"

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const SALIENCE_MIN = 0.25
export const SALIENCE_MAX = 2
export const SALIENCE_STEP = 0.25
export const SALIENCE_DEFAULT = 1

export interface RetentionParams {
  /** Time-decay rate per day (≈ 35-day half-life at 0.02). */
  lambda: number
  /** Access-boost magnitude. 0 disables reinforcement. */
  sigma: number
  /** Decay of the access boost per day since last recall. */
  mu: number
}

export const DEFAULT_RETENTION_PARAMS: RetentionParams = {
  lambda: 0.02,
  sigma: 0.6,
  mu: 0.04,
}

/** Below this retention an episodic memory is a lifecycle-sweep candidate. */
export const DEFAULT_COLD_RETENTION_THRESHOLD = 0.2

/** λ for a half-life in days. Non-positive or non-finite input falls back to the default λ. */
export function lambdaFromHalfLifeDays(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return DEFAULT_RETENTION_PARAMS.lambda
  return Math.LN2 / halfLifeDays
}

export type RetentionMemory = Pick<
  Memory,
  "createdAt" | "lastAccessedAt" | "accessCount" | "retrievalFeedback" | "staleness"
> &
  Partial<Pick<Memory, "revisedAt">>

/** Feedback-derived salience in [0.25, 2]. */
export function salienceFor(memory: Pick<Memory, "retrievalFeedback" | "staleness">): number {
  if (memory.staleness === "stale" || memory.staleness === "expired") return SALIENCE_MIN
  const positive = Math.max(0, memory.retrievalFeedback?.positive ?? 0)
  const negative = Math.max(0, memory.retrievalFeedback?.negative ?? 0)
  const salience = SALIENCE_DEFAULT + SALIENCE_STEP * (positive - negative)
  return Math.min(SALIENCE_MAX, Math.max(SALIENCE_MIN, salience))
}

/**
 * Whether the row has ever been recalled.
 *
 * `createMemory` seeds `lastAccessedAt = createdAt` and `accessCount = 0`, so a
 * zero count is the only reliable "never recalled" marker — a timestamp equal to
 * the creation time could also be a recall in the same millisecond.
 */
function everAccessed(memory: RetentionMemory): boolean {
  return memory.accessCount > 0
}

export function retentionScore(
  memory: RetentionMemory,
  options: { now?: number; params?: Partial<RetentionParams> } = {}
): number {
  const now = options.now ?? Date.now()
  const params = { ...DEFAULT_RETENTION_PARAMS, ...options.params }
  const lambda = Number.isFinite(params.lambda) && params.lambda >= 0 ? params.lambda : 0
  const sigma = Number.isFinite(params.sigma) && params.sigma >= 0 ? params.sigma : 0
  const mu = Number.isFinite(params.mu) && params.mu >= 0 ? params.mu : 0

  const effectiveFrom = memory.revisedAt ?? memory.createdAt
  const ageDays = Math.max(0, (now - effectiveFrom) / MS_PER_DAY)
  const time = salienceFor(memory) * Math.exp(-lambda * ageDays)
  if (!everAccessed(memory) || sigma === 0) return time

  const idleDays = Math.max(0, (now - memory.lastAccessedAt) / MS_PER_DAY)
  const access = sigma * Math.log1p(Math.max(0, memory.accessCount)) * Math.exp(-mu * idleDays)
  return time + access
}

/**
 * Whether the lifecycle sweep may treat a row as cold.
 *
 * Mirrors ai-memory's `is_decayable`: only episodic memory decays. Semantic
 * facts and procedural instructions are durable by definition, pinned rows are
 * exempt, and mined project claims have their own evidence-based lifecycle
 * (`claim-support.ts`) that retention must not second-guess.
 */
export function isDecayable(
  memory: Pick<Memory, "type" | "pinned" | "status" | "projectMemoryKind">
): boolean {
  return (
    memory.status === "active" &&
    memory.type === "episodic" &&
    !memory.pinned &&
    memory.projectMemoryKind === undefined
  )
}
