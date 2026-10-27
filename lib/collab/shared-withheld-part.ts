/**
 * The placeholder a shared run publishes in place of a part it must not share
 * (ADR-0241).
 *
 * The shared-run projection (`shared-assistant-projection.ts`) checks every projected part with the PII gate. A part
 * that fails it is replaced by this one instead of failing the whole reply:
 * members see a labelled, inert "withheld" row where the content was, the rest
 * of the reply still publishes, and the owner's own transcript keeps the
 * original. It carries no content, only why it was withheld.
 */

export const SHARED_WITHHELD_PART_TYPE = "data-shared-withheld"

export type SharedWithheldReason = "pii"

export interface SharedWithheldPart {
  type: typeof SHARED_WITHHELD_PART_TYPE
  data: { reason: SharedWithheldReason }
}

export function sharedWithheldPart(reason: SharedWithheldReason): SharedWithheldPart {
  return { type: SHARED_WITHHELD_PART_TYPE, data: { reason } }
}

export function isSharedWithheldPart(part: unknown): part is SharedWithheldPart {
  if (!part || typeof part !== "object") return false
  const candidate = part as { type?: unknown; data?: { reason?: unknown } }
  return candidate.type === SHARED_WITHHELD_PART_TYPE && candidate.data?.reason === "pii"
}
