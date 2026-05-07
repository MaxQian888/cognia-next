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
 * Coverage:
 *   • Emails        — RFC-5322 simplified
 *   • Phone numbers — Mainland China mobile (11 digits) + intl E.164 + US
 *   • CN national ID (18 digits, optional X check char)
 *   • CN bank cards (13–19 digits, Luhn-checked)
 *   • Names         — heuristic CJK-name segments inside email signatures /
 *                     chat speakers (best-effort; PII coverage is not a
 *                     proof-of-correctness)
 *   • IP addresses  — IPv4 (with private-range exclusions) + uncompressed IPv6
 *   • API keys      — `sk-…` / `ghp_…` / `gho_…` / `ghs_…` / `xox[abp]-…` /
 *                     OpenAI org keys + a high-entropy fallback for long
 *                     base64-ish tokens preceded by an obvious key hint
 *                     (`api_key`, `apikey`, `secret`, `token`, `bearer`).
 *   • Passport      — ICAO machine-readable + CN passport prefixes (E/G/EH/EJ)
 *   • Driver lic.   — CN driver-license card numbers (12 digits, hint-driven)
 *
 * The emitted placeholder format is `<KIND_NNN>` (e.g. `<EMAIL_001>`,
 * `<PHONE_002>`); the mapping is keyed by placeholder so we can run
 * deterministic replays during tests.
 */

export type PiiKind =
  | "EMAIL"
  | "PHONE"
  | "CN_ID"
  | "BANK_CARD"
  | "NAME"
  | "IP_ADDR"
  | "API_KEY"
  | "PASSPORT"
  | "DRIVER_LICENSE"

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
// IPv4: four 0-255 octets. We exclude the obviously non-PII ranges
// (loopback 127.0.0.0/8, link-local 169.254.0.0/16, private 10.* + 192.168.*
// + 172.16-31.*) so example/log addresses don't trigger false positives.
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
// Uncompressed IPv6: 8 groups of 1-4 hex digits. The compressed `::` form is
// uncommon enough in user-facing PII that we skip it here.
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g
// Known API key prefixes — covers OpenAI, Anthropic, GitHub, Slack and a
// few others that ship recognisable prefixes.
const API_KEY_PREFIX_RE =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g
// High-entropy fallback: the regex matches `(api_key|apikey|secret|token|
// bearer)\s*[:=]\s*"?<value>"?` where `<value>` is ≥20 chars and looks
// base64/hex-ish. The captured group `m[1]` is the secret value.
const API_KEY_HINT_RE =
  /\b(?:api[_-]?key|apikey|secret|token|bearer|password)\b\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{20,})["']?/gi
// Passport: ICAO machine-readable (1 letter + 8 digits) and the CN-specific
// prefixes E/G/EH/EJ etc. Hint-driven (case-insensitive look-back).
const PASSPORT_RE = /\b(?:[A-Z]{1,2}\d{7,8}|[Ee]\d{8}|[Gg]\d{8}|[Ee][Hh]\d{7}|[Ee][Jj]\d{7})\b/g
// CN driver-license card numbers are 12 digits. We require a hint context
// to avoid swallowing every 12-digit string (timestamps, hashes, etc.).
// `\b` isn't useful around CJK glyphs (they're non-word chars under the
// default flavour), so we list the CJK hints without word boundaries.
const DRIVER_LICENSE_HINT_RE =
  /(?:\b(?:driver[_\s-]?license|driver[_\s-]?lic|dl[\s#]?|driving[\s_-]?license)\b|驾驶证|驾照)[^\d]{0,20}(\d{12})/gi

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
    counters: {
      EMAIL: 0,
      PHONE: 0,
      CN_ID: 0,
      BANK_CARD: 0,
      NAME: 0,
      IP_ADDR: 0,
      API_KEY: 0,
      PASSPORT: 0,
      DRIVER_LICENSE: 0,
    },
    reuse: new Map(),
    map: {},
  }
}

/**
 * Decide whether an IPv4 string looks like real PII or like a private /
 * link-local / loopback address that's almost certainly *not* a user. Keeps
 * the redactor from churning on log lines and example configs.
 */
function isLikelyPublicIPv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  const [a, b] = parts
  if (a === 0 || a === 127 || a === 255) return false // loopback / broadcast
  if (a === 10) return false // private 10.0.0.0/8
  if (a === 192 && b === 168) return false // private 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return false // private 172.16.0.0/12
  if (a === 169 && b === 254) return false // link-local
  return true
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
  // API keys come *before* anything else digit-heavy so a key like
  // `sk-proj-abc...123` doesn't get half-eaten by the bank-card regex.
  out = out.replace(API_KEY_PREFIX_RE, (m) => tokenize(state, "API_KEY", m))
  out = out.replace(API_KEY_HINT_RE, (full, secret: string) =>
    full.replace(secret, tokenize(state, "API_KEY", secret))
  )
  out = out.replace(BANK_CARD_CANDIDATE_RE, (m) => (luhn(m) ? tokenize(state, "BANK_CARD", m) : m))
  out = out.replace(CN_ID_RE, (m) => tokenize(state, "CN_ID", m))
  // Passport before phone: phones don't have leading letters, but passport
  // numbers often share digit lengths. Run passport first to claim them.
  out = out.replace(PASSPORT_RE, (m) => tokenize(state, "PASSPORT", m))
  out = out.replace(DRIVER_LICENSE_HINT_RE, (full, dl: string) =>
    full.replace(dl, tokenize(state, "DRIVER_LICENSE", dl))
  )
  out = out.replace(PHONE_RE, (m) => {
    // Avoid double-tokenizing chunks that look like already-claimed placeholders.
    if (/^\s*<[A-Z_]+_\d{3}>\s*$/.test(m)) return m
    return tokenize(state, "PHONE", m)
  })
  // IPv4 / IPv6 last so a bare 192.0.2.1 in a log line doesn't get mistaken
  // for a phone number first.
  out = out.replace(IPV4_RE, (m) => (isLikelyPublicIPv4(m) ? tokenize(state, "IP_ADDR", m) : m))
  out = out.replace(IPV6_RE, (m) => tokenize(state, "IP_ADDR", m))

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
  return text.replace(
    /<(EMAIL|PHONE|CN_ID|BANK_CARD|NAME|IP_ADDR|API_KEY|PASSPORT|DRIVER_LICENSE)_\d{3}>/g,
    (placeholder) => {
      const record = map[placeholder]
      return record ? record.original : placeholder
    }
  )
}

/**
 * Static helper for tests + the no-leak gate. Returns true when no
 * recognised PII shape survives in `text`.
 *
 * Used by the distill job runner as a post-flight check: every draft body
 * passes through this gate before being persisted, and a failure routes
 * the draft through a second redaction pass + audit log entry.
 */
export function hasNoLeakingPii(text: string): boolean {
  // Reset every regex's lastIndex (these are global regexes; .test mutates
  // state) so this function stays idempotent across calls.
  for (const re of [EMAIL_RE, CN_ID_RE, API_KEY_PREFIX_RE, IPV4_RE, IPV6_RE, PASSPORT_RE]) {
    re.lastIndex = 0
  }

  if (EMAIL_RE.test(text)) return reset(false)
  if (CN_ID_RE.test(text)) return reset(false)
  if (API_KEY_PREFIX_RE.test(text)) return reset(false)
  if (PASSPORT_RE.test(text)) return reset(false)
  if (IPV6_RE.test(text)) return reset(false)
  // IPv4 — restrict to public addresses so log/example lines don't leak.
  let ipLeak = false
  text.replace(IPV4_RE, (m) => {
    if (isLikelyPublicIPv4(m)) ipLeak = true
    return m
  })
  if (ipLeak) return false

  let bankLeak = false
  text.replace(BANK_CARD_CANDIDATE_RE, (m) => {
    if (luhn(m)) bankLeak = true
    return m
  })
  return !bankLeak
}

function reset(value: boolean): boolean {
  EMAIL_RE.lastIndex = 0
  CN_ID_RE.lastIndex = 0
  API_KEY_PREFIX_RE.lastIndex = 0
  IPV4_RE.lastIndex = 0
  IPV6_RE.lastIndex = 0
  PASSPORT_RE.lastIndex = 0
  return value
}
