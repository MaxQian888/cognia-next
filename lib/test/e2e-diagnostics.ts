const SENSITIVE_FIELD_PATTERN =
  /(\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

const SENSITIVE_QUERY_KEYS = new Set([
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

export function redactE2EDiagnosticText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(SENSITIVE_FIELD_PATTERN, "$1[REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
}

export function redactE2EDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[REDACTED]")
      }
    }
    return redactE2EDiagnosticText(url.toString())
  } catch {
    return redactE2EDiagnosticText(value)
  }
}
