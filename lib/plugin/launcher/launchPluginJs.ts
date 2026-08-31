// ADR-0028 Phase 5 / T2 — re-exec a plugin JS entry under the verified,
// bundled Node 26.3.1+ runtime
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
import { invoke } from "@tauri-apps/api/core"

/**
 * Permission scope inputs the plugin manifest carries. `PluginPermission`
 * is an opaque enum of permission strings (`"filesystem:read"`,
 * `"network:fetch"`, etc.); the manifest also separately carries the
 * concrete path / host lists the renderer-side permission UI consumes.
 *
 * Node 26's permission model gives us scoped filesystem flags, but its
 * network and subprocess switches are all-or-nothing. Those permissions
 * remain host-broker-only.
 */
export interface NodePermissionScope {
  /** Permissions declared on the plugin manifest. */
  permissions: ReadonlyArray<PluginPermission>
  /** Concrete read-allowed paths (absolute). */
  readPaths: ReadonlyArray<string>
  /** Concrete write-allowed paths (absolute). */
  writePaths: ReadonlyArray<string>
  /** Concrete host allowlist requested by the manifest. Never emitted as a broad grant. */
  netHosts: ReadonlyArray<string>
  /** Subprocess names requested by the manifest. Never emitted as a broad grant. */
  allowedSubprocesses: ReadonlyArray<string>
}

export type NodePermissionSupport =
  | { available: true }
  | { available: false; reason: "network-broker-missing" | "subprocess-broker-missing" }

/** Project the native Node host's currently implemented permission boundary. */
export function nodePermissionSupport(permission: PluginPermission): NodePermissionSupport {
  if (
    permission === "network:fetch" ||
    permission === "network:upload" ||
    permission === "network:websocket"
  ) {
    return { available: false, reason: "network-broker-missing" }
  }
  if (permission === "shell:execute" || permission === "process:spawn") {
    return { available: false, reason: "subprocess-broker-missing" }
  }
  return { available: true }
}

export type PluginJsHostInvoker = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export interface HostPluginProcess {
  killed: boolean
  isRunning(): Promise<boolean>
  kill(): Promise<void>
}

export interface LaunchPluginJsOptions {
  pluginId: string
  entryPath: string
  scope: NodePermissionScope
  extraArgs?: ReadonlyArray<string>
  cwd?: string
  hostInvoker?: PluginJsHostInvoker
}

export interface LaunchPluginJsResult {
  command: string
  argv: string[]
  generation: string
  process: HostPluginProcess
  activation: NodePluginActivationSnapshot
  invokeCallback(callbackId: string, args: unknown[]): Promise<unknown>
  deactivate(): Promise<void>
}

export interface NodePluginContextCall {
  path: string
  args: unknown[]
}

export interface NodePluginActivationSnapshot {
  calls: NodePluginContextCall[]
  hooks: unknown
  exports: Record<string, unknown>
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
 * Translate a permission scope into safe `--allow-*` flags for Node 26.3.1+.
 * Returns the argv prefix that callers prepend before the entry path.
 *
 * Node 26.3.1+ `--permission` semantics:
 *   - The flag itself ENABLES the permission model (everything is
 *     denied unless allowed).
 *   - Each filesystem path uses its own `--allow-fs-read=<path>` or
 *     `--allow-fs-write=<path>` flag. Node does not accept CSV path lists.
 *   - `--allow-net` is all-or-nothing and is therefore never emitted.
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
      "Node network grants require a scoped host broker; refusing broad --allow-net access."
    )
  }
  if (allowedSubprocesses.length > 0) {
    throw new Error(
      "Node subprocess grants require a scoped host broker; refusing broad --allow-child-process access."
    )
  }
  if (readPaths.length > 0) {
    args.push(...readPaths.map((path) => `--allow-fs-read=${path}`))
  }
  if (writePaths.length > 0) {
    args.push(...writePaths.map((path) => `--allow-fs-write=${path}`))
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
 * sequence the native plugin host passes to its verified Node child process.
 */
export function buildLaunchArgv(
  entryPath: string,
  scope: NodePermissionScope,
  extraArgs: ReadonlyArray<string> = []
): string[] {
  return [...nodePermissionArgs(scope), entryPath, ...extraArgs]
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
  if (!options.cwd?.trim()) {
    throw new Error(`launchPluginJs: cwd is required for ${options.pluginId}`)
  }
  const argv = buildLaunchArgv(options.entryPath, options.scope, options.extraArgs ?? [])
  if (argv.some((arg) => arg.includes("*"))) {
    throw new Error(`launchPluginJs: wildcard grants are forbidden for ${options.pluginId}`)
  }
  const hostInvoker = options.hostInvoker ?? invoke
  const launched = await hostInvoker<{
    command: string
    argv: string[]
    generation: string
    activation: NodePluginActivationSnapshot
  }>("plugin_launch_js", {
    pluginId: options.pluginId,
    pluginPath: options.cwd,
    entry: options.entryPath,
    extraArgs: options.extraArgs ?? [],
  })
  const process: HostPluginProcess = {
    killed: false,
    async isRunning() {
      if (process.killed) return false
      return hostInvoker<boolean>("plugin_js_status", {
        pluginId: options.pluginId,
        generation: launched.generation,
      })
    },
    async kill() {
      if (process.killed) return
      await hostInvoker<void>("plugin_stop_js", {
        pluginId: options.pluginId,
        generation: launched.generation,
      })
      process.killed = true
    },
  }
  return {
    command: launched.command,
    argv: launched.argv,
    generation: launched.generation,
    process,
    activation: launched.activation,
    invokeCallback(callbackId, args) {
      return hostInvoker("plugin_invoke_js_callback", {
        pluginId: options.pluginId,
        pluginPath: options.cwd,
        entry: options.entryPath,
        callbackId,
        args,
        generation: launched.generation,
      })
    },
    async deactivate() {
      await hostInvoker<void>("plugin_deactivate_js", {
        pluginId: options.pluginId,
        pluginPath: options.cwd,
        entry: options.entryPath,
        generation: launched.generation,
      })
    },
  }
}
