/**
 * Pi credential diagnostics — the `pi auth check` probe (ADR-0119).
 *
 * ADR-0119 fixed the credential boundary in one sentence: *Cognia never reads
 * Pi's credentials; the authentication diagnostic only calls `pi auth check
 * --provider <id> --json --no-refresh`.* The rule was written down and then
 * never implemented, so an unauthenticated Pi surfaced as a failed first
 * prompt instead of as a diagnosis. This module is the missing half.
 *
 * Everything below is copied from Pi 0.84.1's own shipped declarations
 * (`dist/cli/auth-check.d.ts`) and from re-reading `runAuthCommand` in
 * `dist/main.js`, not inferred from prose — the CLI has three behaviours that
 * break the obvious implementation:
 *
 *  1. **The exit code is ambiguous.** `1` means `not_ready` on the happy path,
 *     but a failure to parse the arguments *also* exits `1`, and a usage error
 *     exits `2` exactly like a genuine `invalid` verdict. Classifying on the
 *     exit code alone reports "your credentials are missing" when the real
 *     answer is "Cognia called the CLI wrong".
 *  2. **`--json` is not honoured on the error paths.** Argument and usage
 *     errors print red prose to stderr and write nothing at all to stdout, so
 *     a parser that assumes JSON-or-crash silently sees an empty document.
 *  3. **A verdict can be absent without being negative.** Only parseable JSON
 *     on stdout is authoritative; anything else is {@link PiAuthProbeStatus}
 *     `unreadable`, which the UI must render as "could not check" rather than
 *     as "not authenticated".
 *
 * `--no-refresh` is not cosmetic either: it makes Pi open its credential store
 * through `ReadOnlyAuthStorage`, which is what guarantees a Cognia diagnostic
 * can never rewrite, refresh or expire the user's own Pi credentials.
 */

/** Pi's own `AuthCheckStatus` (0.84.1 `dist/cli/auth-check.d.ts`). */
export type PiAuthStatus = "ready" | "not_ready" | "invalid"

/** Pi's own `AuthCheckReason` (0.84.1 `dist/cli/auth-check.d.ts`). */
export type PiAuthReason =
  "provider_not_found" | "credentials_not_configured" | "credential_not_available" | "invalid_state"

/** Pi's own `AuthCheckResult.authType`. */
export type PiAuthType = "api_key" | "oauth"

/**
 * Cognia's verdict statuses: Pi's three, plus `unreadable` for "the probe did
 * not produce an answer". Collapsing the fourth into `invalid` would report a
 * Cognia-side mistake as a problem with the user's credentials.
 */
export type PiAuthProbeStatus = PiAuthStatus | "unreadable"

export interface PiAuthVerdict {
  status: PiAuthProbeStatus
  /** The provider Pi resolved. May differ from the one asked for when a
   *  `--model` was used, because Pi maps the model to its own provider. */
  provider: string | null
  /** Present on `not_ready` / `invalid`, when Pi reported one. */
  reason?: PiAuthReason
  /** Present on `ready`. */
  authType?: PiAuthType
  /**
   * Why the probe was unreadable. Never carries CLI output verbatim: Pi's
   * error prose is not a credential today, but this is the one path that would
   * quietly start forwarding one if that ever changed.
   */
  unreadableReason?: "no_output" | "not_json" | "unknown_shape"
}

/**
 * Auth subcommands that must never be spawned from Cognia.
 *
 * `pi auth check` reports a status. Its two siblings print the credential
 * itself to stdout, which would put a user's API key or bearer token into a
 * Cognia process, its logs and any captured probe output. ADR-0119 bans them;
 * this array is what a test can assert against.
 */
export const PI_AUTH_FORBIDDEN_SUBCOMMANDS = ["print-api-key", "print-bearer-token"] as const

/**
 * The `--credentials` flag makes even `check` emit the secret. It is banned for
 * the same reason, and separately, because it is the only way to reach Pi's
 * `credential_not_available` reason.
 */
export const PI_AUTH_FORBIDDEN_FLAGS = ["--credentials"] as const

const STATUSES = new Set<PiAuthStatus>(["ready", "not_ready", "invalid"])
const REASONS = new Set<PiAuthReason>([
  "provider_not_found",
  "credentials_not_configured",
  "credential_not_available",
  "invalid_state",
])
const AUTH_TYPES = new Set<PiAuthType>(["api_key", "oauth"])

/**
 * The exact argv for a credential check.
 *
 * Built here rather than at the call site so the banned flags cannot be
 * appended by accident and the `--no-refresh` read-only guarantee cannot be
 * dropped by an edit somewhere else.
 */
export function buildPiAuthCheckArgs(target: { provider: string } | { model: string }): string[] {
  const selector =
    "provider" in target ? ["--provider", target.provider] : ["--model", target.model]
  return ["auth", "check", ...selector, "--json", "--no-refresh"]
}

/**
 * Classify one `pi auth check` run.
 *
 * `stdout` is the authority. `exitCode` is corroboration only — see the three
 * CLI behaviours in the module comment for why it cannot lead.
 */
export function classifyPiAuthProbe(input: {
  stdout: string
  exitCode?: number | null
}): PiAuthVerdict {
  const line = lastJsonLine(input.stdout)
  if (line === null) {
    return {
      status: "unreadable",
      provider: null,
      unreadableReason: input.stdout.trim() ? "not_json" : "no_output",
    }
  }

  const status = line.status
  if (typeof status !== "string" || !STATUSES.has(status as PiAuthStatus)) {
    return { status: "unreadable", provider: null, unreadableReason: "unknown_shape" }
  }

  const provider = typeof line.provider === "string" && line.provider ? line.provider : null
  const verdict: PiAuthVerdict = { status: status as PiAuthStatus, provider }

  if (typeof line.reason === "string" && REASONS.has(line.reason as PiAuthReason)) {
    verdict.reason = line.reason as PiAuthReason
  }
  if (typeof line.authType === "string" && AUTH_TYPES.has(line.authType as PiAuthType)) {
    verdict.authType = line.authType as PiAuthType
  }
  return verdict
}

/**
 * The last parseable JSON object in `stdout`.
 *
 * Pi writes exactly one line, but the probe transport concatenates whatever the
 * process emitted, and a wrapper (a shell profile, a Node deprecation notice)
 * can prepend noise. Reading the last object rather than the whole buffer keeps
 * a chatty environment from making a perfectly good verdict unreadable.
 */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not this line. Keep walking backwards.
    }
  }
  return null
}

// ============================================================================
// Provider discovery
// ============================================================================

/**
 * Providers Pi can actually use right now, parsed from `pi --list-models`.
 *
 * `auth check` requires a provider or a model — there is no "check everything"
 * form — so the diagnostic needs a set to iterate. `--list-models` is the right
 * source because Pi already filters it down to providers whose credentials
 * resolve, which makes an *empty* list the very answer the diagnostic exists to
 * surface. Two things it is not: it has no `--json` mode (both `--json` and
 * `--mode json` are accepted and ignored, verified against 0.84.1), and it can
 * come back empty on a cold models store rather than because nothing is
 * configured. Both are why {@link parsePiModelProviders} distinguishes "no
 * header" from "header, no rows".
 */
export type PiProviderListing =
  | { status: "ok"; providers: string[] }
  /** The header row was absent — the output shape changed, or the command
   *  failed. Not the same as "no providers", and must not be rendered as one. */
  | { status: "unreadable" }

export function parsePiModelProviders(stdout: string): PiProviderListing {
  const lines = stdout.split("\n").map((line) => line.trimEnd())
  const headerIndex = lines.findIndex((line) => /^\s*provider\s+model\b/.test(line))
  if (headerIndex < 0) return { status: "unreadable" }

  // Column-driven rather than positional: Pi pads to a fixed width today, but
  // a new column would shift every index. The provider is the first field of
  // each row, so splitting on runs of whitespace is enough and survives an
  // added column, a renamed one, or a width change.
  const providers = new Set<string>()
  for (const line of lines.slice(headerIndex + 1)) {
    const first = line.trim().split(/\s+/)[0]
    if (first) providers.add(first)
  }
  return { status: "ok", providers: [...providers].sort() }
}
