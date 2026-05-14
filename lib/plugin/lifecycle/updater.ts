/**
 * Plugin Updater
 *
 * Handles plugin version management, update checking, and installation.
 */

import { usePluginStore } from "@/stores/plugin"
import { getPluginMarketplace } from "../package/marketplace"
import { loggers } from "../core/logger"
import { getPluginBackupManager } from "./backup"
import { getPluginManager } from "../core/manager"

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
    | "checking"
    | "downloading"
    | "backing_up"
    | "installing"
    | "verifying"
    | "complete"
    | "error"
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
      const marketplace = getPluginMarketplace()

      // Get installed plugins
      const installedPlugins = pluginIds
        ? await this.getPluginVersions(pluginIds)
        : await this.getAllInstalledPlugins()

      // Check each plugin for updates
      for (const { id, version } of installedPlugins) {
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
    } finally {
      this.isChecking = false
    }
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

  private async getPluginVersions(
    pluginIds: string[]
  ): Promise<Array<{ id: string; version: string }>> {
    const result: Array<{ id: string; version: string }> = []
    const plugins = usePluginStore.getState().plugins

    for (const id of pluginIds) {
      const plugin = plugins[id]
      if (plugin?.manifest.version) {
        result.push({ id, version: plugin.manifest.version })
      }
    }

    return result
  }

  private async getAllInstalledPlugins(): Promise<Array<{ id: string; version: string }>> {
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
      .map((plugin) => ({
        id: plugin.manifest.id,
        version: plugin.manifest.version,
      }))
  }

  private getPluginVersion(pluginId: string): string | null {
    const plugin = usePluginStore.getState().plugins[pluginId]
    return plugin?.manifest.version || null
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
