/**
 * Three-factor memory retrieval scoring (Generative Agents):
 *
 *   score = wRecency·norm(recency) + wImportance·norm(importance) + wRelevance·norm(relevance)
 *
 * with all weights = 1 and each factor min-max normalized across the candidate
 * set. `recency` is an exponential decay (0.995^Δdays) over time-since-last-
 * access; `importance` is the LLM 1–10 rating; `relevance` is the fused hybrid
 * similarity (vector+BM25 via `reciprocalRankFusion`) computed by the retriever.
 *
 * Pure — no I/O, no clock except the injected `now`. The retriever applies the
 * relevance floor on the *raw* fused score before calling this; this module
 * only ranks.
 */

import type { Memory, MemoryProvenance, MemoryType } from "../types/memory"

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_RECENCY_DECAY = 0.995

/**
 * Per-type recency half-life multipliers over the configured base half-life
 * (`MemoryConfig.decayHalfLifeDays`). Events fade fast, durable working
 * instructions linger — so the same "days since last access" costs an episodic
 * memory more than a procedural one. Applied only when the caller supplies a
 * per-memory `halfLifeDays` (see `recencyHalfLifeDaysForType`); the generic
 * `decay ^ ageDays` path is untouched when it is absent.
 */
export const RECENCY_HALF_LIFE_MULTIPLIER: Record<MemoryType, number> = {
  episodic: 0.5,
  semantic: 1,
  procedural: 2,
}

/** Resolve a memory's recency half-life (days) from its type + a base half-life. */
export function recencyHalfLifeDaysForType(type: MemoryType, baseHalfLifeDays: number): number {
  return Math.max(0, baseHalfLifeDays) * RECENCY_HALF_LIFE_MULTIPLIER[type]
}

/**
 * Source-trust weight in [0,1] — how much we believe a fact by where it came
 * from. A user-stated / user-captured fact outranks an API-written one
 * (`external`: plugin / MCP / RPC), which outranks an app-seeded one, which
 * outranks a third-party inbound one. This is a *ranking* signal only; it never
 * relaxes the provenance injection gate in `applyMemoryContext` (an inbound
 * memory still can never become procedural).
 */
export const PROVENANCE_VERACITY: Record<MemoryProvenance, number> = {
  user: 1,
  explicit: 1,
  external: 0.85,
  system: 0.7,
  inbound: 0.5,
}

/** Veracity for a memory — pinned facts are fully trusted; else by provenance. */
export function veracityFor(m: { provenance: MemoryProvenance; pinned?: boolean }): number {
  if (m.pinned) return 1
  return PROVENANCE_VERACITY[m.provenance]
}

export interface ScorableMemory {
  /** LLM-rated 1..10. */
  importance: number
  /** Epoch ms of last access (or creation). */
  lastAccessedAt: number
  /** Fused hybrid similarity in [0,1] (already floored by the caller). */
  relevance: number
  /**
   * Per-memory recency half-life (days). When present and > 0, recency uses a
   * `0.5 ^ (ageDays / halfLifeDays)` half-life curve (per-type decay) instead of
   * the generic `recencyDecay ^ ageDays`. Absent → generic decay (back-compat).
   */
  halfLifeDays?: number
  /**
   * Source-trust weight in [0,1] (see `veracityFor`). When ANY candidate
   * supplies it, veracity becomes a 4th ranking factor; when none do, it
   * contributes nothing (identical to the prior three-factor score).
   */
  veracity?: number
  /** Combined confidence/review/feedback/staleness/contamination trust in [0,1]. */
  governance?: number
}

export interface MemoryScoreParts {
  recency: number
  importance: number
  relevance: number
  veracity: number
  governance: number
}

export interface ScoredMemory<T> {
  memory: T
  score: number
  parts: MemoryScoreParts
}

export interface ScoreOptions {
  /** Reference time; defaults to `Date.now()`. */
  now?: number
  /** Per-day decay base in (0,1]; defaults to 0.995. */
  recencyDecay?: number
  /** Factor weights; default all 1. */
  weights?: Partial<MemoryScoreParts>
}

/** Min-max normalize to [0,1]. When all values are equal, returns 1s (neutral). */
function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return []
  let min = values[0]
  let max = values[0]
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (range === 0) return values.map(() => 1)
  return values.map((v) => (v - min) / range)
}

/**
 * Recency in (0,1], clamped at age ≥ 0. With a per-memory `halfLifeDays` it uses
 * a `0.5 ^ (ageDays / halfLifeDays)` half-life curve (per-type decay); otherwise
 * the generic `decay ^ ageDays`.
 */
function rawRecency(
  lastAccessedAt: number,
  now: number,
  decay: number,
  halfLifeDays?: number
): number {
  const ageDays = Math.max(0, (now - lastAccessedAt) / MS_PER_DAY)
  if (typeof halfLifeDays === "number" && halfLifeDays > 0) {
    return Math.pow(0.5, ageDays / halfLifeDays)
  }
  return Math.pow(decay, ageDays)
}

export function scoreMemories<T extends ScorableMemory>(
  memories: T[],
  opts: ScoreOptions = {}
): ScoredMemory<T>[] {
  if (memories.length === 0) return []
  const now = opts.now ?? Date.now()
  const decay = opts.recencyDecay ?? DEFAULT_RECENCY_DECAY
  const wRecency = opts.weights?.recency ?? 1
  const wImportance = opts.weights?.importance ?? 1
  const wRelevance = opts.weights?.relevance ?? 1
  const wVeracity = opts.weights?.veracity ?? 1
  const wGovernance = opts.weights?.governance ?? 1

  const recencyRaw = memories.map((m) => rawRecency(m.lastAccessedAt, now, decay, m.halfLifeDays))
  const importanceRaw = memories.map((m) => Math.min(10, Math.max(1, m.importance)) / 10)
  const relevanceRaw = memories.map((m) => m.relevance)

  const recency = minMaxNormalize(recencyRaw)
  const importance = minMaxNormalize(importanceRaw)
  const relevance = minMaxNormalize(relevanceRaw)

  // Veracity is opt-in: only a factor when at least one candidate supplies it,
  // so a caller that never sets `veracity` gets the exact prior three-factor
  // score (undefined → neutral 0.5, then zeroed out so it contributes nothing).
  const hasVeracity = memories.some((m) => typeof m.veracity === "number")
  const veracityRaw = memories.map((m) => (typeof m.veracity === "number" ? m.veracity : 0.5))
  const veracity = hasVeracity ? minMaxNormalize(veracityRaw) : memories.map(() => 0)
  const hasGovernance = memories.some((m) => typeof m.governance === "number")
  const governanceRaw = memories.map((m) => (typeof m.governance === "number" ? m.governance : 0.5))
  const governance = hasGovernance ? minMaxNormalize(governanceRaw) : memories.map(() => 0)

  return memories
    .map((memory, i) => {
      const parts: MemoryScoreParts = {
        recency: recency[i],
        importance: importance[i],
        relevance: relevance[i],
        veracity: veracity[i],
        governance: governance[i],
      }
      const score =
        wRecency * parts.recency +
        wImportance * parts.importance +
        wRelevance * parts.relevance +
        wVeracity * parts.veracity +
        wGovernance * parts.governance
      return { memory, score, parts }
    })
    .sort((a, b) => b.score - a.score)
}

/** Governance signals are ranking-only; hard exclusions stay in the retriever. */
export function governanceScoreFor(memory: Memory): number {
  const confidence = memory.confidence ?? 0.5
  const review =
    memory.reviewStatus === "verified"
      ? 1
      : memory.reviewStatus === "unreviewed" || memory.reviewStatus === undefined
        ? 0.6
        : 0
  const contamination =
    memory.contaminationState === "clean"
      ? 1
      : memory.contaminationState === "external-context"
        ? 0.4
        : 0.7
  const staleness =
    memory.staleness === "fresh"
      ? 1
      : memory.staleness === "stale"
        ? 0.3
        : memory.staleness === "expired"
          ? 0
          : 0.7
  const trust =
    memory.trustState === "trusted"
      ? 1
      : memory.trustState === "untrusted"
        ? 0.5
        : memory.trustState === "quarantined"
          ? 0
          : 0.7
  const positive = Math.max(0, memory.retrievalFeedback?.positive ?? 0)
  const negative = Math.max(0, memory.retrievalFeedback?.negative ?? 0)
  const feedback = (positive + 1) / (positive + negative + 2)
  return (confidence + review + contamination + staleness + trust + feedback) / 6
}
