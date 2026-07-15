/**
 * Plugin Updater
 *
 * Handles plugin version management, update checking, and installation.
 *
 * ## Two registries, routed by plugin type
 *
 * `checkForUpdates` used to call `marketplace.getPlugin(id)` for **every**
 * installed plugin with no type filter. VS Code extensions are installed from
 * Open VSX and have ids like `esbenp.prettier-vscode`, so that loop was sending
 * them to the *cognia* registry: an information leak (cognia's registry learned
 * which VS Code extensions a user has, for no reason) that also could never
 * return anything, making "check for updates" silently useless for every
 * extension. Routing is now by `manifest.type`:
 *
 * - `"vscode-extension"` -> Open VSX (`checkOpenVsxUpdates`)
 * - everything else      -> the cognia registry (unchanged)
 *
 * ## Why the Open VSX check is not batched
 *
 * Open VSX has **no batch query on the registry API** — verified live rather
 * than assumed: `GET /api/-/query` and `GET /api/v2/-/query` both reject a
 * second `extensionId` parameter ("must have the format 'namespace.extension'"),
 * and `POST /api/-/query` is deprecated, takes a single `QueryParam`, and 301s
 * back to the GET. A batch form *does* exist at `/vscode/gallery/extensionquery`
 * (Microsoft's gallery protocol, which does accept multiple `filterType: 7`
 * criteria — confirmed working), but adopting it would mean a second response
 * shape, a second set of trust guards, and a dependency on undocumented
 * protocol constants, all to save a handful of requests that the 24h cache
 * mostly serves anyway. So: bounded-concurrency singles, cache first.
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import { getPluginMarketplace } from "../package/marketplace"
import { loggers } from "../core/logger"
import { getPluginBackupManager } from "./backup"
import { getPluginManager } from "../core/manager"
import type { PluginManifest } from "@/types/plugin"
// Type-only: erased at compile time, so the Open VSX modules stay behind the
// dynamic imports in `checkOpenVsxUpdates` and out of the default bundle.
import type { OpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"

// =============================================================================
// Types
// =============================================================================

export interface UpdateInfo {
  pluginId: string
  currentVersion: string
  latestVersion: string
  changelog?: string
  releaseDate?: Date
  downloadSize?: number
  breaking?: boolean
  minAppVersion?: string
}

export interface UpdateResult {
  success: boolean
  pluginId: string
  previousVersion: string
  newVersion: string
  duration: number
  error?: string
  requiresRestart?: boolean
}

export interface UpdateProgress {
  pluginId: string
  stage:
    "checking" | "downloading" | "backing_up" | "installing" | "verifying" | "complete" | "error"
  progress: number
  message: string
  error?: string
}

export interface AutoUpdateConfig {
  enabled: boolean
  checkInterval: number
  autoInstall: boolean
  notifyOnly: boolean
  excludePlugins: string[]
  allowPrerelease: boolean
}

export interface UpdaterConfig {
  autoCheck: boolean
  checkIntervalMs: number
  maxConcurrentUpdates: number
  backupBeforeUpdate: boolean
  verifyAfterUpdate: boolean
}

type ProgressHandler = (progress: UpdateProgress) => void

/**
 * One installed plugin, with everything the routing decision needs.
 *
 * `targetPlatform` is the platform the extension was *installed as*, read back
 * from its manifest. See `resolveOpenVsxLatest` for why re-deriving it from the
 * current machine would be a bug.
 */
interface InstalledPluginRef {
  id: string
  version: string
  /** `manifest.type` — `"vscode-extension"` routes to Open VSX. */
  type?: string
  /** Recorded `manifest.vscodeExtension.targetPlatform`. */
  targetPlatform?: string
}

/**
 * How many Open VSX lookups may be in flight at once.
 *
 * The old loop was serial and unbounded (N+1 round trips, one at a time). Four
 * keeps a 30-extension check fast without becoming the reason a user meets the
 * registry's `x-ratelimit-limit: 10800`.
 */
export const OPEN_VSX_CHECK_CONCURRENCY = 4

/**
 * Run `task` over `items` with at most `limit` concurrent executions,
 * preserving input order in the result.
 *
 * Workers pull from a shared cursor rather than the list being pre-sliced into
 * `limit` chunks: with chunking, one slow lookup stalls its whole chunk while
 * other workers sit idle.
 */
/**
 * Read the routing facts off an installed plugin's manifest.
 *
 * `targetPlatform` comes from the manifest the *adapter* built, never from an
 * extension-supplied field: `manifest-adapter.ts` reconstructs the
 * `vscodeExtension` block from scratch, so an extension cannot self-declare the
 * platform its updates are checked against.
 */
function toInstalledRef(id: string, manifest: PluginManifest): InstalledPluginRef {
  const targetPlatform = manifest.vscodeExtension?.targetPlatform
  return {
    id,
    version: manifest.version,
    ...(manifest.type ? { type: manifest.type } : {}),
    ...(typeof targetPlatform === "string" ? { targetPlatform } : {}),
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// =============================================================================
// Plugin Updater
// =============================================================================

export class PluginUpdater {
  private config: UpdaterConfig
  private autoUpdateConfig: AutoUpdateConfig | null = null
  private progressHandlers: Set<ProgressHandler> = new Set()
  private pendingUpdates: Map<string, UpdateInfo> = new Map()
  private updateHistory: UpdateResult[] = []
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private isChecking = false

  constructor(config: Partial<UpdaterConfig> = {}) {
    this.config = {
      autoCheck: false,
      checkIntervalMs: 3600000, // 1 hour
      maxConcurrentUpdates: 3,
      backupBeforeUpdate: true,
      verifyAfterUpdate: true,
      ...config,
    }
  }

  // ===========================================================================
  // Update Checking
  // ===========================================================================

  async checkForUpdates(pluginIds?: string[]): Promise<UpdateInfo[]> {
    if (this.isChecking) {
      loggers.manager.warn("[Updater] Already checking for updates")
      return []
    }

    this.isChecking = true
    const updates: UpdateInfo[] = []

    try {
      const installedPlugins = pluginIds
        ? await this.getPluginVersions(pluginIds)
        : await this.getAllInstalledPlugins()

      // Partition before any lookup. A VS Code extension id must never reach
      // the cognia registry — see the module doc.
      const vscodeExtensions = installedPlugins.filter((p) => p.type === "vscode-extension")
      const cogniaPlugins = installedPlugins.filter((p) => p.type !== "vscode-extension")

      updates.push(...(await this.checkCogniaUpdates(cogniaPlugins)))
      updates.push(...(await this.checkOpenVsxUpdates(vscodeExtensions)))

      return updates
    } finally {
      this.isChecking = false
    }
  }

  /**
   * Check the cognia registry. Unchanged behaviour, now scoped to plugins that
   * actually come from it.
   */
  private async checkCogniaUpdates(plugins: InstalledPluginRef[]): Promise<UpdateInfo[]> {
    if (plugins.length === 0) return []
    const marketplace = getPluginMarketplace()
    const updates: UpdateInfo[] = []

    for (const { id, version } of plugins) {
      this.emitProgress({
        pluginId: id,
        stage: "checking",
        progress: 0,
        message: `Checking ${id} for updates...`,
      })

      try {
        const latestInfo = await marketplace.getPlugin(id)
        if (latestInfo && this.isNewerVersion(version, latestInfo.latestVersion)) {
          const updateInfo: UpdateInfo = {
            pluginId: id,
            currentVersion: version,
            latestVersion: latestInfo.latestVersion,
            releaseDate: latestInfo.updatedAt,
            breaking: this.isMajorUpdate(version, latestInfo.latestVersion),
          }

          updates.push(updateInfo)
          this.pendingUpdates.set(id, updateInfo)
        }
      } catch (error) {
        loggers.manager.warn(`[Updater] Failed to check ${id}:`, error)
      }
    }

    return updates
  }

  /**
   * Check installed VS Code extensions against Open VSX.
   *
   * Cache first (24h TTL, owned by `openvsx-cache`), then bounded-concurrency
   * single queries for whatever is stale. One extension's failure is logged and
   * skipped rather than failing the whole check — an unreachable registry
   * shouldn't hide the cognia updates that resolved fine.
   */
  private async checkOpenVsxUpdates(extensions: InstalledPluginRef[]): Promise<UpdateInfo[]> {
    if (extensions.length === 0) return []

    // Lazy: the Open VSX client + cache are desktop-install concerns and have
    // no business loading for a user who has never installed an extension.
    const [{ getOpenVsxClient }, cache, { resolveVersion }] = await Promise.all([
      import("@/lib/plugin/vscode-shim/openvsx-client"),
      import("@/lib/plugin/vscode-shim/openvsx-cache"),
      import("@/lib/plugin/vscode-shim/openvsx-version"),
    ])
    const client = getOpenVsxClient()

    const resolved = await mapWithConcurrency(
      extensions,
      OPEN_VSX_CHECK_CONCURRENCY,
      async (ref): Promise<UpdateInfo | null> => {
        this.emitProgress({
          pluginId: ref.id,
          stage: "checking",
          progress: 0,
          message: `Checking ${ref.id} for updates...`,
        })
        try {
          const latestVersion = await this.resolveOpenVsxLatest(ref, {
            client,
            cache,
            resolveVersion,
          })
          if (!latestVersion || !this.isNewerVersion(ref.version, latestVersion)) return null

          const updateInfo: UpdateInfo = {
            pluginId: ref.id,
            currentVersion: ref.version,
            latestVersion,
            breaking: this.isMajorUpdate(ref.version, latestVersion),
          }
          this.pendingUpdates.set(ref.id, updateInfo)
          return updateInfo
        } catch (error) {
          loggers.manager.warn(`[Updater] Failed to check ${ref.id} against Open VSX:`, error)
          return null
        }
      }
    )

    return resolved.filter((u): u is UpdateInfo => u !== null)
  }

  /**
   * Newest **stable** version of one extension, or `null` if the registry has
   * nothing installable.
   *
   * Two things this deliberately does not do:
   *
   * 1. **Re-derive the platform from this machine.** The query uses the
   *    `targetPlatform` recorded at install. An extension installed via the
   *    `universal` fallback must keep being checked as `universal`; asking for
   *    the host platform instead would surface a platform-specific build as an
   *    "update" and swap a working install for one that dies at spawn.
   * 2. **Trust `versionAlias: ["latest"]`.** Open VSX's `latest` means newest
   *    *published*, and rust-analyzer's `latest` is literally a pre-release.
   *    Selection goes through `resolveVersion`, which reads the `preRelease`
   *    boolean and never the alias, so the check never nags a user to "update"
   *    onto a pre-release they didn't opt into.
   */
  private async resolveOpenVsxLatest(
    ref: InstalledPluginRef,
    deps: {
      client: Pick<OpenVsxClient, "queryExtension">
      cache: typeof import("@/lib/plugin/vscode-shim/openvsx-cache")
      resolveVersion: typeof import("@/lib/plugin/vscode-shim/openvsx-version").resolveVersion
    }
  ): Promise<string | null> {
    // `getCached` returns undefined for a row past its 24h TTL, so a stale
    // entry falls through to a real query without any check here.
    const cached = await deps.cache.getCached(ref.id)
    if (cached) return cached.latestVersion

    const response = await deps.client.queryExtension({
      extensionId: ref.id,
      ...(ref.targetPlatform ? { targetPlatform: ref.targetPlatform } : {}),
      includeAllVersions: true,
    })
    if (response.extensions.length === 0) return null

    const chosen = deps.resolveVersion(response.extensions, { allowPrerelease: false })
    // The row records the resolved **stable** entry, which is what makes the
    // cache safe for the next check to read straight back out of.
    await deps.cache.putCached([deps.cache.cacheRowFromQueryEntry(chosen)])
    return chosen.version
  }

  async checkPluginUpdate(pluginId: string): Promise<UpdateInfo | null> {
    const updates = await this.checkForUpdates([pluginId])
    return updates.find((u) => u.pluginId === pluginId) || null
  }

  getPendingUpdates(): UpdateInfo[] {
    return Array.from(this.pendingUpdates.values())
  }

  clearPendingUpdate(pluginId: string): void {
    this.pendingUpdates.delete(pluginId)
  }

  // ===========================================================================
  // Update Installation
  // ===========================================================================

  async update(
    pluginId: string,
    options: {
      version?: string
      backup?: boolean
      force?: boolean
    } = {}
  ): Promise<UpdateResult> {
    const startTime = Date.now()
    const marketplace = getPluginMarketplace()
    const updateInfo = this.pendingUpdates.get(pluginId)

    // A VS Code extension cannot be updated headlessly. Not a stub — a
    // refusal, and the correct one: a new version can request new permissions,
    // and `update()` has no consent callbacks to surface them with. Applying it
    // silently (which `runAutoUpdate`'s `autoInstall` would do) means the user
    // consented to v1's permissions and gets v2's. The marketplace UI drives
    // the same install through `runMarketplaceInstall`, where consent exists.
    //
    // The alternative — falling through — would query the cognia registry for
    // an Open VSX id and fail with "Version X is not available in marketplace",
    // which tells the user nothing about what actually happened.
    if (this.isVscodeExtension(pluginId)) {
      return {
        success: false,
        pluginId,
        previousVersion: updateInfo?.currentVersion ?? this.getPluginVersion(pluginId) ?? "",
        newVersion: options.version || updateInfo?.latestVersion || "",
        duration: Date.now() - startTime,
        error:
          `${pluginId} is a VS Code extension. Update it from the marketplace's VS Code section — ` +
          `a new version may request new permissions, which have to be reviewed before it is installed.`,
      }
    }

    if (!updateInfo && !options.force) {
      return {
        success: false,
        pluginId,
        previousVersion: "",
        newVersion: options.version || "",
        duration: 0,
        error: "No pending update found",
      }
    }

    const currentVersion = updateInfo?.currentVersion || this.getPluginVersion(pluginId) || ""
    let targetVersion = options.version || updateInfo?.latestVersion || ""
    if (!targetVersion) {
      const latest = await marketplace.getPlugin(pluginId)
      targetVersion = latest?.latestVersion || ""
    }

    try {
      if (!targetVersion) {
        throw new Error(`No target version available for plugin ${pluginId}`)
      }

      // Step 1: Backup if configured
      if (options.backup ?? this.config.backupBeforeUpdate) {
        this.emitProgress({
          pluginId,
          stage: "backing_up",
          progress: 10,
          message: "Creating backup...",
        })

        const backupResult = await getPluginBackupManager().createBackup(pluginId, {
          reason: "pre-update",
          metadata: { targetVersion },
        })
        if (!backupResult.success) {
          throw new Error(backupResult.error || "Backup creation failed")
        }
      }

      // Step 2: Download new version
      this.emitProgress({
        pluginId,
        stage: "downloading",
        progress: 30,
        message: `Downloading version ${targetVersion}...`,
      })

      const availableVersions = await marketplace.getVersions(pluginId)
      const matchedVersion = availableVersions.find((version) => version.version === targetVersion)
      if (!matchedVersion) {
        throw new Error(`Version ${targetVersion} is not available in marketplace`)
      }

      // Step 3: Install
      this.emitProgress({
        pluginId,
        stage: "installing",
        progress: 60,
        message: "Installing update...",
      })

      const installResult = await marketplace.installPlugin(pluginId, matchedVersion.version)
      if (!installResult.success) {
        throw new Error(installResult.error || "Plugin installation failed")
      }

      this.projectPluginVersion(pluginId, matchedVersion.version)
      await this.refreshRuntimePlugins()

      // Step 4: Verify
      if (this.config.verifyAfterUpdate) {
        this.emitProgress({
          pluginId,
          stage: "verifying",
          progress: 90,
          message: "Verifying installation...",
        })

        const verified = await this.verifyInstallation(pluginId, targetVersion)
        if (!verified) {
          throw new Error("Update verification failed")
        }
      }

      // Complete
      this.emitProgress({
        pluginId,
        stage: "complete",
        progress: 100,
        message: "Update complete!",
      })

      this.pendingUpdates.delete(pluginId)

      const result: UpdateResult = {
        success: true,
        pluginId,
        previousVersion: currentVersion,
        newVersion: targetVersion,
        duration: Date.now() - startTime,
        requiresRestart: await this.requiresRestart(),
      }

      this.updateHistory.push(result)
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      this.emitProgress({
        pluginId,
        stage: "error",
        progress: 0,
        message: "Update failed",
        error: errorMessage,
      })

      const result: UpdateResult = {
        success: false,
        pluginId,
        previousVersion: currentVersion,
        newVersion: targetVersion,
        duration: Date.now() - startTime,
        error: errorMessage,
      }

      this.updateHistory.push(result)
      return result
    }
  }

  /**
   * Install a specific version of a plugin. Thin, explicitly-versioned wrapper
   * over {@link update} — this is the method the update dialog and the batch
   * actions bar call. `force` lets it install the requested version even when
   * no pending-update record was seeded first (e.g. a direct batch install).
   */
  async installUpdate(pluginId: string, version: string): Promise<UpdateResult> {
    return this.update(pluginId, { version, force: true })
  }

  /**
   * Drop the pending-update record for a plugin. The updater applies updates
   * atomically (no partial in-flight state to unwind), so cancellation just
   * clears the queued marker so the surfaces stop offering it.
   */
  cancelUpdate(pluginId: string): void {
    this.clearPendingUpdate(pluginId)
  }

  async updateAll(options: { skipBreaking?: boolean } = {}): Promise<UpdateResult[]> {
    const results: UpdateResult[] = []
    const pending = Array.from(this.pendingUpdates.values())

    for (const update of pending) {
      if (options.skipBreaking && update.breaking) {
        loggers.manager.info(`[Updater] Skipping breaking update for ${update.pluginId}`)
        continue
      }

      const result = await this.update(update.pluginId)
      results.push(result)
    }

    return results
  }

  private async verifyInstallation(pluginId: string, expectedVersion: string): Promise<boolean> {
    return this.getPluginVersion(pluginId) === expectedVersion
  }

  private async requiresRestart(): Promise<boolean> {
    return false
  }

  // ===========================================================================
  // Auto Update
  // ===========================================================================

  configureAutoUpdate(config: AutoUpdateConfig): void {
    this.autoUpdateConfig = config

    // Clear existing interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    // Set up new interval if enabled
    if (config.enabled) {
      this.checkInterval = setInterval(() => {
        this.runAutoUpdate()
      }, config.checkInterval)
    }
  }

  private async runAutoUpdate(): Promise<void> {
    if (!this.autoUpdateConfig) return

    const updates = await this.checkForUpdates()
    const filteredUpdates = updates.filter(
      (u) => !this.autoUpdateConfig!.excludePlugins.includes(u.pluginId)
    )

    if (filteredUpdates.length === 0) return

    if (this.autoUpdateConfig.notifyOnly) {
      // Emit notification event
      window.dispatchEvent(
        new CustomEvent("plugin:updates-available", {
          detail: { updates: filteredUpdates },
        })
      )
      return
    }

    if (this.autoUpdateConfig.autoInstall) {
      for (const update of filteredUpdates) {
        if (!update.breaking) {
          await this.update(update.pluginId)
        }
      }
    }
  }

  stopAutoUpdate(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    this.autoUpdateConfig = null
  }

  // ===========================================================================
  // Progress Handling
  // ===========================================================================

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.add(handler)
    return () => this.progressHandlers.delete(handler)
  }

  private emitProgress(progress: UpdateProgress): void {
    for (const handler of this.progressHandlers) {
      try {
        handler(progress)
      } catch (error) {
        loggers.manager.error("[Updater] Progress handler error:", error)
      }
    }
  }

  // ===========================================================================
  // Version Utilities
  // ===========================================================================

  private isNewerVersion(current: string, latest: string): boolean {
    const currentParts = current.split(".").map((p) => parseInt(p) || 0)
    const latestParts = latest.split(".").map((p) => parseInt(p) || 0)

    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
      const c = currentParts[i] || 0
      const l = latestParts[i] || 0
      if (l > c) return true
      if (l < c) return false
    }

    return false
  }

  private isMajorUpdate(current: string, latest: string): boolean {
    const currentMajor = parseInt(current.split(".")[0]) || 0
    const latestMajor = parseInt(latest.split(".")[0]) || 0
    return latestMajor > currentMajor
  }

  private async getPluginVersions(pluginIds: string[]): Promise<InstalledPluginRef[]> {
    const result: InstalledPluginRef[] = []
    const plugins = usePluginStore.getState().plugins

    for (const id of pluginIds) {
      const plugin = plugins[id]
      if (plugin?.manifest.version) {
        result.push(toInstalledRef(id, plugin.manifest))
      }
    }

    return result
  }

  private async getAllInstalledPlugins(): Promise<InstalledPluginRef[]> {
    const installedStatuses = new Set([
      "installed",
      "loading",
      "loaded",
      "enabling",
      "enabled",
      "disabling",
      "disabled",
      "unloading",
      "updating",
      "error",
    ])

    return Object.values(usePluginStore.getState().plugins)
      .filter((plugin) => installedStatuses.has(plugin.status))
      .map((plugin) => toInstalledRef(plugin.manifest.id, plugin.manifest))
  }

  private getPluginVersion(pluginId: string): string | null {
    const plugin = usePluginStore.getState().plugins[pluginId]
    return plugin?.manifest.version || null
  }

  /** Whether the installed plugin is a VS Code extension (Open VSX-sourced). */
  private isVscodeExtension(pluginId: string): boolean {
    return usePluginStore.getState().plugins[pluginId]?.manifest.type === "vscode-extension"
  }

  private async refreshRuntimePlugins(): Promise<void> {
    try {
      await getPluginManager().scanPlugins()
      await getPluginManager().syncRuntimeState()
    } catch (error) {
      loggers.manager.debug("[Updater] Runtime refresh skipped:", error)
    }
  }

  private projectPluginVersion(pluginId: string, version: string): void {
    usePluginStore.setState((state) => {
      const current = state.plugins[pluginId]
      if (!current) return state
      return {
        plugins: {
          ...state.plugins,
          [pluginId]: {
            ...current,
            manifest: {
              ...current.manifest,
              version,
            },
          },
        },
      }
    })
  }

  // ===========================================================================
  // History
  // ===========================================================================

  getUpdateHistory(pluginId?: string): UpdateResult[] {
    if (pluginId) {
      return this.updateHistory.filter((r) => r.pluginId === pluginId)
    }
    return [...this.updateHistory]
  }

  clearHistory(): void {
    this.updateHistory = []
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  dispose(): void {
    this.stopAutoUpdate()
    this.progressHandlers.clear()
    this.pendingUpdates.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let updaterInstance: PluginUpdater | null = null

export function getPluginUpdater(config?: Partial<UpdaterConfig>): PluginUpdater {
  if (!updaterInstance) {
    updaterInstance = new PluginUpdater(config)
  }
  return updaterInstance
}

export function resetPluginUpdater(): void {
  if (updaterInstance) {
    updaterInstance.dispose()
    updaterInstance = null
  }
}
