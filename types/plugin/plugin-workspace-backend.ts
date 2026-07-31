/**
 * Type contracts for plugin-contributed workspace backends.
 *
 * A "workspace backend" is the execution sandbox the GitHub-delivery
 * issue-loop and similar agentic flows clone repos / run commands inside.
 * Today there are two built-ins — local git checkout (Tauri Rust commands)
 * and the e2b-firecracker sandbox (contributed by `plugins/e2b-sandbox/`).
 * The legacy wiring uses `lib/github/workspace.ts:setE2BBackend` as a
 * global singleton setter; this type set is the declarative replacement
 * that plugins should target instead.
 *
 * Two registration paths, mirroring `plugin-ocr.ts`:
 * - **Manifest** `manifest.workspaceBackends[]` — lazy factory.
 * - **Imperative** `ctx.workspace.registerBackend(backend)` in `activate()`.
 *
 * Both flow through `lib/github/workspace-backend-registry.ts`. The legacy
 * `setE2BBackend` becomes a `@deprecated` shim that delegates to the
 * registry, so existing first-party plugins keep working.
 *
 * Permission gate: `process:spawn` + `filesystem:write`. See ADR-0026.
 *
 * NOTE — the runtime shape of a backend (`clone / commitAndPush / remove`)
 * is identical to the existing `E2BBackend` interface in
 * `lib/github/workspace.ts`. We re-export it as `WorkspaceProvider` here
 * so plugin authors get a type name that doesn't collide with the
 * pre-existing `WorkspaceBackend = "local" | "e2b"` string union.
 */

import type { E2BBackend } from "@/lib/github/workspace"
import type { PluginContributionBackend } from "@/types/plugin/plugin"

/**
 * Runtime shape every plugin-contributed workspace backend implements.
 * Re-export of the existing `E2BBackend` interface — renamed for clarity
 * because `WorkspaceBackend` is a string-union type in the same module.
 */
export type WorkspaceProvider = E2BBackend

/**
 * One backend contribution in `manifest.workspaceBackends[]`. Lazy factory
 * shape — `entry` is dynamic-imported only when the registry first needs
 * the backend.
 */
export interface PluginWorkspaceBackendDef {
  /**
   * Backend id, unprefixed. The registry prefixes with the plugin id at
   * registration time (`<pluginId>:<id>`) so two plugins cannot collide.
   * Legacy `setE2BBackend` registers under id `"e2b"` (unprefixed) for
   * back-compat.
   */
  id: string
  /** Human label for picker UI. */
  label: string
  /**
   * Which runtime owns this backend's factory. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  /** Relative path inside the plugin install root. Required for JS backends. */
  entry?: string
  /** Named export resolving to `PluginWorkspaceBackendFactory`. JS only. */
  export?: string
  /** Short description shown in the workspace picker. */
  description?: string
}

export type PluginWorkspaceBackendFactory = (
  ctx: PluginWorkspaceBackendFactoryContext
) => WorkspaceProvider | Promise<WorkspaceProvider>

export interface PluginWorkspaceBackendFactoryContext {
  backendId: string
  pluginId: string
  getConfig<T = unknown>(key: string): T | undefined
  getSecret(key: string): Promise<string | undefined>
}

export interface PluginWorkspaceBackendRegistration {
  backendId: string
  unregister(): void
}
