/**
 * The failure taxonomy Deep Research reports to the user.
 *
 * Two very different things can stop a research run, and collapsing them was
 * the old design's weakness: a missing search provider is a *precondition* the
 * user can fix in Settings, while a single dead URL is noise the loop should
 * absorb. Codes here name the first kind. Everything else stays a warning in
 * the log and the loop keeps going.
 *
 * Errors marked `fatal` propagate out of the engine's per-query `catch` so the
 * run stops with a card the user can act on, instead of quietly answering from
 * zero evidence.
 */

export type ResearchErrorCode =
  /** No model provider is configured/reachable for this host or session. */
  | "NO_PROVIDER"
  /** The plugin lacks `ai:chat` / `ai:embed`. */
  | "NO_AI_PERMISSION"
  /** The user turned web tools off in Settings. */
  | "WEB_DISABLED"
  /** Web tools are on, but no search provider is configured. */
  | "NO_SEARCH_PROVIDER"
  /** The outbound token bucket refused the call. */
  | "RATE_LIMITED"
  /** A guard refused the request (PII redaction, SSRF target policy). */
  | "BLOCKED"
  /** The host does not expose the web tools this plugin needs. */
  | "TOOL_UNAVAILABLE"
  /** Anything else — network faults, provider 5xx, malformed responses. */
  | "FAILED"

/** A host-tool or model failure, classified for the user-facing card. */
export class ResearchToolError extends Error {
  readonly code: ResearchErrorCode
  /**
   * Fatal errors abort the run. A non-fatal one (a page that would not load)
   * is logged and skipped — losing one source is not losing the answer.
   */
  readonly fatal: boolean

  constructor(code: ResearchErrorCode, message: string, fatal = true) {
    super(message)
    this.name = "ResearchToolError"
    this.code = code
    this.fatal = fatal
  }
}

/** Is this an error the engine must stop for rather than skip past? */
export function isFatalResearchError(err: unknown): boolean {
  return err instanceof Error && (err as { fatal?: unknown }).fatal === true
}

/**
 * Classify anything thrown during a run.
 *
 * The host's own failures arrive as plain `Error`s with stable, host-owned
 * markers rather than as our types: `ctx.ai` throws a structured
 * `NO_PROVIDER_AVAILABLE`, the permission gate throws a `PermissionError`, and
 * the PII gate throws a `PluginPiiError`. Reading those markers (not their
 * prose) is how the plugin keeps its friendly cards without importing host
 * internals.
 */
export function classifyResearchError(err: unknown): ResearchErrorCode {
  if (err instanceof ResearchToolError) return err.code
  if (!(err instanceof Error)) return "FAILED"
  if ((err as { code?: unknown }).code === "NO_PROVIDER_AVAILABLE") return "NO_PROVIDER"
  if (err.name === "PermissionError") return "NO_AI_PERMISSION"
  if (err.name === "PluginPiiError") return "BLOCKED"
  return "FAILED"
}
