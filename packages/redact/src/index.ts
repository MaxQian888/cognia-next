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
 *   • US SSN       — dashed 9-digit form, excluding unassigned area/group/serial ranges
 *   • Bank cards    — 13–19 digits, contiguous OR single space/dash separated
 *                     (the human-written `4111 1111 1111 1111` form), Luhn-checked
 *   • Names         — only the names passed in `nameHints` (chat speakers, email
 *                     "From" headers). There is NO free-text name heuristic — a
 *                     name that isn't seeded as a hint is NOT redacted. PII
 *                     coverage is best-effort, not a proof-of-correctness.
 *   • IP addresses  — IPv4 (with private-range exclusions) + IPv6 (uncompressed
 *                     and `::`-compressed forms)
 *   • API keys      — `sk-…` / Stripe `sk_live_…` `rk_live_…` (+ `_test_`) /
 *                     GitHub `gh[pousr]_…` `github_pat_…` / Slack `xox[abprs]-…`
 *                     `xapp-…` / Google `AIza…` + OAuth refresh `1//…` / AWS
 *                     `AKIA…` `ASIA…` / Meta `EAA…` / Telegram bot `123456:AA…`
 *                     + a high-entropy fallback for long tokens preceded by an
 *                     obvious key hint (`api_key`, `apikey`, `secret`, `token`,
 *                     `bearer`, `password`, the AWS secret-key names, …). The
 *                     hinted value stops at whitespace/quote so dotted secrets
 *                     (JWT-after-hint) are captured whole.
 *   • Bearer tokens — `Bearer <token>` (whitespace form, case-insensitive,
 *                     ≥16 chars, token must carry a digit or inner capital so
 *                     prose like "bearer authentication" is left alone)
 *   • Env secrets   — `NAME_KEY=…` / `NAME_TOKEN=…` / `_SECRET` / `_PASSWORD` /
 *                     `_CREDENTIAL(S)` / `_PRIVATE_KEY` assignments and the
 *                     well-known provider names (`ANTHROPIC_API_KEY`, `HF_TOKEN`,
 *                     `AWS_ACCESS_KEY_ID`, …). Only the value (≥8 chars) is
 *                     redacted, the name stays so the text still reads;
 *                     references (`$VAR`, `process.env.X`) are left alone.
 *   • Cred. paths   — `~/.ssh/…`, `.aws`, `.kube`, `.config/gcloud`, `.gnupg`:
 *                     the path from the credential directory onward. Redacted
 *                     by `redactText` but NOT a `hasNoLeakingPii` failure (like
 *                     PHONE / NAME): naming a path leaks no secret, and failing
 *                     the gate on it would block ordinary "how do I set up
 *                     ~/.ssh/config" prompts.
 *   • JWT           — three-segment `eyJ…`.`…`.`…` JSON Web Tokens
 *   • PEM keys      — `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----`
 *   • URL creds     — the password in `scheme://user:password@host`
 *   • Passport      — ICAO machine-readable + CN passport prefixes (E/G/EH/EJ)
 *   • Driver lic.   — CN driver-license card numbers (12 digits, hint-driven)
 *
 * Terminal escapes (ANSI CSI / OSC), C0/C1 controls and bidi overrides are
 * NOT stripped by `redactText`: its contract is "text unchanged except PII"
 * (`unredactText` round-trips it and `translateOffsetsThroughRedaction`
 * relies on it). They are handled by the separate, exported
 * {@link normalizeForRedaction} pre-normalization step, and `hasNoLeakingPii`
 * scans the normalized view too, so a secret split by an escape sequence or
 * visually reordered by a bidi override cannot slip past the gate.
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
  "SSN",
  "BANK_CARD",
  "NAME",
  "IP_ADDR",
  "API_KEY",
  "JWT",
  "PEM_KEY",
  "PASSPORT",
  "DRIVER_LICENSE",
  "CREDENTIAL_PATH",
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
// US Social Security number in its unambiguous dashed form. Bare 9-digit
// strings are intentionally excluded to avoid treating timestamps and ids as
// SSNs. Area 000/666/900-999, group 00, and serial 0000 are unassigned.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g
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
// Known API key prefixes — covers OpenAI, Anthropic, Stripe, GitHub, Slack,
// Google, AWS, Meta, Telegram and a few others that ship recognisable
// prefixes. Shapes ported from ai-memory's sanitizer, tightened where the
// upstream class would eat ordinary code:
//   • Stripe `(?:sk|rk)_(?:live|test)_` takes an alphanumeric body only (real
//     keys have no `_`), so `sk_live_connection_pool` is not a key.
//   • Google OAuth refresh tokens `1//…` refuse a preceding `.` `:` `/` so a
//     URL like `http://10.0.0.1//long_path_segment` is not a token.
//   • Telegram bot tokens `<bot id>:<35-char secret>`; the fixed secret length
//     keeps `12:34` times and `ts:<sha1>` pairs out.
const API_KEY_PREFIX_RE =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?<![.:/])1\/\/[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|EAA[A-Za-z0-9]{20,}|\d{6,10}:(?:AA[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{34,35}))\b/g
// `Bearer <token>` with whitespace (the HTTP `Authorization` header form).
// `m[1]` is the token. `isTokenLike` then drops prose ("bearer
// authentication") — see there. The colon/equals form (`bearer: …`) stays with
// the hinted-secret pass below.
const BEARER_RE = /\bbearer\s+([A-Za-z0-9._~+/=-]{16,})/gi
// Env-style secret assignments: `<NAME>"?\s*[=:]\s*["']?<value>`. Group 1 is
// the variable name, kept so the text stays readable; group 2 is the value,
// the only part redacted. Case-sensitive on purpose: the upper-case env
// convention is what separates `OPENAI_API_KEY=…` from code such as
// `cache_key = build_key(…)`. The explicit provider names are listed even
// where the generic suffix rule already covers them, and they add the
// `AWS_ACCESS_KEY_ID` family, whose `_ID` suffix the generic rule misses.
// `isRedactableEnvValue` applies the ≥8-char floor (so `FOO_KEY=1` config is
// left alone), skips placeholders and variable references.
const ENV_SECRET_RE =
  /\b((?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|VOYAGE_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|HUGGINGFACE_TOKEN|AWS_(?:SECRET_)?ACCESS_KEY[A-Z_]*|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY|OLLAMA_API_KEY)|[A-Z][A-Z0-9_]*_(?:PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|CREDENTIAL))"?\s*[=:]\s*["']?([^\s"']+)/g
// Credential directories. Matches from the directory onward (the part before
// it — `~/`, `/home/alice/`, `C:\\Users\\alice\\` — is kept; identifying
// home paths are `project-path-normalize.ts`'s concern). The directory must
// follow a path separator and end at a separator or a non-name char, so prose
// (".ssh folder"), hostnames (`foo.aws.com`) and `~/.sshrc` don't match.
const CREDENTIAL_PATH_RE =
  /(?<=[\\/])\.(?:ssh|aws|kube|gnupg|config[\\/]gcloud)(?![\w.-])(?:[\\/][^\s"'`<>()[\]{},;]*)?/gi
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

// Terminal escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or
// `ESC \\`) and the two-character forms, removed whole so a colour code does
// not leave `[31m` behind. Then the C0/C1 controls except tab / LF / CR, DEL,
// and the bidi embedding / override / isolate chars (U+202A–202E,
// U+2066–2069) that make text render in an order other than its bytes.
const ESCAPE_SEQUENCE_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const STRIPPED_CONTROL_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

/**
 * Pre-normalization step for text headed to a model: drops terminal escape
 * sequences, C0/C1 control characters (keeping `\t` `\n` `\r`) and bidi
 * overrides. An escape inside a secret would otherwise split it out of reach
 * of every detector, and a bidi override lets text read differently from
 * what is sent.
 *
 * Deliberately separate from `redactText`, whose output must equal its input
 * outside the placeholders (round-trip and offset translation depend on it).
 * Call it BEFORE `redactText` when char offsets into the original are not
 * needed; `hasNoLeakingPii` applies it internally to its second scan.
 */
export function normalizeForRedaction(text: string): string {
  return text.replace(ESCAPE_SEQUENCE_RE, "").replace(STRIPPED_CONTROL_RE, "")
}

// One placeholder anywhere in a string (non-global → stateless `.test()`).
const PLACEHOLDER_DETECT = new RegExp(PII_PLACEHOLDER_SOURCE)

/**
 * Whether a `Bearer` operand looks like a credential rather than a word.
 * Random tokens of ≥16 chars virtually always carry a digit or an upper-case
 * letter past the first char; English words ("authentication",
 * "Authentication") carry neither.
 */
function isTokenLike(token: string): boolean {
  return /\d/.test(token) || /[A-Z]/.test(token.slice(1))
}

// Values that point at a secret instead of containing one.
const ENV_REFERENCE_RE =
  /^(?:\$|%|\{\{|process\.env\b|import\.meta\.env\b|os\.environ\b|os\.getenv\b|getenv\(|env\()/

function isRedactableEnvValue(value: string): boolean {
  if (value.length < 8) return false
  if (PLACEHOLDER_DETECT.test(value)) return false
  return !ENV_REFERENCE_RE.test(value)
}

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

function isValidUsSsn(value: string): boolean {
  const [area, group, serial] = value.split("-").map((part) => Number.parseInt(part, 10))
  if (area === undefined || group === undefined || serial === undefined) return false
  return area > 0 && area !== 666 && area < 900 && group > 0 && serial > 0
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
  const [a, b] = parts as [number, number, number, number]
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
  // Bearer and env-style values after JWT (so `Bearer eyJ…` is a JWT) and
  // after the prefix pass (so `OPENAI_API_KEY=sk-…` is already a placeholder
  // and the env pass skips it). Only the token / value is replaced; the
  // `Bearer ` keyword and the variable name stay.
  out = out.replace(BEARER_RE, (full, token: string) =>
    isTokenLike(token) ? full.replace(token, tokenize(state, "API_KEY", token)) : full
  )
  out = out.replace(ENV_SECRET_RE, (full, _name: string, value: string) =>
    isRedactableEnvValue(value)
      ? full.slice(0, full.length - value.length) + tokenize(state, "API_KEY", value)
      : full
  )
  out = out.replace(API_KEY_HINT_RE, (full, secret: string) =>
    full.replace(secret, tokenize(state, "API_KEY", secret))
  )
  // Credential paths before the digit passes so `id_rsa_2024…` segments are
  // claimed whole instead of being probed as phones / cards.
  out = out.replace(CREDENTIAL_PATH_RE, (m) => tokenize(state, "CREDENTIAL_PATH", m))
  out = out.replace(BANK_CARD_CANDIDATE_RE, (m) =>
    luhn(m.replace(/[ -]/g, "")) ? tokenize(state, "BANK_CARD", m) : m
  )
  out = out.replace(CN_ID_RE, (m) => tokenize(state, "CN_ID", m))
  out = out.replace(SSN_RE, (m) => (isValidUsSsn(m) ? tokenize(state, "SSN", m) : m))
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

interface RedactionSpan {
  origStart: number
  origEnd: number
  redStart: number
  redEnd: number
}

function redactionSpans(redacted: string, map: Record<string, RedactionRecord>): RedactionSpan[] {
  const spans: RedactionSpan[] = []
  let redCursor = 0
  let origCursor = 0
  for (const match of redacted.matchAll(PLACEHOLDER_SCAN_RE)) {
    const record = map[match[0]]
    if (!record) continue
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
  return spans
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
  const spans = redactionSpans(redacted, map)

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
 * Restore chunk ranges from redacted space to canonical original-text space.
 * A boundary inside a placeholder has no exact original position: expand the
 * start/end outwards to the original span. Callers must slice the original
 * text with these ranges, rather than unredacting an incomplete placeholder.
 * All offsets use UTF-16 half-open ranges, as String.slice does.
 */
export function restoreOffsetsThroughRedaction<T extends RedactableOffsetEntry>(
  entries: T[],
  redacted: string,
  map: Record<string, RedactionRecord>
): T[] {
  const spans = redactionSpans(redacted, map)
  const last = spans.at(-1)
  const originalLength = redacted.length + (last ? last.origEnd - last.redEnd : 0)
  const restore = (offset: number, end: boolean): number => {
    const bounded = Math.max(0, Math.min(offset, redacted.length))
    let delta = 0
    for (const span of spans) {
      if (bounded <= span.redStart) break
      if (bounded < span.redEnd) return end ? span.origEnd : span.origStart
      delta = span.origEnd - span.redEnd
    }
    return Math.max(0, Math.min(bounded + delta, originalLength))
  }
  return entries.map((entry) => {
    if (
      !Number.isSafeInteger(entry.charStart) ||
      !Number.isSafeInteger(entry.charEnd) ||
      entry.charEnd < entry.charStart
    ) {
      throw new RangeError("Redacted offsets must be ordered finite integers")
    }
    return {
      ...entry,
      charStart: restore(entry.charStart, false),
      charEnd: restore(entry.charEnd, true),
    }
  })
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
  if (!scanIsClean(text)) return false
  // Second scan over the normalized view: an escape sequence or control char
  // spliced into a secret (`sk-abc\x1b[0mdef…`) hides it from the raw scan.
  const normalized = normalizeForRedaction(text)
  return normalized === text || scanIsClean(normalized)
}

function scanIsClean(text: string): boolean {
  // Presence checks run on NON-global detector clones: `.test()` on a
  // non-global regex is stateless (no `lastIndex` to track or reset), so the
  // gate is idempotent and safe under concurrent / interleaved calls. The
  // IPv4 / bank-card passes need every match (to apply a predicate), so they
  // use `matchAll`, which clones the regex internally and never mutates the
  // shared global's `lastIndex`.
  if (EMAIL_DETECT.test(text)) return false
  if (CN_ID_DETECT.test(text)) return false
  for (const match of text.matchAll(SSN_RE)) {
    if (isValidUsSsn(match[0])) return false
  }
  if (API_KEY_DETECT.test(text)) return false
  if (API_KEY_HINT_DETECT.test(text)) return false
  for (const match of text.matchAll(BEARER_RE)) {
    if (isTokenLike(match[1] ?? "")) return false
  }
  for (const match of text.matchAll(ENV_SECRET_RE)) {
    if (isRedactableEnvValue(match[2] ?? "")) return false
  }
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

/** `data:<mime>[;params];base64,<payload>`, the whole string. */
const BASE64_DATA_URL_RE =
  /^data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+=[^;,]*)*);base64,([A-Za-z0-9+/]*={0,2})$/i
/** A bare base64 run with no separators, padded to a whole quantum. */
const BARE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/**
 * Shorter than this, a base64-alphabet string is scanned like any text: API
 * keys, AWS ids and tokens are that alphabet and well under it.
 */
const OPAQUE_BASE64_MIN_CHARS = 1024

function isTextLikeMediaType(mediaType: string): boolean {
  const mime = mediaType.toLowerCase()
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/yaml" ||
    mime === "image/svg+xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  )
}

function decodeBase64Text(payload: string): string | undefined {
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(payload, "base64").toString("utf-8")
    const binary = atob(payload)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

/**
 * One string leaf of a structured payload.
 *
 * A base64 transport field (an image's bytes, a `data:` URL, a resource blob)
 * is not text, and scanning its characters as text finds PII-shaped runs by
 * chance: about one 300 KB photo in twenty tripped the gate, refusing image
 * turns at random. Nothing real is lost by not scanning it raw, because base64
 * hides whatever it encodes from a text detector anyway. So such a field is
 * read for what it encodes instead: a text-like `data:` URL is decoded and
 * scanned, binary bytes carry no text, and a bare run counts as base64 only
 * from {@link OPAQUE_BASE64_MIN_CHARS} on, above any key or token.
 */
function payloadStringIsClean(value: string): boolean {
  const dataUrl = value.startsWith("data:") ? BASE64_DATA_URL_RE.exec(value) : null
  if (dataUrl) {
    const [, mediaType = "", params = "", payload = ""] = dataUrl
    if (!hasNoLeakingPii(params)) return false
    if (!isTextLikeMediaType(mediaType)) return true
    const decoded = decodeBase64Text(payload)
    return decoded === undefined || hasNoLeakingPii(decoded)
  }
  if (
    value.length >= OPAQUE_BASE64_MIN_CHARS &&
    value.length % 4 === 0 &&
    BARE_BASE64_RE.test(value)
  ) {
    return true
  }
  return hasNoLeakingPii(value)
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
  if (typeof value === "string") return payloadStringIsClean(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return true
  }
  if (value instanceof Date) return true
  if (typeof value === "object") {
    if (seen.has(value)) return false // active ancestor → cycle
    seen.add(value)
    try {
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
      return Object.values(value as Record<string, unknown>).every((v) =>
        hasNoLeakingPiiDeep(v, seen)
      )
    } finally {
      // Shared JSON-schema objects are aliases, not cycles; scan each occurrence.
      seen.delete(value)
    }
  }
  // Functions, symbols, and other exotic types: stringify-and-scan fallback.
  try {
    return hasNoLeakingPii(String(value))
  } catch {
    return false
  }
}
