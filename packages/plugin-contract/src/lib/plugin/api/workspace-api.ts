/**
 * The plugin contract's share of `lib/plugin/api/workspace-api.ts`, which re-exports these.
 */
import type { BotWorkspacePublishInput, BotWorkspaceSnapshot } from "../workspace/bot-run"
import type { E2BBackend } from "../../github/workspace"
import type { PluginWorkspaceBackendRegistration } from "../../../types/plugin/plugin-workspace-backend"
import type { PluginWorkspaceHandle, WorkspaceAcquireSpec } from "../workspace/acquire"
import type { WorkspaceWalkOptions, WorkspaceWalkResult } from "../../files/workspace-fs"

export interface PluginWorkspaceAPI {
  /** Absolute primary root of the active project, when one is open. */
  getActiveRoot(): string | undefined
  /**
   * Register a workspace backend. The given id is prefixed with the plugin
   * id to avoid collisions across plugins. Throws if the same plugin tries
   * to register two backends with the same unprefixed id.
   *
   * The optional `label` / `description` show up in the workspace picker
   * UI (when one ships — the registry already tracks these fields).
   */
  registerBackend(args: {
    id: string
    label: string
    description?: string
    backend: E2BBackend
  }): PluginWorkspaceBackendRegistration
  /**
   * Resolve a backend this plugin registered, by its unprefixed id. The
   * lookup auto-applies the `<pluginId>:` namespace, so a plugin that called
   * `registerBackend({ id: "sandbox" })` reads it back with
   * `getBackend("sandbox")`. Without this, plugin-contributed backends were
   * registered under the prefixed id but the host only ever resolved the
   * legacy unprefixed `"e2b"`, leaving them unreachable. Returns `undefined`
   * when the plugin never registered that id.
   */
  getBackend(id: string): E2BBackend | undefined
  /** Snapshot of backend ids this plugin has registered. */
  listRegistered(): string[]

  /**
   * Obtain a checkout to read.
   *
   * A remote is cloned into this plugin's own data directory under guard rails
   * (https only, host allow-list, timed, size bounded). Remote acquisition
   * requires declared `git:write`, a live grant, and host-scoped user consent.
   * Enterprise hosts must be declared in `manifest.workspaceCloneHosts` and
   * are freshly cloned without ambient credentials. Bot runs use their bound
   * integration account's host and credentials instead. A local path
   * must be inside a workspace the user has already opened — a plugin naming
   * an arbitrary directory is the filesystem escape the rest of the plugin API
   * is built to prevent.
   */
  acquire(spec: WorkspaceAcquireSpec): Promise<PluginWorkspaceHandle>
  snapshot(handle: PluginWorkspaceHandle): Promise<BotWorkspaceSnapshot>
  publish(
    handle: PluginWorkspaceHandle,
    input: BotWorkspacePublishInput
  ): Promise<{ branch: string; headSha: string }>
  /**
   * Enumerate the checkout's files, honouring `.gitignore`.
   *
   * Check `truncated` before treating the result as complete, and
   * `skippedSensitive` to know the host withheld credential files.
   */
  walk(handle: PluginWorkspaceHandle, options?: WorkspaceWalkOptions): Promise<WorkspaceWalkResult>
  /** Read one file; pass `ref` to read it at a revision instead of on disk. */
  read(
    handle: PluginWorkspaceHandle,
    relPath: string,
    options?: { maxBytes?: number; ref?: string }
  ): Promise<string | null>
  /** Repo-relative paths that differ between `ref` and the current revision. */
  changedSince(handle: PluginWorkspaceHandle, ref: string): Promise<string[]>
  /**
   * Discard a handle. Deletes the checkout only when this plugin cloned it;
   * a handle onto the user's own project is left alone. Resolves `false` when
   * there was nothing to delete, so releasing twice is not an error.
   */
  release(handle: PluginWorkspaceHandle): Promise<boolean>
}
