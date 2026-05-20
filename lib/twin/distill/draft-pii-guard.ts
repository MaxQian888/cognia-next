/**
 * Edit-time PII red-line check for distilled drafts.
 *
 * The synthesizer redacts everything it touches at distill time and the
 * `unredact-draft` flow makes a second pass; but when a reviewer edits a
 * draft in the workbench (M5 DraftEditorDialog), they could paste a raw
 * email / phone / API key directly into the textarea. This module runs
 * `hasNoLeakingPii` over every string field of the payload before the
 * row is committed back to Dexie, and throws a structured error the UI
 * can display.
 *
 * Placeholder tokens (`<EMAIL_001>`, `<PHONE_002>`, etc.) are not real
 * PII — the redaction map sits encrypted on `twinSources.redactionMapEnc`
 * and the guard skips fields whose only "leak" is a placeholder.
 */

import type { TwinDraftPayload } from "@/types/twin"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"

/**
 * Fields whose contents are scanned. We intentionally limit the surface
 * to user-facing prose — internal ids / kind discriminators are exempt
 * because the schema controls their shape.
 */
const SCANNED_FIELDS = ["name", "description", "systemPrompt", "content", "voiceSummary"] as const

export interface DraftPiiViolation {
  /** Which payload field tripped the check. */
  field: (typeof SCANNED_FIELDS)[number]
  /** Short message shown to the reviewer (single sentence). */
  message: string
}

export class DraftPiiError extends Error {
  readonly violations: DraftPiiViolation[]
  constructor(violations: DraftPiiViolation[]) {
    super(
      violations.length === 1
        ? `Draft body contains PII: ${violations[0].field}`
        : `Draft body contains PII in ${violations.length} fields`
    )
    this.name = "DraftPiiError"
    this.violations = violations
  }
}

/**
 * Throws `DraftPiiError` if any scanned string field in the payload
 * carries content that the PII redactor would mark as a leak. Returns
 * silently on a clean payload.
 */
export function assertDraftBodyClean(payload: TwinDraftPayload): void {
  const data = payload.data as Record<string, unknown>
  const violations: DraftPiiViolation[] = []
  for (const field of SCANNED_FIELDS) {
    const value = data[field]
    if (typeof value !== "string" || value.length === 0) continue
    if (hasNoLeakingPii(value)) continue
    violations.push({
      field,
      message: `${field} appears to contain unredacted personal information.`,
    })
  }
  if (violations.length > 0) {
    throw new DraftPiiError(violations)
  }
}

/**
 * Generic variant for non-draft payloads (Persona browser edits, manual
 * entity / playbook / style sample additions). Scans every string field
 * supplied; throws `DraftPiiError` whose `violations[].field` reuses the
 * caller-supplied keys so the UI surface can localize them.
 *
 * Re-uses the same `hasNoLeakingPii` gate as `assertDraftBodyClean` so
 * the persona-edit red-line behaves identically to the draft-edit one
 * (single source of truth for what counts as PII).
 */
export function assertFieldsClean(fields: Record<string, string | undefined | null>): void {
  const violations: DraftPiiViolation[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) continue
    if (hasNoLeakingPii(value)) continue
    violations.push({
      // `field` is typed as the draft SCANNED_FIELDS tuple for back-compat;
      // the assertion is safe at runtime — UIs read .field as a free string.
      field: key as DraftPiiViolation["field"],
      message: `${key} appears to contain unredacted personal information.`,
    })
  }
  if (violations.length > 0) {
    throw new DraftPiiError(violations)
  }
}

export const __TESTING__ = { SCANNED_FIELDS }
