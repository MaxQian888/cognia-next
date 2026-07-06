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
 *   • Bank cards    — 13–19 digits, contiguous OR single space/dash separated
 *                     (the human-written `4111 1111 1111 1111` form), Luhn-checked
 *   • Names         — only the names passed in `nameHints` (chat speakers, email
 *                     "From" headers). There is NO free-text name heuristic — a
 *                     name that isn't seeded as a hint is NOT redacted. PII
 *                     coverage is best-effort, not a proof-of-correctness.
 *   • IP addresses  — IPv4 (with private-range exclusions) + IPv6 (uncompressed
 *                     and `::`-compressed forms)
 *   • API keys      — `sk-…` / `ghp_…` / `gho_…` / `ghs_…` / `xox[abp]-…` /
 *                     `AKIA…` / OpenAI org keys + a high-entropy fallback for long
 *                     tokens preceded by an obvious key hint (`api_key`, `apikey`,
 *                     `secret`, `token`, `bearer`, `password`, the AWS secret-key
 *                     names, …). The hinted value stops at whitespace/quote so
 *                     dotted secrets (JWT-after-hint) are captured whole.
 *   • JWT           — three-segment `eyJ…`.`…`.`…` JSON Web Tokens
 *   • PEM keys      — `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----`
 *   • URL creds     — the password in `scheme://user:password@host`
 *   • Passport      — ICAO machine-readable + CN passport prefixes (E/G/EH/EJ)
 *   • Driver lic.   — CN driver-license card numbers (12 digits, hint-driven)
 *
 * The emitted placeholder format is `<KIND_NNN>` (e.g. `<EMAIL_001>`,
 * `<PHONE_002>`); the mapping is keyed by placeholder so we can run
 * deterministic replays during tests.
 */

/**
 * Canonical list of every placeholder kind this module can emit. `PiiKind`
 * derives from it, so adding a kind here automatically widens the type AND
 * every pattern built from this array — downstream placeholder scanners
 * (see `PII_PLACEHOLDER_SOURCE`) must derive from this instead of
 * hand-copying the alternation, which is how `unredact-draft.ts` drifted
 * out of sync (missing JWT / PEM_KEY) in the first place.
 */
export const PII_KINDS = [
  "EMAIL",
  "PHONE",
  "CN_ID",
  "BANK_CARD",
  "NAME",
  "IP_ADDR",
  "API_KEY",
  "JWT",
  "PEM_KEY",
  "PASSPORT",
  "DRIVER_LICENSE",
] as const

export type PiiKind = (typeof PII_KINDS)[number]

/**
 * Regex source matching one emitted placeholder, e.g. `<EMAIL_001>`.
 * Counters are padStart(3)-formatted but grow past three digits on
 * PII-heavy documents — hence `\d{3,}`. Consumers wrap it in
 * `new RegExp(PII_PLACEHOLDER_SOURCE, "g")` (or embed it) so every
 * scanner stays in lockstep with `PII_KINDS`.
 */
export const PII_PLACEHOLDER_SOURCE = `<(?:${PII_KINDS.join("|")})_\\d{3,}>`

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
// Bank cards: 13–19 digits, contiguous OR with a single space/dash between each
// digit (the human-written `4111 1111 1111 1111` / `4111-1111-1111-1111` form).
// The `\b…\b` anchors keep it from grabbing a slice of a longer digit run. The
// match still has to clear Luhn (on the separator-stripped digits) before it's
// treated as a card, so the looser shape doesn't inflate false positives.
const BANK_CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g
// JSON Web Tokens — header always starts `eyJ` (base64 of `{"`). Three
// dot-separated base64url segments.
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
// PEM private-key blocks (RSA/EC/OPENSSH/generic). Non-greedy body so two
// adjacent blocks don't merge into one match.
const PEM_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
// Credentials embedded in a URL: `scheme://user:password@host`. We redact the
// password (capture group 2); the scheme + user are kept so the URL still reads.
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi
// IPv4: four 0-255 octets. We exclude the obviously non-PII ranges
// (loopback 127.0.0.0/8, link-local 169.254.0.0/16, private 10.* + 192.168.*
// + 172.16-31.*) so example/log addresses don't trigger false positives.
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
// Uncompressed IPv6: 8 groups of 1-4 hex digits.
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g
// Compressed IPv6, restricted to the `≥2 leading groups :: …` form
// (e.g. `2001:db8::1`, `2001:db8::8a2e:370:7334`). Requiring two real hex
// groups before the `::` keeps this away from `namespace::member` in ingested
// code (`std::vector`, `Self::add`) — the bare `hex::hex` shape (`fe80::1`,
// `::1`) is structurally indistinguishable from such code, so we skip it; those
// forms are link-local / loopback anyway (non-PII), mirroring the private-IPv4
// exclusions above.
const IPV6_COMPRESSED_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,}:(?:[0-9a-fA-F]{1,4}:?)*[0-9a-fA-F]{1,4}\b/g
// Known API key prefixes — covers OpenAI, Anthropic, GitHub, Slack and a
// few others that ship recognisable prefixes.
const API_KEY_PREFIX_RE =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g
// High-entropy fallback: matches `<hint>\s*[:=]\s*"?<value>"?` where `<value>`
// is ≥20 non-whitespace, non-quote chars. The captured group `m[1]` is the
// secret. The value class is `[^\s"']` (not a base64 whitelist) so dotted /
// punctuation-bearing secrets — JWTs, AWS secret access keys, URL-safe tokens —
// are captured whole instead of being truncated at the first symbol. The hint
// list includes the underscore-joined AWS secret-key names, which `\bsecret\b`
// alone would miss (the `_` is a word char, so there's no boundary before
// `secret` in `aws_secret_access_key`).
const API_KEY_HINT_RE =
  /\b(?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret|secret[_-]?access[_-]?key|api[_-]?key|apikey|secret|token|bearer|password)\b\s*[:=]\s*["']?([^\s"']{20,})["']?/gi
// Passport: ICAO machine-readable (1 letter + 8 digits) and the CN-specific
// prefixes E/G/EH/EJ etc. Hint-driven (case-insensitive look-back).
const PASSPORT_RE = /\b(?:[A-Z]{1,2}\d{7,8}|[Ee]\d{8}|[Gg]\d{8}|[Ee][Hh]\d{7}|[Ee][Jj]\d{7})\b/g
// CN driver-license card numbers are 12 digits. We require a hint context
// to avoid swallowing every 12-digit string (timestamps, hashes, etc.).
// `\b` isn't useful around CJK glyphs (they're non-word chars under the
// default flavour), so we list the CJK hints without word boundaries.
const DRIVER_LICENSE_HINT_RE =
  /(?:\b(?:driver[_\s-]?license|driver[_\s-]?lic|dl[\s#]?|driving[\s_-]?license)\b|驾驶证|驾照)[^\d]{0,20}(\d{12})/gi

// Non-global clones of the detectors used by the no-leak gate. Derived from
// the canonical `/g` patterns above so the two never drift, but with the `g`
// flag stripped: `.test()` on these is stateless (no shared `lastIndex`).
function stateless(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace("g", ""))
}
const EMAIL_DETECT = stateless(EMAIL_RE)
const CN_ID_DETECT = stateless(CN_ID_RE)
const API_KEY_DETECT = stateless(API_KEY_PREFIX_RE)
const API_KEY_HINT_DETECT = stateless(API_KEY_HINT_RE)
const IPV6_DETECT = stateless(IPV6_RE)
const IPV6_COMPRESSED_DETECT = stateless(IPV6_COMPRESSED_RE)
const PASSPORT_DETECT = stateless(PASSPORT_RE)
const JWT_DETECT = stateless(JWT_RE)
const PEM_DETECT = stateless(PEM_BLOCK_RE)
const URL_CRED_DETECT = stateless(URL_CRED_RE)

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
    counters: Object.fromEntries(PII_KINDS.map((kind) => [kind, 0])) as Record<PiiKind, number>,
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

  // PEM blocks first: the base64 body would otherwise feed the card / key
  // passes a stream of false candidates. Redact the whole block as one token.
  let out = text.replace(PEM_BLOCK_RE, (m) => tokenize(state, "PEM_KEY", m))
  // URL-embedded credentials before EMAIL, so the `password@host` tail can't be
  // mistaken for an email address. Only the password (group 2) is redacted.
  out = out.replace(URL_CRED_RE, (full, prefix: string, password: string) =>
    full.replace(`:${password}@`, `:${tokenize(state, "API_KEY", password)}@`)
  )
  out = out.replace(EMAIL_RE, (m) => tokenize(state, "EMAIL", m))
  // API keys come *before* anything else digit-heavy so a key like
  // `sk-proj-abc...123` doesn't get half-eaten by the bank-card regex.
  out = out.replace(API_KEY_PREFIX_RE, (m) => tokenize(state, "API_KEY", m))
  // JWTs before the hinted-secret pass so a `token: eyJ…` is claimed as a JWT
  // (and the short placeholder no longer trips the ≥20-char hint matcher).
  out = out.replace(JWT_RE, (m) => tokenize(state, "JWT", m))
  out = out.replace(API_KEY_HINT_RE, (full, secret: string) =>
    full.replace(secret, tokenize(state, "API_KEY", secret))
  )
  out = out.replace(BANK_CARD_CANDIDATE_RE, (m) =>
    luhn(m.replace(/[ -]/g, "")) ? tokenize(state, "BANK_CARD", m) : m
  )
  out = out.replace(CN_ID_RE, (m) => tokenize(state, "CN_ID", m))
  // Passport before phone: phones don't have leading letters, but passport
  // numbers often share digit lengths. Run passport first to claim them.
  out = out.replace(PASSPORT_RE, (m) => tokenize(state, "PASSPORT", m))
  out = out.replace(DRIVER_LICENSE_HINT_RE, (full, dl: string) =>
    full.replace(dl, tokenize(state, "DRIVER_LICENSE", dl))
  )
  out = out.replace(PHONE_RE, (m) => {
    // Avoid double-tokenizing chunks that look like already-claimed placeholders.
    if (/^\s*<[A-Z_]+_\d{3,}>\s*$/.test(m)) return m
    return tokenize(state, "PHONE", m)
  })
  // IPv4 / IPv6 last so a bare 192.0.2.1 in a log line doesn't get mistaken
  // for a phone number first.
  out = out.replace(IPV4_RE, (m) => (isLikelyPublicIPv4(m) ? tokenize(state, "IP_ADDR", m) : m))
  out = out.replace(IPV6_RE, (m) => tokenize(state, "IP_ADDR", m))
  out = out.replace(IPV6_COMPRESSED_RE, (m) => {
    // Skip anything already swapped for a placeholder this pass.
    if (/^\s*<[A-Z_]+_\d{3,}>\s*$/.test(m)) return m
    return tokenize(state, "IP_ADDR", m)
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
// Derived from PII_KINDS so the scanner can never drift from the emitter.
// Safe to share across replace/matchAll: both reset/clone `lastIndex`.
const PLACEHOLDER_SCAN_RE = new RegExp(PII_PLACEHOLDER_SOURCE, "g")

export function unredactText(text: string, map: Record<string, RedactionRecord>): string {
  return text.replace(PLACEHOLDER_SCAN_RE, (placeholder) => {
    const record = map[placeholder]
    return record ? record.original : placeholder
  })
}

/** A char range in pre-redaction text space. Extra fields (page numbers,
 *  bounding boxes, …) pass through translation untouched via the generic. */
export interface RedactableOffsetEntry {
  charStart: number
  charEnd: number
}

/**
 * Translate char offsets from pre-redaction space into redacted space.
 *
 * Placeholders differ in length from the PII they replace, so offsets after
 * the first redaction are shifted (see the T1.1 regression in
 * `chunk-original-reconstruction.test.ts`). This walks the placeholders in
 * the redacted text in order, derives each one's exact (originalSpan,
 * redactedSpan) pair from the redaction map, and translates piecewise:
 *
 *   - offsets in identity segments shift by the accumulated delta;
 *   - offsets that fall INSIDE a redacted span have no exact twin and clamp
 *     to the placeholder's bounds;
 *   - everything clamps to `[0, redacted.length]`.
 *
 * Pure; used by the twin ingest job runner to move the PDF `pageMap` into
 * the same space as the chunker's `charStart`/`charEnd`.
 */
export function translateOffsetsThroughRedaction<T extends RedactableOffsetEntry>(
  entries: T[],
  redacted: string,
  map: Record<string, RedactionRecord>
): T[] {
  interface Span {
    origStart: number
    origEnd: number
    redStart: number
    redEnd: number
  }
  const spans: Span[] = []
  let redCursor = 0
  let origCursor = 0
  for (const match of redacted.matchAll(PLACEHOLDER_SCAN_RE)) {
    const record = map[match[0]]
    if (!record) continue // placeholder-shaped text that isn't ours
    const redStart = match.index
    const origStart = origCursor + (redStart - redCursor)
    spans.push({
      origStart,
      origEnd: origStart + record.original.length,
      redStart,
      redEnd: redStart + match[0].length,
    })
    origCursor = origStart + record.original.length
    redCursor = redStart + match[0].length
  }

  const translate = (offset: number): number => {
    let result = offset
    for (const span of spans) {
      if (offset < span.origStart) break
      if (offset < span.origEnd) {
        // Inside a redacted span — clamp into the placeholder.
        result = Math.min(span.redStart + (offset - span.origStart), span.redEnd)
        return Math.max(0, Math.min(result, redacted.length))
      }
      // Past this span — accumulate its delta.
      result = span.redEnd + (offset - span.origEnd)
    }
    return Math.max(0, Math.min(result, redacted.length))
  }

  return entries.map((entry) => ({
    ...entry,
    charStart: translate(entry.charStart),
    charEnd: translate(entry.charEnd),
  }))
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
  // Presence checks run on NON-global detector clones: `.test()` on a
  // non-global regex is stateless (no `lastIndex` to track or reset), so the
  // gate is idempotent and safe under concurrent / interleaved calls. The
  // IPv4 / bank-card passes need every match (to apply a predicate), so they
  // use `matchAll`, which clones the regex internally and never mutates the
  // shared global's `lastIndex`.
  if (EMAIL_DETECT.test(text)) return false
  if (CN_ID_DETECT.test(text)) return false
  if (API_KEY_DETECT.test(text)) return false
  if (API_KEY_HINT_DETECT.test(text)) return false
  if (JWT_DETECT.test(text)) return false
  if (PEM_DETECT.test(text)) return false
  if (URL_CRED_DETECT.test(text)) return false
  if (PASSPORT_DETECT.test(text)) return false
  if (IPV6_DETECT.test(text)) return false
  if (IPV6_COMPRESSED_DETECT.test(text)) return false
  // IPv4 — restrict to public addresses so log/example lines don't leak.
  for (const match of text.matchAll(IPV4_RE)) {
    if (isLikelyPublicIPv4(match[0])) return false
  }
  // Bank cards — Luhn-check the separator-stripped digits so the spaced /
  // dashed human form is caught, not just contiguous runs.
  for (const match of text.matchAll(BANK_CARD_CANDIDATE_RE)) {
    if (luhn(match[0].replace(/[ -]/g, ""))) return false
  }
  return true
}

/**
 * Deep variant of {@link hasNoLeakingPii}: recursively scans every string
 * leaf of a value so object- and array-shaped payloads can't smuggle PII
 * past the gate. Primitives other than strings are inherently safe; a value
 * that can't be traversed (cyclic / exotic) is treated as unsafe (returns
 * false) rather than silently allowed.
 *
 * Used by the shared-memory orchestrator's `publishEntry` so any value type
 * (not just strings) is vetted before persistence.
 */
export function hasNoLeakingPiiDeep(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return hasNoLeakingPii(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return true
  }
  if (value instanceof Date) return true
  if (Array.isArray(value)) {
    return value.every((item) => hasNoLeakingPiiDeep(item, seen))
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      if (!hasNoLeakingPiiDeep(k, seen) || !hasNoLeakingPiiDeep(v, seen)) return false
    }
    return true
  }
  if (value instanceof Set) {
    for (const item of value) {
      if (!hasNoLeakingPiiDeep(item, seen)) return false
    }
    return true
  }
  if (typeof value === "object") {
    if (seen.has(value)) return false // cycle → treat as unsafe
    seen.add(value)
    return Object.values(value as Record<string, unknown>).every((v) =>
      hasNoLeakingPiiDeep(v, seen)
    )
  }
  // Functions, symbols, and other exotic types: stringify-and-scan fallback.
  try {
    return hasNoLeakingPii(String(value))
  } catch {
    return false
  }
}
