/**
 * Credential-shaped text redaction, for anything captured from a process or a
 * transport and then stored or shown.
 *
 * This is not the PII gate. `@cognia/redact`'s `redactText` is a
 * placeholder-and-restore pipeline for text on its way to a model, and
 * `hasNoLeakingPii` is the gate before an LLM or embedding call. This module
 * answers a narrower question: a build script printed something, a fetch was
 * logged — strip the shapes that are obviously secrets before that string is
 * written down.
 *
 * Extracted from `lib/test/e2e-diagnostics.ts`, which had the only copy. Sites
 * build logs need the same four patterns: `runConfinedSiteBuild` blocks
 * credential-shaped environment *keys* from entering the child
 * (`lib/sites/confined-build.ts`), but a build script can still print a token
 * it fetched itself, and that output is now persisted.
 */

/**
 * `KEY: value` / `KEY=value` where the key names a credential.
 *
 * Two deliberate widenings over the pattern this was extracted from:
 *
 *  - The key may be *suffixed* onto a longer name. `\b` does not match between
 *    `_` and `TOKEN`, so `CLOUDFLARE_API_TOKEN=…` — exactly the shape a Sites
 *    build script prints — went through untouched.
 *  - The value stops at `&` as well as whitespace, comma, and semicolon, so
 *    redacting one query parameter no longer swallows the rest of the query
 *    string.
 */
const SENSITIVE_FIELD_PATTERN =
  /((?:^|[\s,;&{("'[])[\w.-]*(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

/** Query keys whose value is a credential wherever the URL came from. */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "code",
  "cookie",
  "key",
  "password",
  "refresh_token",
  "secret",
  "token",
])

/**
 * Replace bearer tokens, JWTs, `key: value` secrets, and email addresses.
 *
 * Order matters: bearer and JWT run before the field pattern so a
 * `Authorization: Bearer eyJ…` line is replaced once, not twice.
 */
export function redactCredentialText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(SENSITIVE_FIELD_PATTERN, "$1[REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
}

/**
 * Redact a URL's sensitive query values, then run the text patterns over the
 * result. A string that does not parse as a URL is treated as text.
 */
export function redactCredentialUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[REDACTED]")
    }
    return redactCredentialText(url.toString())
  } catch {
    return redactCredentialText(value)
  }
}
