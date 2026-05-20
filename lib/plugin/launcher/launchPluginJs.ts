// ADR-0028 Phase 5 / T2 — re-exec a plugin JS entry under Node 24
// `--permission` so the entry's filesystem / network / child-process
// surface is bounded by the manifest's declared `PluginPermission[]`.
//
// Composes with T1: even if a plugin spawns `bash`, the SDK builtin Bash
// is disabled in sandbox-enabled sessions (build-options adds it to
// `disallowedTools`) and the model routes through our `sandbox_*` tools
// instead.
//
// V1 ships the policy translator + re-exec helper; the host plugin
// manager picks this up when activating Node-target plugins (separate
// commit in the plugin-system refactor — beyond the ADR-0028 V1 scope).
// Until then this module is consumed only by its tests; it ships so the
// surface is locked in and reviewable.

import type { PluginPermission } from "@/types/plugin"

/**
 * Permission scope inputs the plugin manifest carries. `PluginPermission`
 * is an opaque enum of permission strings (`"filesystem:read"`,
 * `"network:fetch"`, etc.); the manifest also separately carries the
 * concrete path / host lists the renderer-side permission UI consumes —
 * we re-shape both into Node `--allow-*` flag values here.
 */
export interface NodePermissionScope {
  /** Permissions declared on the plugin manifest. */
  permissions: ReadonlyArray<PluginPermission>
  /** Concrete read-allowed paths (absolute). */
  readPaths: ReadonlyArray<string>
  /** Concrete write-allowed paths (absolute). */
  writePaths: ReadonlyArray<string>
  /** Concrete host allowlist for `--allow-net=`. */
  netHosts: ReadonlyArray<string>
  /** Subprocess names the plugin may spawn (e.g. `["git", "curl"]`). */
  allowedSubprocesses: ReadonlyArray<string>
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
 *   - `--allow-net=<csv>` accepts hosts. `*` for "all".
 *   - `--allow-child-process=<csv>` accepts subprocess names.
 *
 * Empty lists translate to OMITTED flags, NOT to `*`. The fail-safe is
 * a deny.
 *
 * Pure: no I/O.
 */
export function nodePermissionArgs(scope: NodePermissionScope): string[] {
  const args: string[] = ["--permission"]
  if (scope.readPaths.length > 0) {
    args.push(`--allow-fs-read=${scope.readPaths.join(",")}`)
  }
  if (scope.writePaths.length > 0) {
    args.push(`--allow-fs-write=${scope.writePaths.join(",")}`)
  }
  if (scope.netHosts.length > 0) {
    args.push(`--allow-net=${scope.netHosts.join(",")}`)
  }
  if (scope.allowedSubprocesses.length > 0) {
    args.push(`--allow-child-process=${scope.allowedSubprocesses.join(",")}`)
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
 * sequence callers would pass to `child_process.spawn("node", argv)`.
 *
 * The plugin manager OWNS the actual spawn (it tracks pids for
 * deactivate-on-disable, attaches stdio handlers, etc.); this helper is
 * the pure flag-construction half.
 */
export function buildLaunchArgv(
  entryPath: string,
  scope: NodePermissionScope,
  extraArgs: ReadonlyArray<string> = []
): string[] {
  return [...nodePermissionArgs(scope), entryPath, ...extraArgs]
}
