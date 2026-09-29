/**
 * Memory lint — rule-based health findings over the memory store. Report-only:
 * nothing here writes, invalidates or merges. Adapted from ai-memory's
 * `lint.rs` (+ the curator's `cold_episodic` prediction and the A5 zero-LLM
 * contradiction band detector) onto Cognia's governed rows.
 *
 * Findings carry ids and numbers, never memory text or display strings — the
 * console renders them through i18n, and the finding list is safe to log.
 *
 * Checks, in order:
 *  1. `stale` — an episodic memory older than 0.6/λ days (30 at the default λ)
 *     that has never been recalled.
 *  2. `cold_episodic` — what the lifecycle sweep would act on: decayable,
 *     uncompacted, retention below the cold threshold.
 *  3. `pinned_expiring` — pinned (exempt from forgetting) yet carrying an
 *     explicit expiry, which overrides the pin.
 *  4. `duplicate` — two or more active rows in one namespace with the same
 *     normalized text or the same stable key.
 *  5. `feedback_flagged` — still active although the user voted it down or
 *     marked it outdated.
 *  6. `conflict_open` — an unresolved contradiction awaiting review.
 *  7. `missing_evidence` — claims supported evidence, but every evidence row
 *     has since been revoked.
 *  8. `pending_instruction_aging` — a learned working preference that has
 *     waited for review longer than {@link PENDING_INSTRUCTION_REVIEW_DAYS}.
 *  9. `suspected_contradiction` — two durable (semantic / procedural) memories
 *     whose vectors are similar but not near-duplicate (cosine in [0.4, 0.75)):
 *     likely the same subject stated two different ways. Needs vectors; skipped
 *     without them.
 *
 * Pure — no I/O, clock injected.
 */

import { cosineDistance } from "@cognia/provider-embedding/density-clustering"
import type { Memory } from "../types/memory"
import { isProjectClaim } from "../types/memory"
import {
  DEFAULT_COLD_RETENTION_THRESHOLD,
  DEFAULT_RETENTION_PARAMS,
  isDecayable,
  retentionScore,
  type RetentionParams,
} from "../forget/retention"

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const MEMORY_LINT_KINDS = [
  "stale",
  "cold_episodic",
  "pinned_expiring",
  "duplicate",
  "feedback_flagged",
  "conflict_open",
  "missing_evidence",
  "pending_instruction_aging",
  "suspected_contradiction",
] as const

export type MemoryLintKind = (typeof MEMORY_LINT_KINDS)[number]
export type MemoryLintSeverity = "warning" | "info"

export interface MemoryLintFinding {
  kind: MemoryLintKind
  severity: MemoryLintSeverity
  /** The memories the finding is about; the first is the one to open. */
  memoryIds: string[]
  /** Structured numbers for the message template (days, similarity, counts). */
  metrics?: Record<string, number>
}

export const PENDING_INSTRUCTION_REVIEW_DAYS = 14
export const CONTRADICTION_SIM_LOW = 0.4
export const CONTRADICTION_SIM_HIGH = 0.75
export const CONTRADICTION_MAX_MEMORIES = 60
export const CONTRADICTION_MAX_FINDINGS = 25
/** Per-kind cap so one noisy check cannot bury the rest. */
export const MAX_FINDINGS_PER_KIND = 25

export interface LintMemoriesOptions {
  now?: number
  retention?: Partial<RetentionParams>
  coldThreshold?: number
  /** Vectors by memory id, for the contradiction band detector. */
  embeddings?: ReadonlyMap<string, readonly number[]>
}

const SEVERITY: Record<MemoryLintKind, MemoryLintSeverity> = {
  stale: "info",
  cold_episodic: "info",
  pinned_expiring: "warning",
  duplicate: "warning",
  feedback_flagged: "warning",
  conflict_open: "warning",
  missing_evidence: "info",
  pending_instruction_aging: "info",
  suspected_contradiction: "info",
}

function namespaceKey(memory: Memory): string {
  return JSON.stringify([
    memory.scope,
    memory.characterId ?? null,
    memory.projectId ?? null,
    memory.agentId ?? null,
    memory.branch ?? null,
    memory.pathPattern ?? null,
    isProjectClaim(memory),
  ])
}

function normalizeText(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Run every check over `memories`. Only active, non-snapshot rows are linted;
 * history is not a health problem.
 */
export function lintMemories(
  memories: readonly Memory[],
  options: LintMemoriesOptions = {}
): MemoryLintFinding[] {
  const now = options.now ?? Date.now()
  const params = { ...DEFAULT_RETENTION_PARAMS, ...options.retention }
  const coldThreshold = options.coldThreshold ?? DEFAULT_COLD_RETENTION_THRESHOLD
  const active = memories.filter(
    (memory) => memory.status === "active" && memory.revisionOf === undefined
  )
  const findings: MemoryLintFinding[] = []
  const counts = new Map<MemoryLintKind, number>()
  const push = (kind: MemoryLintKind, memoryIds: string[], metrics?: Record<string, number>) => {
    const count = counts.get(kind) ?? 0
    if (count >= MAX_FINDINGS_PER_KIND) return
    counts.set(kind, count + 1)
    findings.push({ kind, severity: SEVERITY[kind], memoryIds, ...(metrics ? { metrics } : {}) })
  }

  // 1. stale
  const staleAfterDays = params.lambda > 0 ? 0.6 / params.lambda : 30
  for (const memory of active) {
    if (memory.type !== "episodic" || memory.pinned || memory.accessCount > 0) continue
    const ageDays = (now - (memory.revisedAt ?? memory.createdAt)) / MS_PER_DAY
    if (ageDays > staleAfterDays) push("stale", [memory.id], { ageDays: Math.floor(ageDays) })
  }

  // 2. cold_episodic
  for (const memory of active) {
    if (!isDecayable(memory) || memory.compactedAt !== undefined) continue
    const retention = retentionScore(memory, { now, params })
    if (retention < coldThreshold) {
      push("cold_episodic", [memory.id], { retention: Math.round(retention * 1000) / 1000 })
    }
  }

  // 3. pinned_expiring
  for (const memory of active) {
    if (memory.pinned && memory.expiresAt !== null && memory.expiresAt !== undefined) {
      push("pinned_expiring", [memory.id], {
        daysUntilExpiry: Math.ceil((memory.expiresAt - now) / MS_PER_DAY),
      })
    }
  }

  // 4. duplicate — by normalized text, then by stable key, within a namespace.
  const groups = new Map<string, string[]>()
  for (const memory of active) {
    const ns = namespaceKey(memory)
    const text = normalizeText(memory.text)
    if (text)
      groups.set(`text:${ns}:${text}`, [...(groups.get(`text:${ns}:${text}`) ?? []), memory.id])
    const key = memory.key?.trim().toLocaleLowerCase()
    if (key) groups.set(`key:${ns}:${key}`, [...(groups.get(`key:${ns}:${key}`) ?? []), memory.id])
  }
  const reported = new Set<string>()
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    const signature = [...ids].sort().join(",")
    if (reported.has(signature)) continue
    reported.add(signature)
    push("duplicate", ids, { count: ids.length })
  }

  // 5. feedback_flagged
  for (const memory of active) {
    const positive = memory.retrievalFeedback?.positive ?? 0
    const negative = memory.retrievalFeedback?.negative ?? 0
    if (memory.staleness === "stale" || negative > positive) {
      push("feedback_flagged", [memory.id], { positive, negative })
    }
  }

  // 6. conflict_open
  for (const memory of active) {
    if (memory.reviewStatus === "conflict") {
      push("conflict_open", [memory.id, ...(memory.conflictWithIds ?? [])], {
        count: (memory.conflictWithIds ?? []).length,
      })
    }
  }

  // 7. missing_evidence
  for (const memory of active) {
    if (memory.evidenceState === "supported" && memory.beliefInputs?.evidenceCount === 0) {
      push("missing_evidence", [memory.id])
    }
  }

  // 8. pending_instruction_aging
  for (const memory of active) {
    if (memory.reviewStatus !== "pending_instruction") continue
    const waitedDays = (now - memory.createdAt) / MS_PER_DAY
    if (waitedDays > PENDING_INSTRUCTION_REVIEW_DAYS) {
      push("pending_instruction_aging", [memory.id], { waitedDays: Math.floor(waitedDays) })
    }
  }

  // 9. suspected_contradiction
  if (options.embeddings && options.embeddings.size > 1) {
    for (const finding of detectSuspectedContradictions(active, options.embeddings)) {
      push("suspected_contradiction", finding.memoryIds, finding.metrics)
    }
  }

  return findings
}

/**
 * The A5 band detector. Durable memories only, coldest first (least recalled,
 * then oldest) so the rows most likely to be out of date are compared first,
 * capped at {@link CONTRADICTION_MAX_MEMORIES}. The newer of each pair is listed
 * first: on a timestamp basis it is the one that supersedes.
 */
export function detectSuspectedContradictions(
  memories: readonly Memory[],
  embeddings: ReadonlyMap<string, readonly number[]>
): { memoryIds: string[]; metrics: Record<string, number> }[] {
  const eligible = memories
    .filter(
      (memory) =>
        memory.status === "active" &&
        memory.revisionOf === undefined &&
        (memory.type === "semantic" || memory.type === "procedural") &&
        memory.reviewStatus !== "conflict" &&
        embeddings.has(memory.id)
    )
    .sort(
      (a, b) =>
        a.accessCount - b.accessCount || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id)
    )
    .slice(0, CONTRADICTION_MAX_MEMORIES)
    .sort((a, b) => a.id.localeCompare(b.id))

  const out: { memoryIds: string[]; metrics: Record<string, number> }[] = []
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]
      const b = eligible[j]
      // Different namespaces are different readers' truths, not contradictions.
      if (namespaceKey(a) !== namespaceKey(b)) continue
      const similarity = 1 - cosineDistance(embeddings.get(a.id)!, embeddings.get(b.id)!)
      if (similarity < CONTRADICTION_SIM_LOW || similarity >= CONTRADICTION_SIM_HIGH) continue
      const [newer, older] =
        (b.revisedAt ?? b.createdAt) > (a.revisedAt ?? a.createdAt) ? [b, a] : [a, b]
      out.push({
        memoryIds: [newer.id, older.id],
        metrics: { similarity: Math.round(similarity * 100) / 100 },
      })
      if (out.length >= CONTRADICTION_MAX_FINDINGS) return out
    }
  }
  return out
}
