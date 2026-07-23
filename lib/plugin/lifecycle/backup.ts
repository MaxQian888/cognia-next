/**
 * Plugin Backup System
 *
 * Handles plugin state backup, restore, and migration.
 */

import { invoke } from "@tauri-apps/api/core"
import { loggers } from "../core/logger"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { usePluginStore } from "@/stores/plugin-runtime"

// =============================================================================
// Types
// =============================================================================

export interface PluginBackup {
  id: string
  pluginId: string
  version: string
  createdAt: Date
  reason: BackupReason
  size: number
  path: string
  metadata?: Record<string, unknown>
}

export type BackupReason =
  "manual" | "pre-update" | "pre-uninstall" | "scheduled" | "migration" | "auto"

export interface BackupConfig {
  maxBackupsPerPlugin: number
  autoBackupEnabled: boolean
  autoBackupIntervalMs: number
  includeConfig: boolean
  includeData: boolean
  compressBackups: boolean
  backupPath: string
}

export interface BackupResult {
  success: boolean
  backup?: PluginBackup
  error?: string
  duration: number
}

export interface RestoreResult {
  success: boolean
  pluginId: string
  restoredVersion: string
  error?: string
  duration: number
  requiresRestart: boolean
}

export interface BackupContents {
  manifest: Record<string, unknown>
  config: Record<string, unknown>
  data?: Record<string, unknown>
  files: string[]
}

// =============================================================================
// Plugin Backup Manager
// =============================================================================

export class PluginBackupManager {
  private config: BackupConfig
  private backups: Map<string, PluginBackup[]> = new Map()
  private autoBackupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<BackupConfig> = {}) {
    this.config = {
      maxBackupsPerPlugin: 5,
      autoBackupEnabled: false,
      autoBackupIntervalMs: 86400000, // 24 hours
      includeConfig: true,
      includeData: true,
      compressBackups: true,
      backupPath: "~/.cognia/backups/plugins",
      ...config,
    }
  }

  private getIndexStorageKey(): string {
    return `plugin:backup:index:${this.config.backupPath}`
  }

  private readIndexFromStorage(): Record<string, PluginBackup[]> | null {
    try {
      if (typeof localStorage === "undefined") {
        return null
      }
      const raw = localStorage.getItem(this.getIndexStorageKey())
      return raw ? (JSON.parse(raw) as Record<string, PluginBackup[]>) : null
    } catch {
      return null
    }
  }

  private writeIndexToStorage(index: Record<string, PluginBackup[]>): void {
    try {
      if (typeof localStorage === "undefined") {
        return
      }
      localStorage.setItem(this.getIndexStorageKey(), JSON.stringify(index))
    } catch (error) {
      recordSilentFailure(
        "<backup-index>",
        {
          site: "backup.writeIndexToStorage",
          message: "Plugin backup index persistence skipped (storage unavailable).",
          expected: false,
        },
        error
      )
    }
  }

  private getPluginRuntime(pluginId: string) {
    return usePluginStore.getState().plugins[pluginId]
  }

  private async calculatePathSize(path: string): Promise<number> {
    try {
      const { stat, readDir } = await import("@tauri-apps/plugin-fs")

      const walk = async (target: string): Promise<number> => {
        const info = await stat(target)
        if (!info.isDirectory) {
          return info.size
        }

        let total = 0
        const entries = await readDir(target)
        for (const entry of entries) {
          if (!entry.name) continue
          total += await walk(`${target}/${entry.name}`)
        }
        return total
      }

      return await walk(path)
    } catch {
      return 0
    }
  }

  private async inspectBackup(backupPath: string): Promise<BackupContents | null> {
    try {
      const { stat, readDir, readTextFile } = await import("@tauri-apps/plugin-fs")
      const files: string[] = []

      const walk = async (target: string): Promise<void> => {
        const info = await stat(target)
        if (!info.isDirectory) {
          files.push(target)
          return
        }
        const entries = await readDir(target)
        for (const entry of entries) {
          if (!entry.name) continue
          await walk(`${target}/${entry.name}`)
        }
      }

      await walk(backupPath)

      let manifest: Record<string, unknown> = {}
      const manifestPath = `${backupPath}/plugin.json`
      try {
        const raw = await readTextFile(manifestPath)
        manifest = JSON.parse(raw) as Record<string, unknown>
      } catch (error) {
        recordSilentFailure(
          "<backup-inspect>",
          {
            site: "backup.inspectBackup.readManifest",
            message: "Backup directory has no readable plugin.json (older backups are normal).",
            expected: true,
          },
          error
        )
      }

      return {
        manifest,
        config: {},
        data: {},
        files,
      }
    } catch {
      return null
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    await this.loadBackupIndex()

    if (this.config.autoBackupEnabled) {
      this.startAutoBackup()
    }
  }

  private async loadBackupIndex(): Promise<void> {
    try {
      const index = this.readIndexFromStorage() ?? {}

      for (const [pluginId, backups] of Object.entries(index)) {
        this.backups.set(
          pluginId,
          backups.map((b) => ({
            ...b,
            createdAt: new Date(b.createdAt),
          }))
        )
      }
    } catch (error) {
      loggers.manager.warn("[Backup] Failed to load backup index:", error)
    }
  }

  // ===========================================================================
  // Backup Creation
  // ===========================================================================

  async createBackup(
    pluginId: string,
    options: {
      reason?: BackupReason
      metadata?: Record<string, unknown>
    } = {}
  ): Promise<BackupResult> {
    const startTime = Date.now()

    try {
      const pluginRuntime = this.getPluginRuntime(pluginId)
      const version = pluginRuntime?.manifest.version || "unknown"
      const sourcePath = pluginRuntime?.path
      if (!sourcePath) {
        throw new Error(`Plugin path not found for ${pluginId}`)
      }
      const backupPath = `${this.config.backupPath}/${pluginId}/${Date.now()}-${version}`

      // Create backup via Tauri
      await invoke("plugin_backup_create", {
        pluginId,
        sourcePath,
        backupPath,
      })

      // Get backup size
      const size = await this.calculatePathSize(backupPath)

      const backup: PluginBackup = {
        id: this.generateBackupId(),
        pluginId,
        version,
        createdAt: new Date(),
        reason: options.reason || "manual",
        size,
        path: backupPath,
        metadata: options.metadata,
      }

      // Add to index
      this.addBackupToIndex(backup)

      // Cleanup old backups
      await this.cleanupOldBackups(pluginId)

      return {
        success: true,
        backup,
        duration: Date.now() - startTime,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      }
    }
  }

  async createBulkBackup(
    pluginIds: string[],
    reason: BackupReason = "manual"
  ): Promise<Map<string, BackupResult>> {
    const results = new Map<string, BackupResult>()

    for (const pluginId of pluginIds) {
      const result = await this.createBackup(pluginId, { reason })
      results.set(pluginId, result)
    }

    return results
  }

  private addBackupToIndex(backup: PluginBackup): void {
    const pluginBackups = this.backups.get(backup.pluginId) || []
    pluginBackups.push(backup)
    pluginBackups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    this.backups.set(backup.pluginId, pluginBackups)

    // Persist index
    this.saveBackupIndex()
  }

  private async saveBackupIndex(): Promise<void> {
    try {
      const index: Record<string, PluginBackup[]> = {}
      for (const [pluginId, backups] of this.backups.entries()) {
        index[pluginId] = backups
      }

      this.writeIndexToStorage(index)
    } catch (error) {
      loggers.manager.error("[Backup] Failed to save index:", error)
    }
  }

  // ===========================================================================
  // Backup Restoration
  // ===========================================================================

  async restore(backupId: string): Promise<RestoreResult> {
    const startTime = Date.now()

    // Find backup
    let backup: PluginBackup | undefined
    for (const backups of this.backups.values()) {
      backup = backups.find((b) => b.id === backupId)
      if (backup) break
    }

    if (!backup) {
      return {
        success: false,
        pluginId: "",
        restoredVersion: "",
        error: "Backup not found",
        duration: 0,
        requiresRestart: false,
      }
    }

    try {
      // Restore via Tauri
      const targetPath = this.getPluginRuntime(backup.pluginId)?.path
      if (!targetPath) {
        throw new Error(`Plugin path not found for ${backup.pluginId}`)
      }
      await invoke("plugin_backup_restore", {
        sourcePath: backup.path,
        targetPath,
      })

      return {
        success: true,
        pluginId: backup.pluginId,
        restoredVersion: backup.version,
        duration: Date.now() - startTime,
        requiresRestart: false,
      }
    } catch (error) {
      return {
        success: false,
        pluginId: backup.pluginId,
        restoredVersion: backup.version,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        requiresRestart: false,
      }
    }
  }

  async restoreLatest(pluginId: string): Promise<RestoreResult> {
    const backups = this.backups.get(pluginId)
    if (!backups || backups.length === 0) {
      return {
        success: false,
        pluginId,
        restoredVersion: "",
        error: "No backups found for plugin",
        duration: 0,
        requiresRestart: false,
      }
    }

    return this.restore(backups[0].id)
  }

  async restoreToVersion(pluginId: string, version: string): Promise<RestoreResult> {
    const backups = this.backups.get(pluginId)
    const backup = backups?.find((b) => b.version === version)

    if (!backup) {
      return {
        success: false,
        pluginId,
        restoredVersion: "",
        error: `No backup found for version ${version}`,
        duration: 0,
        requiresRestart: false,
      }
    }

    return this.restore(backup.id)
  }

  // ===========================================================================
  // Backup Inspection
  // ===========================================================================

  async getBackupContents(backupId: string): Promise<BackupContents | null> {
    let backup: PluginBackup | undefined
    for (const backups of this.backups.values()) {
      backup = backups.find((b) => b.id === backupId)
      if (backup) break
    }

    if (!backup) return null

    return this.inspectBackup(backup.path)
  }

  // ===========================================================================
  // Backup Deletion
  // ===========================================================================

  async deleteBackup(backupId: string): Promise<boolean> {
    for (const [pluginId, backups] of this.backups.entries()) {
      const index = backups.findIndex((b) => b.id === backupId)
      if (index !== -1) {
        const backup = backups[index]

        try {
          await invoke("plugin_backup_delete", { path: backup.path })
          backups.splice(index, 1)
          this.backups.set(pluginId, backups)
          await this.saveBackupIndex()
          return true
        } catch (error) {
          loggers.manager.error("[Backup] Failed to delete backup:", error)
          return false
        }
      }
    }

    return false
  }

  async deleteAllBackups(pluginId: string): Promise<number> {
    const backups = this.backups.get(pluginId)
    if (!backups) return 0

    let deleted = 0
    for (const backup of [...backups]) {
      if (await this.deleteBackup(backup.id)) {
        deleted++
      }
    }

    return deleted
  }

  async cleanupOldBackups(pluginId: string, keepCount?: number): Promise<number> {
    const backups = this.backups.get(pluginId)
    if (!backups) return 0

    const maxToKeep = keepCount ?? this.config.maxBackupsPerPlugin
    let deleted = 0

    while (backups.length > maxToKeep) {
      const oldest = backups.pop()
      if (oldest) {
        try {
          await invoke("plugin_backup_delete", { path: oldest.path })
          deleted++
        } catch (error) {
          recordSilentFailure(
            pluginId,
            {
              site: "backup.cleanupOldBackups.delete",
              message: `Failed to delete old backup at ${oldest.path}.`,
              expected: !canUseTauriInvoke(),
            },
            error
          )
        }
      }
    }

    await this.saveBackupIndex()
    return deleted
  }

  // ===========================================================================
  // Auto Backup
  // ===========================================================================

  startAutoBackup(): void {
    if (this.autoBackupInterval) {
      clearInterval(this.autoBackupInterval)
    }

    this.autoBackupInterval = setInterval(() => {
      this.runAutoBackup()
    }, this.config.autoBackupIntervalMs)
  }

  stopAutoBackup(): void {
    if (this.autoBackupInterval) {
      clearInterval(this.autoBackupInterval)
      this.autoBackupInterval = null
    }
  }

  private async runAutoBackup(): Promise<void> {
    try {
      const installedPlugins = usePluginStore
        .getState()
        .getEnabledPlugins()
        .map((plugin) => plugin.manifest.id)

      for (const pluginId of installedPlugins) {
        const lastBackup = this.backups.get(pluginId)?.[0]
        const timeSinceLastBackup = lastBackup
          ? Date.now() - lastBackup.createdAt.getTime()
          : Infinity

        if (timeSinceLastBackup >= this.config.autoBackupIntervalMs) {
          await this.createBackup(pluginId, { reason: "auto" })
        }
      }
    } catch (error) {
      loggers.manager.error("[Backup] Auto backup failed:", error)
    }
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  getBackups(pluginId: string): PluginBackup[] {
    return this.backups.get(pluginId) || []
  }

  getBackup(backupId: string): PluginBackup | undefined {
    for (const backups of this.backups.values()) {
      const backup = backups.find((b) => b.id === backupId)
      if (backup) return backup
    }
    return undefined
  }

  getAllBackups(): PluginBackup[] {
    const all: PluginBackup[] = []
    for (const backups of this.backups.values()) {
      all.push(...backups)
    }
    return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  getBackupsByReason(reason: BackupReason): PluginBackup[] {
    return this.getAllBackups().filter((b) => b.reason === reason)
  }

  getTotalBackupSize(pluginId?: string): number {
    let total = 0
    if (pluginId) {
      const backups = this.backups.get(pluginId) || []
      for (const backup of backups) {
        total += backup.size
      }
    } else {
      for (const backups of this.backups.values()) {
        for (const backup of backups) {
          total += backup.size
        }
      }
    }
    return total
  }

  isAutoBackupEnabled(): boolean {
    return this.config.autoBackupEnabled
  }

  setAutoBackupEnabled(enabled: boolean): void {
    this.config.autoBackupEnabled = enabled
    if (enabled) {
      this.startAutoBackup()
    } else {
      this.stopAutoBackup()
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateBackupId(): string {
    return `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  dispose(): void {
    this.stopAutoBackup()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let backupManagerInstance: PluginBackupManager | null = null

export function getPluginBackupManager(config?: Partial<BackupConfig>): PluginBackupManager {
  if (!backupManagerInstance) {
    backupManagerInstance = new PluginBackupManager(config)
  }
  return backupManagerInstance
}

export function resetPluginBackupManager(): void {
  if (backupManagerInstance) {
    backupManagerInstance.dispose()
    backupManagerInstance = null
  }
}
