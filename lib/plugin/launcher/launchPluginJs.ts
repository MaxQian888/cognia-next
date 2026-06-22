// ADR-0028 Phase 5 / T2 — re-exec a plugin JS entry under Node 24
// `--permission` so the entry's filesystem / network / child-process
// surface is bounded by the manifest's declared `PluginPermission[]`.
//
// Composes with T1: even if a plugin spawns `bash`, the SDK builtin Bash
// is disabled in sandbox-enabled sessions (build-options adds it to
// `disallowedTools`) and the model routes through our `sandbox_*` tools
// instead.
//
// The loader builds a Node-target plugin definition from this helper;
// the manager reaches it through the normal load/activate lifecycle and
// kills the spawned process through the definition's deactivate hook.

import type { PluginPermission } from "@/types/plugin"
import type { ChildProcess, SpawnOptions } from "node:child_process"

/**
 * Permission scope inputs the plugin manifest carries. `PluginPermission`
 * is an opaque enum of permission strings (`"filesystem:read"`,
 * `"network:fetch"`, etc.); the manifest also separately carries the
 * concrete path / host lists the renderer-side permission UI consumes.
 *
 * Node 24's permission model only gives us scoped filesystem flags here.
 * Network host grants and subprocess allowlists must go through host
 * brokers until the bundled runtime supports scoped equivalents.
 */
export interface NodePermissionScope {
  /** Permissions declared on the plugin manifest. */
  permissions: ReadonlyArray<PluginPermission>
  /** Concrete read-allowed paths (absolute). */
  readPaths: ReadonlyArray<string>
  /** Concrete write-allowed paths (absolute). */
  writePaths: ReadonlyArray<string>
  /** Concrete host allowlist requested by the manifest. Not emitted under Node 24. */
  netHosts: ReadonlyArray<string>
  /** Subprocess names requested by the manifest. Not emitted under Node 24. */
  allowedSubprocesses: ReadonlyArray<string>
}

export type NodeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface LaunchPluginJsOptions {
  pluginId: string
  entryPath: string
  scope: NodePermissionScope
  extraArgs?: ReadonlyArray<string>
  cwd?: string
  env?: NodeJS.ProcessEnv
  nodePath?: string
  spawn?: NodeSpawn
}

export interface LaunchPluginJsResult {
  command: string
  argv: string[]
  process: ChildProcess
}

function cleanAllowValues(values: ReadonlyArray<string>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && !value.includes("*"))
    )
  )
}

/**
 * Translate a permission scope into the `--allow-*` flags for Node 24.
 * Returns the argv prefix that callers prepend before the entry path.
 *
 * Node 24 `--permission` semantics:
 *   - The flag itself ENABLES the permission model (everything is
 *     denied unless allowed).
 *   - `--allow-fs-read=<csv>` / `--allow-fs-write=<csv>` accept
 *     comma-separated absolute paths or `*` for "all".
 *   - There is no scoped `--allow-net=<hosts>` flag in Node 24.
 *   - `--allow-child-process` is all-or-nothing, so it is not used for
 *     manifest subprocess allowlists.
 *
 * Empty lists translate to OMITTED flags, NOT to `*`. The fail-safe is
 * a deny.
 *
 * Pure: no I/O.
 */
export function nodePermissionArgs(scope: NodePermissionScope): string[] {
  const args: string[] = ["--permission"]
  const readPaths = cleanAllowValues(scope.readPaths)
  const writePaths = cleanAllowValues(scope.writePaths)
  const netHosts = cleanAllowValues(scope.netHosts)
  const allowedSubprocesses = cleanAllowValues(scope.allowedSubprocesses)
  if (netHosts.length > 0) {
    throw new Error(
      "Node 24 network grants require a host broker; refusing to emit unsupported --allow-net flags."
    )
  }
  if (allowedSubprocesses.length > 0) {
    throw new Error(
      "Node 24 subprocess grants require a host broker; refusing broad --allow-child-process access."
    )
  }
  if (readPaths.length > 0) {
    args.push(`--allow-fs-read=${readPaths.join(",")}`)
  }
  if (writePaths.length > 0) {
    args.push(`--allow-fs-write=${writePaths.join(",")}`)
  }
  return args
}

/**
 * Convert the manifest's coarse `PluginPermission[]` into the concrete
 * scope fields when the renderer-side permission grant didn't already
 * supply a precise list. Conservative: when a permission category is
 * declared but no specific paths are known, return an empty list so the
 * Node flag is OMITTED entirely. This is intentionally restrictive —
 * the manifest must surface its concrete paths somewhere (e.g.
 * `manifest.fileScope`) for those paths to land in the flag.
 */
export function deriveScopeFromManifest(
  permissions: ReadonlyArray<PluginPermission>,
  concrete: {
    readPaths?: string[]
    writePaths?: string[]
    netHosts?: string[]
    subprocesses?: string[]
  }
): NodePermissionScope {
  return {
    permissions,
    readPaths: concrete.readPaths ?? [],
    writePaths: concrete.writePaths ?? [],
    netHosts: concrete.netHosts ?? [],
    allowedSubprocesses: concrete.subprocesses ?? [],
  }
}

/**
 * Build the full argv to re-exec a plugin JS file. Result is the
 * sequence `launchPluginJs` passes to `child_process.spawn("node", argv)`.
 */
export function buildLaunchArgv(
  entryPath: string,
  scope: NodePermissionScope,
  extraArgs: ReadonlyArray<string> = []
): string[] {
  return [...nodePermissionArgs(scope), entryPath, ...extraArgs]
}

function resolveNode24Path(explicitPath?: string): string {
  if (explicitPath?.trim()) return explicitPath
  const envPath =
    typeof process !== "undefined"
      ? process.env.COGNIA_NODE24_PATH || process.env.NODE24_PATH
      : undefined
  if (envPath?.trim()) return envPath
  const version = typeof process !== "undefined" ? process.versions?.node : undefined
  const major = version ? Number.parseInt(version.split(".")[0] ?? "", 10) : Number.NaN
  if (Number.isFinite(major) && major >= 24 && process.execPath) {
    return process.execPath
  }
  throw new Error(
    "Node 24 executable is required for plugin isolation; set COGNIA_NODE24_PATH to a Node 24 binary."
  )
}

async function defaultSpawn(): Promise<NodeSpawn> {
  const importer = Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<typeof import("node:child_process")>
  const mod = await importer("node:child_process")
  return mod.spawn
}

export async function launchPluginJs(
  options: LaunchPluginJsOptions
): Promise<LaunchPluginJsResult> {
  if (!options.pluginId.trim()) {
    throw new Error("launchPluginJs: pluginId is required")
  }
  if (!options.entryPath.trim()) {
    throw new Error(`launchPluginJs: entryPath is required for ${options.pluginId}`)
  }
  const command = resolveNode24Path(options.nodePath)
  const argv = buildLaunchArgv(options.entryPath, options.scope, options.extraArgs ?? [])
  if (argv.some((arg) => arg.includes("*"))) {
    throw new Error(`launchPluginJs: wildcard grants are forbidden for ${options.pluginId}`)
  }
  const spawn = options.spawn ?? (await defaultSpawn())
  const child = spawn(command, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  return { command, argv, process: child }
}
