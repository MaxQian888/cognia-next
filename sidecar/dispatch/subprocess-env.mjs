// Allowlisted subprocess base environment (ADR-0090 Phase 3).
//
// The Claude Code subprocess must never inherit ambient provider routing or
// credentials from the parent process: a stray ANTHROPIC_BASE_URL or
// OPENAI_API_KEY in the desktop app's env would silently redirect or
// re-credential an agent session. When a frozen execution spec
// (`sendOptions.execution`) is present, the subprocess env is REBUILT from an
// explicit allowlist and the spec-approved `sendOptions.env` overlay.
//
// COMPAT GATE (load-bearing): legacy sessions — no `execution` — keep the
// historical `{ ...process.env, ...env }` spread, because the desktop host
// injects ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN into the SIDECAR
// process env and the spread is how they reach Claude Code today. Flipping
// legacy sessions would break every current desktop install. Phase 6 moves
// callers onto `execution`; Phase 9 deletes the legacy spread.

/** Names inherited from the parent process (exact matches). */
export const ENV_ALLOWLIST = new Set([
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
export const ENV_STRIP_PATTERNS = [
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

export function isStrippedName(name) {
  return ENV_STRIP_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Build the subprocess env for a send.
 *
 * With a frozen spec: allowlisted parent vars + `sendOptions.env` overlay
 * (the spec's env is authoritative — proxy vars or credentials come back
 * ONLY if the resolver put them there). Without one: the legacy spread.
 *
 * @param {Record<string, any>} sendOptions
 * @param {NodeJS.ProcessEnv} [parentEnv]
 * @returns {Record<string, string>}
 */
export function buildSubprocessEnv(sendOptions, parentEnv = process.env) {
  const overlay = sendOptions?.env ?? {}
  if (!sendOptions?.execution) {
    // Legacy sessions: today's behavior, byte-for-byte.
    return { ...parentEnv, ...overlay }
  }
  const base = {}
  for (const name of Object.keys(parentEnv)) {
    if (!ENV_ALLOWLIST.has(name)) continue
    const value = parentEnv[name]
    if (typeof value === "string") base[name] = value
  }
  return { ...base, ...overlay }
}

/**
 * Route-derived env additions (ADR-0090): a gateway-routed spec injects ONLY
 * the local endpoint + the ticket secret (which the caller placed into
 * `sendOptions.env.ANTHROPIC_API_KEY`); a direct spec passes through the
 * ephemeral credentials already resolved into `sendOptions.env`. This helper
 * validates the invariant rather than adding values: a gateway route whose
 * overlay smuggles a non-local ANTHROPIC_BASE_URL is a spec violation.
 *
 * @param {Record<string, any>} sendOptions
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateRouteEnv(sendOptions) {
  const execution = sendOptions?.execution
  if (!execution) return { ok: true }
  if (execution.route?.kind !== "gateway") return { ok: true }
  const overlayBase = sendOptions?.env?.ANTHROPIC_BASE_URL
  if (overlayBase && overlayBase !== execution.route.endpoint) {
    return {
      ok: false,
      reason: `gateway route env mismatch: ANTHROPIC_BASE_URL must be the ticket endpoint`,
    }
  }
  return { ok: true }
}
