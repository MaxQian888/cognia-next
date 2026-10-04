/**
 * Resolve a contributed Pi package (ADR-0210) from its reference to the
 * absolute paths and values every consumer needs.
 *
 * This is the single place a plugin-relative manifest value becomes a path on
 * disk, and every refusal is typed ({@link PiPackageResolutionError}):
 *
 *   - `not-found`      — no enabled plugin contributes this reference;
 *   - `not-on-disk`    — the plugin has no directory (`builtin://<id>`), so Pi
 *                        has nothing it could read;
 *   - `invalid-path`   — a manifest path escapes the plugin directory (the
 *                        validator rejects these, this is defence in depth);
 *   - `not-hosted`     — a session asked for a package that declares no
 *                        `hostedSession`;
 *   - `not-prepared`   — `prepare.marker` is declared and absent (or could not
 *                        be checked), so the package's dependencies are not
 *                        known to be installed;
 *   - `workspace-required` — a `{ workspace: true }` env binding with no
 *                        session working directory;
 *   - `double-load`    — the hosted session would load the package twice (it
 *                        is also installed in a Pi scope the session loads;
 *                        see `session.ts`);
 *   - `resolution-failed` — anything else went wrong while resolving (the
 *                        original error is the `cause`).
 *
 * Env values come from the manifest or from the plugin's own configuration —
 * never from a model — and are forwarded only under {@link PI_PACKAGE_ENV_PREFIX},
 * the one prefix the external-agent env policy admits for this purpose.
 */

import { getPluginPathViolations, resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  PI_PACKAGE_ENV_PREFIX,
  type PluginPiPackageDef,
  type PluginPiPackageRef,
} from "@/types/plugin/plugin-pi-package"
import { getContributedPiPackage, type ContributedPiPackage } from "./registry"

export type PiPackageResolutionErrorCode =
  | "not-found"
  | "not-on-disk"
  | "invalid-path"
  | "not-hosted"
  | "not-prepared"
  | "workspace-required"
  | "double-load"
  | "resolution-failed"

/** Why a contributed package cannot be used. The message is safe to show. */
export class PiPackageResolutionError extends Error {
  readonly reasonCode = "pi_package_unavailable"
  constructor(
    readonly code: PiPackageResolutionErrorCode,
    readonly ref: string,
    message: string
  ) {
    super(message)
    this.name = "PiPackageResolutionError"
  }
}

/**
 * Whether the package's dependency step is known to have run.
 *
 *   - `not-required` — no `prepare` declared;
 *   - `prepared`     — the declared marker exists;
 *   - `missing`      — the declared marker does not exist;
 *   - `unverifiable` — `prepare` declared without a marker: Cognia cannot tell,
 *                      so it never blocks on it and never reports it prepared;
 *   - `unknown`      — the marker could not be checked (web build, probe error).
 */
export type PiPackagePrepareState =
  "not-required" | "prepared" | "missing" | "unverifiable" | "unknown"

/** States in which install and hosted sessions may proceed. */
export function isPiPackageReady(state: PiPackagePrepareState): boolean {
  return state === "not-required" || state === "prepared" || state === "unverifiable"
}

export interface ResolvedContributedPiPackage {
  ref: PluginPiPackageRef
  pluginId: string
  def: PluginPiPackageDef
  /** The plugin's absolute install directory. */
  pluginRoot: string
  /** Absolute directory of the Pi package — the spec `pi install` receives. */
  packageDir: string
  /** Absolute marker path, when `prepare.marker` is declared. */
  markerPath?: string
  prepareState: PiPackagePrepareState
  /** True when the package declares `hostedSession`. */
  hosted: boolean
  /** Absolute `-e` entry files, in manifest order. Empty when not hosted. */
  extensions: string[]
  /** Fully-prefixed env (`COGNIA_PIPKG_<NAME>` → value). Empty when not hosted. */
  env: Record<string, string>
  tools: string[]
  controlsSession: boolean
  minPiVersion?: string
}

export interface PiPackageResolveDeps {
  lookup: (ref: string) => ContributedPiPackage | undefined
  /** The plugin's current config with schema / `defaultConfig` defaults seeded. */
  getPluginConfig: (pluginId: string) => Record<string, unknown> | Promise<Record<string, unknown>>
  /**
   * Does `relative` (plugin-relative, already validated) exist under
   * `pluginRoot`? Throwing means "could not check".
   */
  markerExists: (pluginRoot: string, relative: string) => Promise<boolean>
}

export interface ResolvePiPackageOptions {
  /** The session's absolute working directory, for `{ workspace: true }` env. */
  cwd?: string | null
  /**
   * Resolve for a hosted session: refuse a package without `hostedSession`, a
   * package that is not prepared, and a workspace binding with no `cwd`.
   */
  forSession?: boolean
  deps?: Partial<PiPackageResolveDeps>
}

/** POSIX absolute, Windows drive-absolute or UNC. Never a scheme pseudo-path. */
export function isOnDiskPluginRoot(root: string): boolean {
  if (!root) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(root)) return false
  return root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")
}

function trimRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "")
  return trimmed.length > 0 ? trimmed : root
}

/**
 * Exactly `.` or `./` names the plugin root itself (the manifest validator's
 * and the Rust install check's rule); everything else is plugin-relative.
 */
function isRootSelector(path: string): boolean {
  return path === "." || path === "./"
}

function resolveInside(ref: string, root: string, relative: unknown, label: string): string {
  if (typeof relative !== "string" || getPluginPathViolations(relative).length > 0) {
    throw new PiPackageResolutionError(
      "invalid-path",
      ref,
      `Pi package ${ref}: ${label} ${JSON.stringify(relative)} is not a path inside the plugin directory.`
    )
  }
  if (isRootSelector(relative)) return trimRoot(root)
  try {
    return resolvePluginPath(root, relative)
  } catch (error) {
    // e.g. `./.` normalizes to nothing: still a path refusal, typed as one.
    throw Object.assign(
      new PiPackageResolutionError(
        "invalid-path",
        ref,
        `Pi package ${ref}: ${label} ${JSON.stringify(relative)} is not a path inside the plugin directory.`
      ),
      { cause: error }
    )
  }
}

/** Render a config value as an env string; `undefined` when unset. */
function configValueToEnv(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

async function defaultMarkerExists(pluginRoot: string, relative: string): Promise<boolean> {
  const [{ executeShell }, { shellQuote }, { detectOsFamily }] = await Promise.all([
    import("@/lib/shell/exec"),
    import("@/lib/pi-packages/mutate"),
    import("@/lib/platform/os"),
  ])
  // `shell_exec` is `sh -c` on POSIX and `cmd /C` on Windows. The path is a
  // validated plugin-relative value (no `..`, no absolute, no control chars)
  // and the probe runs with the plugin root as its cwd, so it cannot name a
  // file outside the plugin.
  const command =
    detectOsFamily() === "windows"
      ? `if exist "${relative.replace(/\//g, "\\").replace(/"/g, "")}" (exit 0) else (exit 1)`
      : `test -e ${shellQuote(relative)}`
  const result = await executeShell(command, pluginRoot, 15)
  if (result.timedOut) throw new Error("marker probe timed out")
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(`marker probe exited ${result.exitCode ?? "?"}`)
}

async function defaultGetPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  const [{ usePluginStore }, { seedPluginConfigDefaults }] = await Promise.all([
    import("@/stores/plugin-runtime"),
    import("@/lib/plugin/core/config-defaults"),
  ])
  const plugin = usePluginStore.getState().plugins[pluginId]
  if (!plugin) return {}
  return seedPluginConfigDefaults(plugin.manifest, plugin.config)
}

/** Probe the prepare marker, mapping failures to the `unknown` state. */
export async function probePiPackagePrepareState(
  def: PluginPiPackageDef,
  pluginRoot: string,
  markerExists: PiPackageResolveDeps["markerExists"]
): Promise<PiPackagePrepareState> {
  if (!def.prepare) return "not-required"
  if (!def.prepare.marker) return "unverifiable"
  try {
    return (await markerExists(pluginRoot, def.prepare.marker)) ? "prepared" : "missing"
  } catch {
    return "unknown"
  }
}

/**
 * Resolve one contributed package. Throws {@link PiPackageResolutionError}.
 */
export async function resolveContributedPiPackage(
  ref: string,
  options: ResolvePiPackageOptions = {}
): Promise<ResolvedContributedPiPackage> {
  const lookup = options.deps?.lookup ?? getContributedPiPackage
  const markerExists = options.deps?.markerExists ?? defaultMarkerExists
  const contributed = lookup(ref)
  if (!contributed) {
    throw new PiPackageResolutionError(
      "not-found",
      ref,
      `Pi package ${ref} is not available: no enabled plugin contributes it.`
    )
  }
  const { def, installRoot, pluginId } = contributed
  if (!isOnDiskPluginRoot(installRoot)) {
    throw new PiPackageResolutionError(
      "not-on-disk",
      ref,
      `Pi package ${ref} cannot be used: plugin "${pluginId}" is not installed in a directory ` +
        `(${installRoot || "no install path"}), so Pi has nothing it could read.`
    )
  }

  const pluginRoot = trimRoot(installRoot)
  const packageDir = resolveInside(ref, pluginRoot, def.path, "path")
  const markerPath = def.prepare?.marker
    ? resolveInside(ref, pluginRoot, def.prepare.marker, "prepare.marker")
    : undefined
  const prepareState = await probePiPackagePrepareState(def, pluginRoot, markerExists)

  const hosted = Boolean(def.hostedSession)
  if (options.forSession && !hosted) {
    throw new PiPackageResolutionError(
      "not-hosted",
      ref,
      `Pi package ${ref} does not support Cognia-hosted sessions (no hostedSession declared).`
    )
  }
  if (options.forSession && !isPiPackageReady(prepareState)) {
    throw new PiPackageResolutionError(
      "not-prepared",
      ref,
      prepareState === "missing"
        ? `Pi package ${ref} is not prepared: run its dependency step from the plugin's page first.`
        : `Pi package ${ref}: could not confirm its dependency step ran (marker ${def.prepare?.marker ?? ""} unreadable).`
    )
  }

  const extensions = (def.hostedSession?.extensions ?? []).map((entry, index) =>
    resolveInside(ref, pluginRoot, entry, `hostedSession.extensions[${index}]`)
  )

  const env: Record<string, string> = {}
  const bindings = def.hostedSession?.env ?? []
  if (bindings.length > 0) {
    const getPluginConfig = options.deps?.getPluginConfig ?? defaultGetPluginConfig
    const config = bindings.some((binding) => "config" in binding.from)
      ? await getPluginConfig(pluginId)
      : {}
    for (const binding of bindings) {
      const key = `${PI_PACKAGE_ENV_PREFIX}${binding.name}`
      const from = binding.from
      if ("value" in from) {
        env[key] = from.value
      } else if ("config" in from) {
        const value = configValueToEnv(config[from.config])
        if (value !== undefined) env[key] = value
      } else if (from.workspace) {
        if (options.cwd) env[key] = options.cwd
        else if (options.forSession) {
          throw new PiPackageResolutionError(
            "workspace-required",
            ref,
            `Pi package ${ref} needs the session's workspace directory (${key}), but the session has none.`
          )
        }
      }
    }
  }

  return {
    ref: contributed.ref,
    pluginId,
    def,
    pluginRoot,
    packageDir,
    markerPath,
    prepareState,
    hosted,
    extensions,
    env,
    tools: [...(def.hostedSession?.tools ?? [])],
    controlsSession: def.hostedSession?.controlsSession === true,
    minPiVersion: def.minPiVersion,
  }
}
