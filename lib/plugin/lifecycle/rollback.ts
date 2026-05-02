/**
 * Plugin Rollback System
 *
 * Handles plugin version rollback with state migration support.
 */

import { invoke } from "@tauri-apps/api/core"
import { getPluginBackupManager, type PluginBackup } from "./backup"
import { loggers } from "../core/logger"
import { usePluginStore } from "@/stores/plugin"
import { getPluginMarketplace } from "../package/marketplace"

// =============================================================================
// Types
// =============================================================================

export interface RollbackInfo {
  pluginId: string
  currentVersion: string
  availableVersions: VersionInfo[]
  hasBackups: boolean
  lastBackup?: PluginBackup
}

export interface VersionInfo {
  version: string
  source: "backup" | "marketplace" | "local"
  date?: Date
  size?: number
  canRollback: boolean
  reason?: string
}

export interface RollbackResult {
  success: boolean
  pluginId: string
  fromVersion: string
  toVersion: string
  duration: number
  error?: string
  migrationApplied: boolean
  requiresRestart: boolean
}

export interface RollbackPlan {
  pluginId: string
  targetVersion: string
  steps: RollbackStep[]
  estimatedDuration: number
  warnings: string[]
}

export interface RollbackStep {
  order: number
  action: "backup" | "disable" | "unload" | "restore" | "migrate" | "load" | "enable" | "verify"
  description: string
  reversible: boolean
}

export interface MigrationScript {
  fromVersion: string
  toVersion: string
  up: (data: Record<string, unknown>) => Record<string, unknown>
  down: (data: Record<string, unknown>) => Record<string, unknown>
}

export interface RollbackConfig {
  createBackupBeforeRollback: boolean
  verifyAfterRollback: boolean
  migrateData: boolean
  maxRollbackHistory: number
}

// =============================================================================
// Plugin Rollback Manager
// =============================================================================

export class PluginRollbackManager {
  private config: RollbackConfig
  private migrations: Map<string, MigrationScript[]> = new Map()
  private rollbackHistory: RollbackResult[] = []

  constructor(config: Partial<RollbackConfig> = {}) {
    this.config = {
      createBackupBeforeRollback: true,
      verifyAfterRollback: true,
      migrateData: true,
      maxRollbackHistory: 50,
      ...config,
    }
  }

  // ===========================================================================
  // Rollback Information
  // ===========================================================================

  async getRollbackInfo(pluginId: string): Promise<RollbackInfo> {
    const backupManager = getPluginBackupManager()
    const backups = backupManager.getBackups(pluginId)

    // Get current version
    const currentVersion = this.getPluginVersion(pluginId) || "unknown"

    // Get available versions
    const availableVersions: VersionInfo[] = []

    // Add versions from backups
    const seenVersions = new Set<string>()
    for (const backup of backups) {
      if (!seenVersions.has(backup.version)) {
        seenVersions.add(backup.version)
        availableVersions.push({
          version: backup.version,
          source: "backup",
          date: backup.createdAt,
          size: backup.size,
          canRollback: backup.version !== currentVersion,
        })
      }
    }

    // Try to get versions from marketplace
    try {
      const versions = await getPluginMarketplace().getVersions(pluginId)

      for (const v of versions) {
        if (!seenVersions.has(v.version)) {
          seenVersions.add(v.version)
          availableVersions.push({
            version: v.version,
            source: "marketplace",
            date: v.publishedAt,
            canRollback: v.version !== currentVersion,
          })
        }
      }
    } catch {
      // Marketplace not available
    }

    // Sort by version (newest first)
    availableVersions.sort((a, b) => this.compareVersions(b.version, a.version))

    return {
      pluginId,
      currentVersion,
      availableVersions,
      hasBackups: backups.length > 0,
      lastBackup: backups[0],
    }
  }

  // ===========================================================================
  // Rollback Planning
  // ===========================================================================

  async createRollbackPlan(pluginId: string, targetVersion: string): Promise<RollbackPlan> {
    const info = await this.getRollbackInfo(pluginId)
    const steps: RollbackStep[] = []
    const warnings: string[] = []

    // Check if target version is available
    const targetVersionInfo = info.availableVersions.find((v) => v.version === targetVersion)
    if (!targetVersionInfo) {
      throw new Error(`Version ${targetVersion} is not available for rollback`)
    }

    if (!targetVersionInfo.canRollback) {
      throw new Error(`Cannot rollback to version ${targetVersion}`)
    }

    // Plan steps
    let order = 1

    // Step 1: Backup current state
    if (this.config.createBackupBeforeRollback) {
      steps.push({
        order: order++,
        action: "backup",
        description: "Create backup of current state",
        reversible: true,
      })
    }

    // Step 2: Disable plugin
    steps.push({
      order: order++,
      action: "disable",
      description: "Disable plugin",
      reversible: true,
    })

    // Step 3: Unload plugin
    steps.push({
      order: order++,
      action: "unload",
      description: "Unload plugin module",
      reversible: true,
    })

    // Step 4: Restore/install target version
    steps.push({
      order: order++,
      action: "restore",
      description: `Restore to version ${targetVersion}`,
      reversible: false,
    })

    // Step 5: Migrate data if needed
    if (this.config.migrateData) {
      const hasMigration = this.hasMigrationPath(pluginId, info.currentVersion, targetVersion)
      if (hasMigration) {
        steps.push({
          order: order++,
          action: "migrate",
          description: "Migrate plugin data",
          reversible: true,
        })
      } else {
        warnings.push("No migration script found; data may be incompatible")
      }
    }

    // Step 6: Load plugin
    steps.push({
      order: order++,
      action: "load",
      description: "Load plugin module",
      reversible: true,
    })

    // Step 7: Enable plugin
    steps.push({
      order: order++,
      action: "enable",
      description: "Enable plugin",
      reversible: true,
    })

    // Step 8: Verify
    if (this.config.verifyAfterRollback) {
      steps.push({
        order: order++,
        action: "verify",
        description: "Verify rollback success",
        reversible: false,
      })
    }

    // Check for potential issues
    if (this.isMajorVersionChange(info.currentVersion, targetVersion)) {
      warnings.push("Major version change detected; breaking changes may occur")
    }

    return {
      pluginId,
      targetVersion,
      steps,
      estimatedDuration: steps.length * 1000, // Rough estimate
      warnings,
    }
  }

  // ===========================================================================
  // Rollback Execution
  // ===========================================================================

  async rollback(pluginId: string, targetVersion: string): Promise<RollbackResult> {
    const startTime = Date.now()
    const info = await this.getRollbackInfo(pluginId)
    const fromVersion = info.currentVersion
    let migrationApplied = false

    try {
      // Step 1: Create backup if configured
      if (this.config.createBackupBeforeRollback) {
        const backupManager = getPluginBackupManager()
        const backupResult = await backupManager.createBackup(pluginId, {
          reason: "pre-update",
          metadata: { rollbackTo: targetVersion },
        })

        if (!backupResult.success) {
          throw new Error(`Failed to create backup: ${backupResult.error}`)
        }
      }

      // Step 2: Disable and unload plugin
      await invoke("plugin_disable", { pluginId })
      await invoke("plugin_unload", { pluginId })

      // Step 3: Restore target version
      const versionInfo = info.availableVersions.find((v) => v.version === targetVersion)

      if (versionInfo?.source === "backup") {
        // Restore from backup
        const backupManager = getPluginBackupManager()
        const restoreResult = await backupManager.restoreToVersion(pluginId, targetVersion)
        if (!restoreResult.success) {
          throw new Error(`Restore failed: ${restoreResult.error}`)
        }
      } else {
        // Download and install from marketplace
        const installResult = await getPluginMarketplace().installPlugin(pluginId, targetVersion)
        if (!installResult.success) {
          throw new Error(installResult.error || "Marketplace install failed")
        }
      }

      this.projectPluginVersion(pluginId, targetVersion)
      await this.refreshRuntimePlugins()

      // Step 4: Migrate data if needed
      if (this.config.migrateData) {
        migrationApplied = await this.applyMigration(pluginId, fromVersion, targetVersion)
      }

      // Step 5: Load and enable
      await invoke("plugin_load", { pluginId })
      await invoke("plugin_enable", { pluginId })

      // Step 6: Verify
      if (this.config.verifyAfterRollback) {
        const verified = await this.verifyRollback(pluginId, targetVersion)
        if (!verified) {
          throw new Error("Rollback verification failed")
        }
      }

      const result: RollbackResult = {
        success: true,
        pluginId,
        fromVersion,
        toVersion: targetVersion,
        duration: Date.now() - startTime,
        migrationApplied,
        requiresRestart: await this.checkRequiresRestart(),
      }

      this.recordRollback(result)
      return result
    } catch (error) {
      const result: RollbackResult = {
        success: false,
        pluginId,
        fromVersion,
        toVersion: targetVersion,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
        migrationApplied,
        requiresRestart: false,
      }

      this.recordRollback(result)
      return result
    }
  }

  async rollbackToLatestBackup(pluginId: string): Promise<RollbackResult> {
    const backupManager = getPluginBackupManager()
    const backups = backupManager.getBackups(pluginId)

    if (backups.length === 0) {
      return {
        success: false,
        pluginId,
        fromVersion: "",
        toVersion: "",
        duration: 0,
        error: "No backups available",
        migrationApplied: false,
        requiresRestart: false,
      }
    }

    return this.rollback(pluginId, backups[0].version)
  }

  private async verifyRollback(pluginId: string, expectedVersion: string): Promise<boolean> {
    return this.getPluginVersion(pluginId) === expectedVersion
  }

  private async checkRequiresRestart(): Promise<boolean> {
    return false
  }

  // ===========================================================================
  // Migration Support
  // ===========================================================================

  registerMigration(pluginId: string, migration: MigrationScript): void {
    const migrations = this.migrations.get(pluginId) || []
    migrations.push(migration)
    migrations.sort((a, b) => this.compareVersions(a.fromVersion, b.fromVersion))
    this.migrations.set(pluginId, migrations)
  }

  hasMigrationPath(pluginId: string, fromVersion: string, toVersion: string): boolean {
    const migrations = this.migrations.get(pluginId)
    if (!migrations) return false

    // Check if we can migrate between these versions
    const isDowngrade = this.compareVersions(fromVersion, toVersion) > 0

    if (isDowngrade) {
      // Need down migrations
      return migrations.some(
        (m) =>
          this.compareVersions(m.toVersion, fromVersion) <= 0 &&
          this.compareVersions(m.fromVersion, toVersion) >= 0
      )
    } else {
      // Need up migrations
      return migrations.some(
        (m) =>
          this.compareVersions(m.fromVersion, fromVersion) >= 0 &&
          this.compareVersions(m.toVersion, toVersion) <= 0
      )
    }
  }

  private async applyMigration(
    pluginId: string,
    fromVersion: string,
    toVersion: string
  ): Promise<boolean> {
    const migrations = this.migrations.get(pluginId)
    if (!migrations) return false

    const isDowngrade = this.compareVersions(fromVersion, toVersion) > 0

    try {
      const store = usePluginStore.getState()
      const existingPlugin = store.plugins[pluginId]
      if (!existingPlugin) {
        return false
      }

      let migratedData = { ...existingPlugin.config }

      if (isDowngrade) {
        // Apply down migrations in reverse order
        const applicableMigrations = migrations
          .filter(
            (m) =>
              this.compareVersions(m.toVersion, fromVersion) <= 0 &&
              this.compareVersions(m.fromVersion, toVersion) >= 0
          )
          .reverse()

        for (const migration of applicableMigrations) {
          migratedData = migration.down(migratedData)
        }
      } else {
        // Apply up migrations in order
        const applicableMigrations = migrations.filter(
          (m) =>
            this.compareVersions(m.fromVersion, fromVersion) >= 0 &&
            this.compareVersions(m.toVersion, toVersion) <= 0
        )

        for (const migration of applicableMigrations) {
          migratedData = migration.up(migratedData)
        }
      }

      // Save migrated data
      store.setPluginConfig(pluginId, migratedData)
      return true
    } catch (error) {
      loggers.manager.error("[Rollback] Migration failed:", error)
      return false
    }
  }

  private getPluginVersion(pluginId: string): string | null {
    const plugin = usePluginStore.getState().plugins[pluginId]
    return plugin?.manifest.version || null
  }

  private async refreshRuntimePlugins(): Promise<void> {
    try {
      const { getPluginManager } = await import("../core/manager")
      await getPluginManager().scanPlugins()
      await getPluginManager().syncRuntimeState()
    } catch (error) {
      loggers.manager.debug("[Rollback] Runtime refresh skipped:", error)
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
  // Version Utilities
  // ===========================================================================

  private compareVersions(a: string, b: string): number {
    const aParts = a.split(".").map((p) => parseInt(p) || 0)
    const bParts = b.split(".").map((p) => parseInt(p) || 0)

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0
      const bVal = bParts[i] || 0
      if (aVal > bVal) return 1
      if (aVal < bVal) return -1
    }

    return 0
  }

  private isMajorVersionChange(from: string, to: string): boolean {
    const fromMajor = parseInt(from.split(".")[0]) || 0
    const toMajor = parseInt(to.split(".")[0]) || 0
    return fromMajor !== toMajor
  }

  // ===========================================================================
  // History
  // ===========================================================================

  private recordRollback(result: RollbackResult): void {
    this.rollbackHistory.push(result)
    if (this.rollbackHistory.length > this.config.maxRollbackHistory) {
      this.rollbackHistory = this.rollbackHistory.slice(-this.config.maxRollbackHistory)
    }
  }

  getRollbackHistory(pluginId?: string): RollbackResult[] {
    if (pluginId) {
      return this.rollbackHistory.filter((r) => r.pluginId === pluginId)
    }
    return [...this.rollbackHistory]
  }

  clearHistory(): void {
    this.rollbackHistory = []
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let rollbackManagerInstance: PluginRollbackManager | null = null

export function getPluginRollbackManager(config?: Partial<RollbackConfig>): PluginRollbackManager {
  if (!rollbackManagerInstance) {
    rollbackManagerInstance = new PluginRollbackManager(config)
  }
  return rollbackManagerInstance
}

export function resetPluginRollbackManager(): void {
  rollbackManagerInstance = null
}
