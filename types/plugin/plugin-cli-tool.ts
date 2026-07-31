/**
 * Declarative CLI wrapper tools (`manifest.cliTools`) — wrap an external
 * binary (ripgrep, ffmpeg, gh, …) as an agent tool with ZERO plugin code.
 *
 * Injection safety is structural, not sanitized-after-the-fact:
 *   - argv is a token list; a `{ param }` token substitutes as EXACTLY ONE
 *     argv element (arrays expand to N elements) — values are never
 *     concatenated into a shell string and never parsed by a shell
 *   - the program itself comes from a fixed manifest reference (a
 *     `requires.binaries` name resolved via detect_binary, or a path inside
 *     the plugin dir vetted by the binary trust policy) — never templated
 *   - `env` is a static manifest map; parameters can never set env vars
 *
 * Execution is gated by the DANGEROUS `cli:execute` permission
 * (confirm-tier) and audited per invocation.
 */

/** Where the wrapped executable comes from. Never templated. */
export type PluginCliBinaryRef =
  /**
   * Named binary from `manifest.requires.binaries[]` — resolved on PATH via
   * `detect_binary` (presence + minVersion gate) to an absolute path.
   */
  | { kind: "requires"; name: string }
  /**
   * Executable shipped inside the plugin install dir. Spawn is vetted by
   * the binary trust policy (inside-dir + trusted publisher fingerprint →
   * silent; otherwise a user prompt), mirroring the LSP binary policy.
   */
  | { kind: "plugin-dir"; relPath: string }

/**
 * One argv element. A param ref IS the whole element — a value like
 * `-rf /` or `$(rm -rf)` can never break out into extra arguments.
 */
export type PluginCliArgvToken =
  | { literal: string }
  | {
      /** Name of a declared parameter whose value fills this slot. */
      param: string
      /**
       * For array params: emit `eachPrefixedBy` before every element
       * (e.g. `--glob a --glob b`). Ignored for scalar values.
       */
      eachPrefixedBy?: string
      /** Drop the token (and its prefix) when the value is absent/empty. */
      omitWhenEmpty?: boolean
    }

export type PluginCliOutputParse = "text" | "json" | "lines"

export type PluginCliCwdPolicy =
  | { kind: "plugin-dir" }
  | { kind: "workspace" }
  /** A path parameter, validated to resolve inside the workspace root. */
  | { kind: "param"; param: string }
  | { kind: "none" }

/** One declarative CLI tool. */
export interface PluginCliToolDef {
  /** Tool name (snake_case, same rule as runtime plugin tools). */
  name: string
  description: string
  /** JSON Schema (draft-07 object) for the tool's parameters. */
  parameters: Record<string, unknown>
  binary: PluginCliBinaryRef
  /** argv AFTER the program name; params resolve to discrete elements. */
  argv: PluginCliArgvToken[]
  /** Pipe a named string param into the child's stdin. */
  stdin?: { param: string }
  /** Working directory policy (default `{ kind: "none" }`). */
  cwd?: PluginCliCwdPolicy
  /** Static extra environment variables (allowlist map, never templated). */
  env?: Record<string, string>
  /** Per-invocation timeout, clamped host-side to 600_000 ms. */
  timeoutMs?: number
  /** How stdout becomes the tool result (default "text"). */
  outputParse?: PluginCliOutputParse
  /** Exit codes treated as success (default `[0]`; rg uses `[0, 1]`). */
  successExitCodes?: number[]
  /** Output cap in bytes; overflow is truncated and flagged (default 1MB). */
  maxOutputBytes?: number
  /** Override the version probe arg for `requires` binaries. */
  versionArg?: string
}
