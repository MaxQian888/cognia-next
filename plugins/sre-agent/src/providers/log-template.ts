/**
 * Log-template extraction — the "distributed log analysis" half of the panel.
 *
 * Grouping raw lines by a masked template is what makes a 14k-line window
 * readable: "provider.timeout provider=<*> attempt=<*>" collapses 184 lines
 * into one row whose count and delta are the actual signal. Kept in its own
 * module (rather than inside the fixture provider) because a remote provider
 * that cannot push the aggregation down has to mask lines exactly the same way,
 * or the two backends would disagree about what "the same template" is.
 *
 * Deliberately not Drain: Drain's parse tree earns its keep on unstructured
 * text at scale, and three quarters of what this plugin reads is already
 * structured JSON where the key set IS the template. Text lines get the mask
 * pass below, which is the same normalisation Drain applies before its tree.
 */

import type { SreLogEvidence } from "../evidence"

export const TEMPLATE_MASK = "<*>"

/**
 * Keys folded into the template's prefix instead of its body, so two records of
 * the same event do not split into separate templates over their timestamp.
 */
const PREFIX_KEYS = new Set(["ts", "service", "event", "level"])

/** A token made only of digits and their separators carries no shape at all. */
const PURE_NUMERIC_TOKEN = /^[\d.:\-/]+$/
const DIGIT_RUN = /\d+/g
/** `<*>.<*>%` reads worse than `<*>%` and groups identically. */
const ADJACENT_MASKS = /(?:<\*>[.:\-/])+<\*>/g

/** Mask one whitespace-delimited token of an unstructured line. */
export function maskToken(token: string): string {
  if (token.length === 0) return token
  if (PURE_NUMERIC_TOKEN.test(token) && /\d/.test(token)) return TEMPLATE_MASK
  if (!/\d/.test(token)) return token
  return token.replace(DIGIT_RUN, TEMPLATE_MASK).replace(ADJACENT_MASKS, TEMPLATE_MASK)
}

/** Mask an unstructured log line into its template. */
export function maskText(text: string): string {
  return text.trim().split(/\s+/).map(maskToken).join(" ")
}

/**
 * The template for one record.
 *
 * JSON records template on their key SET, values masked — that is what makes
 * `provider.timeout provider=<*>` and `provider.timeout provider=<*> attempt=<*>`
 * two different templates, which is correct: a retry-carrying timeout and a
 * first-attempt timeout are different events even though the event name matches.
 */
export function logTemplate(evidence: SreLogEvidence): string {
  const raw = evidence.raw
  if (evidence.sourceKind === "json" && raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    const head = [evidence.service, evidence.eventName].filter(Boolean).join(" ")
    const body = Object.keys(record)
      .filter((key) => !PREFIX_KEYS.has(key))
      .sort()
      .map((key) => `${key}=${TEMPLATE_MASK}`)
      .join(" ")
    return body ? `${head} ${body}` : head
  }
  return maskText(typeof raw === "string" ? raw : JSON.stringify(raw))
}

/**
 * Stable id for a template.
 *
 * djb2 over the template text, base36. Not a cryptographic hash and not meant
 * to be one — it is a React key and a selection key that has to survive a
 * re-query, and both callers compare ids they computed from the same string.
 */
export function templateId(template: string): string {
  let hash = 5381
  for (let index = 0; index < template.length; index += 1) {
    hash = ((hash << 5) + hash + template.charCodeAt(index)) | 0
  }
  return `tpl_${(hash >>> 0).toString(36)}`
}
