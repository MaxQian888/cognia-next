/**
 * Content-derived dedup key for inbound submissions (ADR-0008 Phases 4–6).
 *
 * Three independent producers feed the review queue — MCP write tools, the IDE
 * log scanners, and the scheduler crawler — and all three re-read their sources
 * on purpose. A crawler revisits a page on its next tick; a scanner replays a
 * log file it already consumed after a rotation; an agent submits the same
 * lesson from two sessions. Without a dedup key the operator's queue fills with
 * the same item over and over, and the queue cap silently evicts genuinely new
 * drafts to make room for duplicates.
 *
 * ## What "the same content" means here
 *
 * Canonicalization is deliberately aggressive, because the near-duplicates this
 * has to catch differ only in noise: a re-crawled page whose whitespace shifted,
 * a log line re-emitted with different capitalization. So the key is computed
 * over kind + title + body with case folded, all whitespace runs collapsed, and
 * the untrusted envelope stripped — the envelope is added by the pipeline, not
 * by the submitter, so leaving it in would just be a constant.
 *
 * It is NOT a security primitive and not a similarity measure: two genuinely
 * different lessons that happen to share a title are distinct here, and a
 * paraphrase of the same lesson is not caught. Distinguishing those is the
 * operator's job at review time.
 */

import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/external-bridge/untrusted"
import type { InboundDraftKind } from "@/lib/db/inbound-drafts"

/**
 * Strip the `<untrusted_content>` fences if present.
 *
 * Callers hand this function either raw submissions or already-wrapped bodies
 * depending on where in the pipeline they sit, and the same content must hash
 * identically either way.
 */
export function stripUntrustedEnvelope(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith(UNTRUSTED_OPEN) || !trimmed.endsWith(UNTRUSTED_CLOSE)) {
    return text
  }
  return trimmed.slice(UNTRUSTED_OPEN.length, trimmed.length - UNTRUSTED_CLOSE.length)
}

/**
 * Reduce text to its comparison form: envelope stripped, case folded, every
 * whitespace run collapsed to a single space, ends trimmed.
 */
export function canonicalizeText(text: string): string {
  return stripUntrustedEnvelope(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * SHA-256 over `kind`, canonicalized title, and canonicalized body.
 *
 * The NUL-free ` ` field separator is a literal control character built at
 * runtime rather than typed inline, so a title ending in the separator cannot
 * be crafted to collide with a body starting with it.
 */
export async function computeCanonicalHash(input: {
  kind: InboundDraftKind
  title: string
  body: string
}): Promise<string> {
  const separator = String.fromCharCode(0)
  const payload = [input.kind, canonicalizeText(input.title), canonicalizeText(input.body)].join(
    separator
  )

  const bytes = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
