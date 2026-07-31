export const DEFAULT_REDACTION_REPLACEMENT = "[REDACTED]"

export const DEFAULT_REDACTION_KEYS = [
  "password",
  "passwd",
  "pwd",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "client_secret",
  "private_key",
  "bearer",
] as const

export const DEFAULT_REDACTION_PATTERNS = [
  // Generic bearer/JWT-like token fragments.
  "Bearer\\s+[A-Za-z0-9\\-._~+/]+=*",
  // API key style assignments.
  "(api[_-]?key|token|secret)\\s*[:=]\\s*[A-Za-z0-9\\-._~+/=]{8,}",
] as const

export const CRASH_LOG_TEXT_REDACTION_PATTERNS = [
  ...DEFAULT_REDACTION_PATTERNS,
  "[A-Za-z]:\\\\(?:[^\\\\\\s]+\\\\)*[^\\\\\\s]+",
  "(?:/Users|/home|/var|/tmp|/private|/opt|/etc)(?:/[^\\s\"']+)+",
  "https?:\\/\\/[^\\s\"']+",
] as const

export const CRASH_LOG_KEY_HINTS = [
  ...DEFAULT_REDACTION_KEYS,
  "path",
  "file",
  "directory",
  "url",
  "endpoint",
] as const
