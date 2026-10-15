/**
 * The PII gate for diff text an automatic reviewer sends to a model
 * (ADR-0227 §3; the cross-cutting rule in CLAUDE.md).
 *
 * Redact-and-send, as the Source Control panel's AI review does, but with the
 * two steps that make it a gate rather than a hint:
 *
 * - redaction runs on the NORMALIZED text (`normalizeForRedaction`), because
 *   `hasNoLeakingPii` also scans a normalized view: a secret split by an
 *   escape or control character is detected there and would survive a
 *   redaction of the raw text;
 * - the redacted text is checked again, and anything still leaking is
 *   withheld instead of sent.
 *
 * Unattended review passes over agent-written content call this per file, so
 * one stubborn file is withheld without silencing the rest.
 */

import { hasNoLeakingPii, normalizeForRedaction, redactText } from "@cognia/redact"

export type GatedText = { ok: true; text: string; redacted: boolean } | { ok: false }

export function gateTextForModel(text: string): GatedText {
  if (hasNoLeakingPii(text)) return { ok: true, text, redacted: false }
  const redacted = redactText(normalizeForRedaction(text)).redacted
  return hasNoLeakingPii(redacted) ? { ok: true, text: redacted, redacted: true } : { ok: false }
}
