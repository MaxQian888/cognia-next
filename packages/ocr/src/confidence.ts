/**
 * Confidence-driven escalation (ADR-0024 Phase 2 / 2c).
 *
 * When a result's mean block confidence is low, re-OCR the whole document with
 * a stronger provider and keep the escalated output. Document-level (not
 * per-region) by design — it's the lightweight, deterministic version the
 * research recommends, and it sidesteps the cross-provider confidence
 * calibration trap by *keeping the escalated result* rather than comparing raw
 * scores between engines.
 *
 * Pure + DI: `maybeEscalateResult` takes an injected `reextract` so it's
 * testable without a real provider, and `extract()` wires the real re-run.
 */

import type { OcrDocument, OcrResult, UserOcrSettings } from "./types"

/** Mean confidence across every block that reported one. Null when none did. */
export function documentConfidence(doc: OcrDocument | undefined): number | null {
  if (!doc) return null
  const values: number[] = []
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (typeof block.confidence === "number") values.push(block.confidence)
    }
  }
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

export interface EscalationDecision {
  escalate: boolean
  toProviderId?: string
}

type EscalationSettings = Pick<
  UserOcrSettings,
  | "confidenceEscalation"
  | "confidenceThreshold"
  | "escalationProviderId"
  | "cloudFallbackProviderId"
>

/**
 * Decide whether to escalate. No escalation when: mode is off, no distinct
 * target provider, or there's no confidence signal (don't waste a call when we
 * can't tell), or confidence already meets the threshold.
 */
export function decideEscalation(opts: {
  settings: EscalationSettings
  primaryProviderId: string
  confidence: number | null
}): EscalationDecision {
  if (opts.settings.confidenceEscalation !== "escalate") return { escalate: false }
  const target = opts.settings.escalationProviderId ?? opts.settings.cloudFallbackProviderId ?? null
  if (!target || target === opts.primaryProviderId) return { escalate: false }
  if (opts.confidence === null) return { escalate: false }
  const threshold = opts.settings.confidenceThreshold ?? 0.6
  if (opts.confidence >= threshold) return { escalate: false }
  return { escalate: true, toProviderId: target }
}

/**
 * Apply escalation to a primary result. `reextract` re-runs OCR with the given
 * provider id; on failure the primary result is kept (best-effort).
 */
export async function maybeEscalateResult(opts: {
  result: OcrResult
  settings: EscalationSettings
  reextract: (providerId: string) => Promise<OcrResult>
}): Promise<OcrResult> {
  const confidence = documentConfidence(opts.result.document)
  const decision = decideEscalation({
    settings: opts.settings,
    primaryProviderId: opts.result.providerId,
    confidence,
  })
  if (!decision.escalate || !decision.toProviderId) return opts.result
  try {
    return await opts.reextract(decision.toProviderId)
  } catch {
    return opts.result
  }
}
