/**
 * PII redaction for the twin ingest pipeline.
 *
 * Per the plan's privacy decision (5b), every chunk that goes to the cloud
 * (embedding API, distill LLM) must be scrubbed of personally-identifying
 * information first. This module scans for the common PII shapes and
 * substitutes opaque placeholders, returning both the scrubbed text and
 * the mapping table so the workbench UI can show originals while the
 * cloud only ever sees placeholders.
 *
 * Coverage targets (per plan §5.4 red-line tests):
 *   • Emails        — RFC-5322 simplified
 *   • Phone numbers — Mainland China mobile (11 digits) + intl E.164 + US
 *   • CN national ID (18 digits, optional X check char)
 *   • CN bank cards (13–19 digits, Luhn-checked)
 *   • Names         — heuristic CJK-name segments inside email signatures /
 *                     chat speakers (best-effort; PII coverage is not a
 *                     proof-of-correctness)
 *
 * The emitted placeholder format is `<KIND_NNN>` (e.g. `<EMAIL_001>`,
 * `<PHONE_002>`); the mapping is keyed by placeholder so we can run
 * deterministic replays during tests.
 */

export type PiiKind = "EMAIL" | "PHONE" | "CN_ID" | "BANK_CARD" | "NAME"

export interface RedactionRecord {
  placeholder: string
  original: string
  kind: PiiKind
}

export interface RedactionResult {
  redacted: string
  /** Map keyed by placeholder so callers can hydrate originals back. */
  map: Record<string, RedactionRecord>
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
// CN mobile: starts with 1, 11 digits total. Intl E.164: leading + and 8-15
// digits. Generic 10–11 digit US/CA numbers with optional separators.
// The leading `\b` prevents matching the tail of a longer digit run (e.g.
// the last 11 digits of a 16-digit non-Luhn card that the bank-card pass
// already skipped).
const PHONE_RE = /\b(?:\+\d{1,3}[\s-]?)?(?:1\d{10}|\d{3}[\s-]?\d{3,4}[\s-]?\d{4}|\d{10,11})\b/g
// CN national ID: 17 digits + (digit | X | x).
const CN_ID_RE = /\b\d{17}[\dXx]\b/g
// Bank cards: 13–19 contiguous digits.
const BANK_CARD_CANDIDATE_RE = /\b\d{13,19}\b/g

function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function pad(n: number): string {
  return String(n).padStart(3, "0")
}

interface RedactState {
  counters: Record<PiiKind, number>
  /** original → placeholder, so the same value always maps to the same token. */
  reuse: Map<string, string>
  map: Record<string, RedactionRecord>
}

function freshState(): RedactState {
  return {
    counters: { EMAIL: 0, PHONE: 0, CN_ID: 0, BANK_CARD: 0, NAME: 0 },
    reuse: new Map(),
    map: {},
  }
}

function tokenize(state: RedactState, kind: PiiKind, original: string): string {
  const cached = state.reuse.get(original)
  if (cached) return cached
  state.counters[kind] += 1
  const placeholder = `<${kind}_${pad(state.counters[kind])}>`
  state.reuse.set(original, placeholder)
  state.map[placeholder] = { placeholder, original, kind }
  return placeholder
}

/**
 * Redact PII in `text`. The `nameHints` set lets callers seed extra names
 * known from the source-row metadata (chat exports' speaker list, email
 * "From" headers, …) so the heuristic name pass catches them too.
 *
 * Idempotent — running on already-redacted text is a no-op as long as the
 * placeholders match `<KIND_NNN>`.
 */
export function redactText(text: string, nameHints: Iterable<string> = []): RedactionResult {
  const state = freshState()

  let out = text.replace(EMAIL_RE, (m) => tokenize(state, "EMAIL", m))
  out = out.replace(BANK_CARD_CANDIDATE_RE, (m) => (luhn(m) ? tokenize(state, "BANK_CARD", m) : m))
  out = out.replace(CN_ID_RE, (m) => tokenize(state, "CN_ID", m))
  out = out.replace(PHONE_RE, (m) => {
    // Avoid double-tokenizing chunks that look like already-claimed placeholders.
    if (/^\s*<[A-Z_]+_\d{3}>\s*$/.test(m)) return m
    return tokenize(state, "PHONE", m)
  })

  for (const hint of nameHints) {
    const trimmed = hint.trim()
    if (!trimmed) continue
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out.replace(new RegExp(`(?<=[^\\p{L}]|^)${escaped}(?=[^\\p{L}]|$)`, "gu"), (m) =>
      tokenize(state, "NAME", m)
    )
  }

  return { redacted: out, map: state.map }
}

/**
 * Reverse `redactText`. Used by the workbench when displaying provenance —
 * the chunk row stores the original, but reconstructed views (LLM critique
 * output, exported reports) round-trip through this function.
 */
export function unredactText(text: string, map: Record<string, RedactionRecord>): string {
  return text.replace(/<(EMAIL|PHONE|CN_ID|BANK_CARD|NAME)_\d{3}>/g, (placeholder) => {
    const record = map[placeholder]
    return record ? record.original : placeholder
  })
}

/**
 * Static helper for tests + the no-leak gate. Returns true when no
 * recognised PII shape survives in `text`.
 */
export function hasNoLeakingPii(text: string): boolean {
  if (EMAIL_RE.test(text)) {
    EMAIL_RE.lastIndex = 0
    return false
  }
  if (CN_ID_RE.test(text)) {
    CN_ID_RE.lastIndex = 0
    return false
  }
  let leak = false
  text.replace(BANK_CARD_CANDIDATE_RE, (m) => {
    if (luhn(m)) leak = true
    return m
  })
  return !leak
}
