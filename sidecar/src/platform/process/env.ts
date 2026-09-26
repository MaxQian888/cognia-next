// The environment policy every subprocess the sidecar starts shares: which
// parent variables are plain runtime plumbing (inherited) and which name
// credentials or routing (never inherited implicitly).
//
// The Claude Code subprocess builds its env from this allowlist when a frozen
// execution spec is present (runtimes' subprocess env, ADR-0090 Phase 3), and
// the sandboxed tool processes filter overrides through the strip classes
// (./exec.ts).

/** Names inherited from the parent process (exact matches). */
export const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // POSIX basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  // TLS trust
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // XDG dirs
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // Windows
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "OS",
])

/**
 * Documented strip classes. Everything not allowlisted is dropped anyway;
 * this list exists so tests can assert the dangerous names stay out even
 * when present in the parent env, and so reviewers can see the intent.
 */
export const ENV_STRIP_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^CLAUDE_/i, // CLAUDE_CODE_*, CLAUDE_CONFIG_DIR, …
  /^OPENAI_/i,
  /^AZURE_OPENAI_/i,
  /^GEMINI_/i,
  /^GOOGLE_API_KEY$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^OPENROUTER_/i,
  /^AWS_/i,
  /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i,
  // Catch-all secret shapes.
  /_API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
]

/** Does `name` belong to a strip class (credential, provider routing, proxy)? */
export function isStrippedName(name: string): boolean {
  return ENV_STRIP_PATTERNS.some((pattern) => pattern.test(name))
}
