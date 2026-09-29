/**
 * Belief strength — how well corroborated a memory is, derived from its
 * evidence rows. Ported from ai-memory's `belief.rs`.
 *
 *   residual   = max(evidenceCount − distinctSessions, 0)
 *   breadth    = distinctSessions + min(0.2 · residual, 1)
 *   support    = 1 − e^(−breadth / 3)
 *   recency    = 0.5 + 0.5 · e^(−age / 30 days)          (1 when age is unknown)
 *   conflicts  = 1 / (1 + liveContradictions)
 *   belief     = clamp(support · recency · conflicts, 0, 0.95)
 *
 * Anti-entrenchment guards, all deliberate:
 * - breadth counts DISTINCT sessions — one chatty session restating a fact ten
 *   times is still one witness; extra rows only add a capped residual credit;
 * - evidence that has not been refreshed for months shades toward 0.5×;
 * - an open contradiction divides the score;
 * - the cap stays below 1, so nothing learned ever reads as certain.
 *
 * No evidence at all yields `null`, not 0: legacy rows predate evidence
 * tracking, and "unknown" must never be presented as "disbelieved".
 *
 * Pure — no I/O, clock injected.
 */

import type { MemoryEvidence } from "../types/governance"
import type { MemoryBeliefInputs } from "../types/memory"

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const BELIEF_SUPPORT_SATURATION = 3
export const BELIEF_NON_SESSION_CREDIT = 0.2
export const BELIEF_RESIDUAL_CAP = 1
export const BELIEF_RECENCY_TAU_DAYS = 30
export const BELIEF_RECENCY_FLOOR = 0.5
export const BELIEF_CAP = 0.95

/**
 * Evidence rows that still count. A row whose source was deleted or changed
 * (`validationState: "revoked"`) no longer witnesses anything.
 */
function isLiveEvidence(row: Pick<MemoryEvidence, "validationState">): boolean {
  return row.validationState !== "revoked"
}

/** Collapse a memory's evidence rows into the stored counters. */
export function computeBeliefInputs(
  evidence: readonly Pick<
    MemoryEvidence,
    "sessionId" | "sourceId" | "createdAt" | "validationState"
  >[]
): MemoryBeliefInputs {
  const live = evidence.filter(isLiveEvidence)
  const sessions = new Set<string>()
  let newest: number | undefined
  for (const row of live) {
    // Only a conversation is an independent witness. Evidence without a
    // session — a console edit, a restore, a manual capture, a file — still
    // counts, but as residual credit (0.2 each, capped at 1) rather than as a
    // witness: otherwise every edit a person makes would "corroborate" the
    // memory they are editing. Same split as ai-memory's session vs other
    // evidence kinds.
    if (row.sessionId) sessions.add(row.sessionId)
    if (newest === undefined || row.createdAt > newest) newest = row.createdAt
  }
  return {
    evidenceCount: live.length,
    distinctSessions: sessions.size,
    ...(newest !== undefined ? { newestEvidenceAt: newest } : {}),
  }
}

export function beliefStrength(
  inputs: MemoryBeliefInputs | undefined,
  options: { liveContradictions?: number; now?: number } = {}
): number | null {
  if (!inputs) return null
  const distinct = Math.max(0, inputs.distinctSessions)
  const residual = Math.max(0, inputs.evidenceCount - distinct)
  const breadth = distinct + Math.min(BELIEF_NON_SESSION_CREDIT * residual, BELIEF_RESIDUAL_CAP)
  if (breadth <= 0) return null
  const support = 1 - Math.exp(-breadth / BELIEF_SUPPORT_SATURATION)
  const now = options.now ?? Date.now()
  const recency =
    inputs.newestEvidenceAt === undefined
      ? 1
      : BELIEF_RECENCY_FLOOR +
        (1 - BELIEF_RECENCY_FLOOR) *
          Math.exp(
            -Math.max(0, now - inputs.newestEvidenceAt) / (BELIEF_RECENCY_TAU_DAYS * MS_PER_DAY)
          )
  const contradictions = 1 / (1 + Math.max(0, options.liveContradictions ?? 0))
  return Math.min(BELIEF_CAP, Math.max(0, support * recency * contradictions))
}
