/**
 * PII redaction for `/goal` objectives — thin wrapper around
 * `lib/twin/ingest/redact.ts` so the cloud-bound objective text never
 * carries emails, phone numbers, bank cards, API keys, or other recognised
 * PII shapes.
 *
 * The map is encrypted with the same master key that protects twin
 * `redactionMapEnc` blobs (`lib/twin/ingest/redaction-key.ts`). That's
 * intentional: redaction is one cross-cutting concern, not two — sharing
 * the key means a user who wipes twin data also wipes goal-map decryption,
 * which is the correct semantic ("I want my privacy data gone").
 *
 * Returns an `EncryptedRedactionMap` envelope ("v: 1") JSON-serialized to
 * a string for direct storage in `chatGoals.redactionMapEnc`. Empty input
 * (no PII found) yields an empty string so callers don't have to special-
 * case the "nothing to encrypt" path.
 */

import { redactText, type RedactionRecord, unredactText } from "@/lib/twin/ingest/redact"
import { decryptRedactionMap, encryptRedactionMap } from "@/lib/twin/ingest/redaction-key"

export interface RedactObjectiveResult {
  /** The objective text with PII replaced by `<KIND_NNN>` placeholders. */
  safeObjective: string
  /** Encrypted JSON envelope; empty string when no PII was redacted. */
  redactionMapEnc: string
}

/**
 * Redact + encrypt the objective.
 *
 * @param raw                 The user's original objective string.
 * @param nameHints           Optional list of CJK / Latin names to hard-match
 *                            (e.g. drawn from the active character / session
 *                            metadata) so the heuristic name pass catches
 *                            them too.
 */
export async function redactObjective(
  raw: string,
  nameHints: Iterable<string> = []
): Promise<RedactObjectiveResult> {
  const { redacted, map } = redactText(raw, nameHints)
  const redactionMapEnc = await encryptRedactionMap(map)
  return { safeObjective: redacted, redactionMapEnc }
}

/**
 * Reverse `redactObjective` — used by the Activity tab when the user
 * clicks "show original" on a goal event payload. Returns the raw input
 * for empty envelopes (graceful no-op).
 */
export async function unredactObjective(
  safeObjective: string,
  redactionMapEnc: string
): Promise<string> {
  if (!redactionMapEnc) return safeObjective
  const map = await decryptRedactionMap(redactionMapEnc)
  return unredactText(safeObjective, map)
}

/**
 * Re-export the record type so consumers don't need to dip into the twin
 * subsystem directly when they only care about goal redaction.
 */
export type { RedactionRecord }
