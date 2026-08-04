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
 * OTel variables propagated to the Claude Code subprocess so its spans land in
 * the same collector as the sidecar's, under one trace.
 *
 * These are NOT in {@link ENV_ALLOWLIST}, and that is the point. `OTEL_*` and
 * `CLAUDE_*` are both stripped from the ambient parent env, so a developer's
 * shell exporting `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` cannot silently start
 * shipping a user's agent traces somewhere. Propagation happens only through
 * {@link childTelemetryEnv}, and only when THIS process was itself configured
 * with an endpoint — the same "no endpoint means completely silent" rule
 * `initializeTelemetry` follows.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` is included because it is how a collector is
 * authenticated; without it the child exports and is rejected, which looks
 * exactly like telemetry being off. It travels no further than the subprocess
 * env — never into the resolved spec, the event log, or a span
 * (ADR-0090 constraint 4).
 */
export const CHILD_TELEMETRY_ENV = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_LOG_USER_PROMPTS",
]

/**
 * Build the OTel env for the Claude Code subprocess.
 *
 * Returns `{}` unless the sidecar itself has a traces endpoint configured, so
 * enabling child telemetry is a single decision made in one place rather than
 * two switches that can disagree.
 *
 * `CLAUDE_CODE_ENABLE_TELEMETRY` and `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` are
 * what the CLI reads to turn its own emission on. The enhanced flag is opt-in
 * per send (`sendOptions.telemetry.enhanced`) and NOT derived from the parent,
 * because it widens what the child records.
 *
 * `OTEL_LOG_USER_PROMPTS` is force-set to `0`, never inherited: the sidecar's
 * own spans are built with `recordInputs: false` / `recordOutputs: false`, and
 * a child that logged prompt bodies would break that contract from the other
 * end while looking like the same configuration.
 *
 * @param {Record<string, any>} sendOptions
 * @param {NodeJS.ProcessEnv} parentEnv
 * @returns {Record<string, string>}
 */
export function childTelemetryEnv(sendOptions, parentEnv = process.env) {
  if (sendOptions?.telemetry?.child === false) return {}
  if (!parentEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return {}

  const out = { CLAUDE_CODE_ENABLE_TELEMETRY: "1" }
  for (const name of CHILD_TELEMETRY_ENV) {
    const value = parentEnv[name]
    if (typeof value === "string" && value !== "") out[name] = value
  }
  if (sendOptions?.telemetry?.enhanced === true) {
    out.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1"
  }
  // Force-set last so an inherited value cannot re-enable prompt logging.
  out.OTEL_LOG_USER_PROMPTS = "0"
  return out
}

/**
 * Build the subprocess env for a send.
 *
 * With a frozen spec: allowlisted parent vars + child telemetry + the
 * `sendOptions.env` overlay (the spec's env is authoritative — proxy vars or
 * credentials come back ONLY if the resolver put them there). Without one: the
 * legacy spread.
 *
 * The telemetry block sits BETWEEN the allowlist and the overlay: it is a host
 * decision, so it beats whatever leaked through the allowlist, and the
 * spec-approved overlay still beats it — a resolver that deliberately sets an
 * OTel variable stays authoritative.
 *
 * @param {Record<string, any>} sendOptions
 * @param {NodeJS.ProcessEnv} [parentEnv]
 * @returns {Record<string, string>}
 */
export function buildSubprocessEnv(sendOptions, parentEnv = process.env) {
  const overlay = sendOptions?.env ?? {}
  const claudeTempEnv =
    process.platform === "darwin" && typeof parentEnv.TMPDIR === "string" && parentEnv.TMPDIR !== ""
      ? { CLAUDE_CODE_TMPDIR: parentEnv.TMPDIR }
      : {}
  if (!sendOptions?.execution) {
    // Child telemetry is NOT added here — ADR-0090 constraint 6, and the legacy
    // spread already passes the parent's OTEL_* through anyway. On macOS,
    // redirect Claude's hard-coded /tmp base to the app's writable per-user
    // temp directory; an explicit session overlay remains authoritative.
    return { ...parentEnv, ...claudeTempEnv, ...overlay }
  }
  const base = {}
  for (const name of Object.keys(parentEnv)) {
    if (!ENV_ALLOWLIST.has(name)) continue
    const value = parentEnv[name]
    if (typeof value === "string") base[name] = value
  }
  return {
    ...base,
    ...childTelemetryEnv(sendOptions, parentEnv),
    ...claudeTempEnv,
    ...overlay,
  }
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
