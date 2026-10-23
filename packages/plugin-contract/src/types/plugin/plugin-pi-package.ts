/**
 * Plugin-shipped Pi packages (`manifest.piPackages`, capability `pi-package`).
 *
 * A Cognia plugin can carry a complete Pi package (a directory whose
 * `package.json` declares a `pi` manifest, or Pi's conventional
 * `extensions/` `skills/` `prompts/` `themes/` directories) and offer it to
 * Pi in two independent ways:
 *
 *   1. **Install into the user's Pi.** Cognia runs `pi install <abs path>`
 *      (`-l` for project scope) through `lib/pi-packages/host.ts`, or records
 *      the path in `settings.json` when Pi is not reachable. Pi never installs
 *      dependencies for a local package, so `prepare` exists to run a fixed,
 *      consented dependency step inside the package directory first.
 *   2. **Load into a Cognia-hosted Pi session.** A `pi-rpc` agent opts in to a
 *      package by reference (agent metadata `piPackages`, a list of
 *      {@link PluginPiPackageRef}). The adapter appends one `-e <abs path>` per
 *      `hostedSession.extensions` entry and forwards `hostedSession.env` values
 *      as `COGNIA_PIPKG_<NAME>`; the external-agent env policy admits only that
 *      prefix, so a plugin can never set `NODE_OPTIONS`, `LD_PRELOAD` or a
 *      provider credential this way.
 *
 * Both require a plugin that lives on disk: a `builtin://` plugin has no
 * directory Pi could read, and every operation refuses it with a typed error.
 * See ADR-0210.
 */

/** Dependency preparation run in the package directory. Program is never templated. */
export interface PluginPiPackagePrepare {
  /** Package manager to run; resolved on PATH like `requires.binaries`. */
  program: "npm" | "pnpm"
  /** Static argv after the program name. Never interpolated. */
  args: string[]
  /**
   * Plugin-relative marker whose existence means the step already ran
   * (e.g. `vendor/node_modules/.package-lock.json`). Omitted = always run, and
   * the package is never reported as prepared.
   */
  marker?: string
  /** Clamped host-side to {@link PI_PACKAGE_PREPARE_MAX_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Where a forwarded session env value comes from. Never a model-supplied value. */
export type PluginPiPackageEnvSource =
  /** A key of the plugin's own `configSchema` / `defaultConfig`. */
  | { config: string }
  /** A static manifest literal. */
  | { value: string }
  /** The session's absolute workspace directory. */
  | { workspace: true }

export interface PluginPiPackageEnvBinding {
  /**
   * Suffix after `COGNIA_PIPKG_`: upper-case letters, digits and `_`, starting
   * with a letter. A cooperating extension reads
   * `process.env.COGNIA_PIPKG_<name>`.
   */
  name: string
  from: PluginPiPackageEnvSource
}

export interface PluginPiPackageHostedSession {
  /**
   * Plugin-relative extension entry files (`.ts` / `.js` / `.mjs`) loaded with
   * `-e`, in order, before Cognia's own interception extension. These are
   * explicit (not read back from `package.json`) so what Cognia loads is
   * reviewable from the manifest alone.
   */
  extensions: string[]
  /** Values forwarded as `COGNIA_PIPKG_<name>`. */
  env?: PluginPiPackageEnvBinding[]
  /**
   * Tool names the extensions register. Admitted through the process-level
   * `--tools` floor and allowed by the per-call table only when a `dontAsk`
   * session pre-approves them by name; in every other mode each call takes the
   * per-call permission table's `fallback` decision.
   */
  tools?: string[]
  /**
   * The extension replaces the session's tool surface (e.g. restricts the
   * active tools to its own). Shown before an agent opts in.
   */
  controlsSession?: boolean
}

export interface PluginPiPackageDef {
  /** Unique within the plugin: lowercase kebab-case. */
  id: string
  name: string
  nameKey?: string
  description?: string
  descriptionKey?: string
  /** Plugin-relative directory of the Pi package (`.` for the plugin root). */
  path: string
  /** Lowest Pi version the package was verified against (semver). */
  minPiVersion?: string
  prepare?: PluginPiPackagePrepare
  /** Present = the package may be loaded into Cognia-hosted Pi sessions. */
  hostedSession?: PluginPiPackageHostedSession
}

/** Stable reference to one contributed package: `<pluginId>/<packageId>`. */
export type PluginPiPackageRef = `${string}/${string}`

/** Session env prefix the external-agent policy admits for plugin Pi packages. */
export const PI_PACKAGE_ENV_PREFIX = "COGNIA_PIPKG_"

/** Hard ceiling for `prepare.timeoutMs` (the native exec path's own cap). */
export const PI_PACKAGE_PREPARE_MAX_TIMEOUT_MS = 600_000

/** `prepare.timeoutMs` when the manifest omits it. */
export const PI_PACKAGE_PREPARE_DEFAULT_TIMEOUT_MS = 300_000

/** Package managers `prepare.program` may name. */
export const PI_PACKAGE_PREPARE_PROGRAMS = ["npm", "pnpm"] as const

/** Extension entry file suffixes Pi can load with `-e`. */
export const PI_PACKAGE_EXTENSION_SUFFIXES = [".ts", ".js", ".mjs"] as const

/** `hostedSession.env[].name` — the part after {@link PI_PACKAGE_ENV_PREFIX}. */
export const PI_PACKAGE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** `piPackages[].id` — lowercase kebab-case. */
export const PI_PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `hostedSession.tools[]` — what Pi accepts as a registered tool name. */
export const PI_PACKAGE_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Build the stable reference for one contributed package. */
export function formatPiPackageRef(pluginId: string, packageId: string): PluginPiPackageRef {
  return `${pluginId}/${packageId}`
}

/**
 * Split a reference into its plugin and package ids, or `null` when it is not
 * well-formed. Split on the LAST `/`: package ids are kebab-case and never
 * contain one, so whatever precedes it is the plugin id verbatim.
 */
export function parsePiPackageRef(ref: string): { pluginId: string; packageId: string } | null {
  if (typeof ref !== "string") return null
  const slash = ref.lastIndexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return null
  const pluginId = ref.slice(0, slash)
  const packageId = ref.slice(slash + 1)
  if (!PI_PACKAGE_ID_PATTERN.test(packageId)) return null
  return { pluginId, packageId }
}

/** Clamp a declared prepare timeout into `(0, PI_PACKAGE_PREPARE_MAX_TIMEOUT_MS]`. */
export function clampPiPackagePrepareTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return PI_PACKAGE_PREPARE_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.floor(timeoutMs), PI_PACKAGE_PREPARE_MAX_TIMEOUT_MS)
}
