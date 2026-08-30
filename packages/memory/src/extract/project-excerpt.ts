/**
 * The one definition of "the text project mining reasoned over".
 *
 * Mining hashes this into `MemoryEvidence.excerptHash`; the re-check sweep
 * recomputes it from the message as it stands today and compares. If the two
 * sides derived the excerpt differently — a different root list, a different
 * order of normalize-vs-redact — every claim would look revoked the moment it
 * was first checked, and the failure would look like evidence rot rather than a
 * hashing bug. One function, called by both, makes that class of drift
 * impossible rather than merely unlikely.
 *
 * Order matters and is fixed here: path normalization runs BEFORE redaction, so
 * the placeholders redaction emits are never re-parsed as path segments.
 *
 * Pure: no I/O. Roots and the redactor are supplied by the caller.
 */

import { redactText } from "@cognia/redact"
import { normalizeProjectPaths } from "./project-path-normalize"

export interface ProjectExcerptOptions {
  /** Absolute project roots; in-root paths become workspace-relative. */
  roots: readonly string[]
  /** Defaults to the shared redactor. Injectable for tests. */
  redact?: (text: string) => string
}

/**
 * The mining excerpt for one message, or `undefined` when the text still names
 * a person after normalization and must not be mined or re-checked at all.
 */
export function projectMiningExcerpt(
  text: string,
  options: ProjectExcerptOptions
): string | undefined {
  const normalized = normalizeProjectPaths(text, { roots: options.roots })
  if (!normalized.ok) return undefined
  const redact = options.redact ?? ((value: string) => redactText(value).redacted)
  return redact(normalized.text)
}
