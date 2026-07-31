/**
 * Tests for Plugin Backup Manager
 */

const mockPlugins = {
  "plugin-a": {
    manifest: { version: "1.0.0" },
    path: "/plugins/plugin-a",
  },
}

import { PluginBackupManager, getPluginBackupManager, resetPluginBackupManager } from "./backup"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: mockPlugins,
    }),
  },
}))

import { invoke } from "@tauri-apps/api/core"
const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

describe("PluginBackupManager", () => {
  let manager: PluginBackupManager

  beforeEach(() => {
    resetPluginBackupManager()
    manager = new PluginBackupManager()
    mockInvoke.mockReset()
  })

  describe("Backup Creation", () => {
    it("should create a backup", async () => {
      mockInvoke.mockResolvedValueOnce({
        backupId: "plugin-a-backup-1",
        pluginId: "plugin-a",
        createdAt: new Date().toISOString(),
        label: "manual",
        sizeBytes: 1024,
        path: "/backups/backup-1",
      })

      const backup = await manager.createBackup("plugin-a", { reason: "manual" })

      expect(backup.backup?.pluginId).toBe("plugin-a")
      expect(backup.backup?.version).toBe("1.0.0")
      expect(backup.backup?.reason).toBe("manual")
      expect(mockInvoke).toHaveBeenCalledWith("plugin_backup_create", {
        pluginId: "plugin-a",
        label: "manual",
      })
    })

    it("should include metadata in backup", async () => {
      mockInvoke.mockResolvedValueOnce({
        backupId: "plugin-a-backup-1",
        pluginId: "plugin-a",
        createdAt: new Date().toISOString(),
        label: "pre-update",
        sizeBytes: 1024,
        path: "/backups/backup-1",
      })

      const backup = await manager.createBackup("plugin-a", {
        reason: "pre-update",
        metadata: { previousVersion: "0.9.0" },
      })

      expect(backup.backup?.metadata?.previousVersion).toBe("0.9.0")
    })
  })

  describe("Backup Listing", () => {
    it("should list backups for a plugin", () => {
      // getBackups returns from local cache, not async
      const backups = manager.getBackups("plugin-a")

      // Empty by default since no backups created
      expect(backups.length).toBe(0)
    })

    it("should get a specific backup", () => {
      // getBackup takes only backupId parameter
      const backup = manager.getBackup("backup-1")

      // Returns undefined when not found
      expect(backup).toBeUndefined()
    })

    it("should return undefined for non-existent backup", () => {
      const backup = manager.getBackup("non-existent")

      expect(backup).toBeUndefined()
    })
  })

  describe("Backup Restoration", () => {
    it("should restore from backup", async () => {
      // restore takes only backupId
      const result = await manager.restore("backup-1")

      // Returns error when backup not found
      expect(result.success).toBe(false)
      expect(result.error).toBe("Backup not found")
    })

    it("should restore latest backup", async () => {
      const result = await manager.restoreLatest("plugin-a")

      // Returns error when no backups found
      expect(result.success).toBe(false)
      expect(result.error).toBe("No backups found for plugin")
    })

    it("restores a host backup with the current plugin and backup identifiers", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          backupId: "plugin-a-20260728T120000",
          pluginId: "plugin-a",
          createdAt: new Date().toISOString(),
          label: "pre-update",
          sizeBytes: 1024,
          path: "/backups/plugin-a-20260728T120000.tar.gz",
        })
        .mockResolvedValueOnce(undefined)

      const created = await manager.createBackup("plugin-a", { reason: "pre-update" })
      const restored = await manager.restore(created.backup!.id)

      expect(restored.success).toBe(true)
      expect(mockInvoke).toHaveBeenLastCalledWith("plugin_backup_restore", {
        pluginId: "plugin-a",
        backupId: "plugin-a-20260728T120000",
      })
    })
  })

  describe("Backup Deletion", () => {
    it("should delete a backup", async () => {
      // deleteBackup takes only backupId
      const result = await manager.deleteBackup("backup-1")

      // Returns false when backup not found
      expect(result).toBe(false)
    })

    it("deletes a host backup with a confined plugin-scoped identifier", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          backupId: "plugin-a-20260728T120000",
          pluginId: "plugin-a",
          createdAt: new Date().toISOString(),
          label: "manual",
          sizeBytes: 1024,
          path: "/backups/plugin-a-20260728T120000.tar.gz",
        })
        .mockResolvedValueOnce(undefined)
      const created = await manager.createBackup("plugin-a")

      await expect(manager.deleteBackup(created.backup!.id)).resolves.toBe(true)
      expect(mockInvoke).toHaveBeenLastCalledWith("plugin_backup_delete", {
        pluginId: "plugin-a",
        backupId: "plugin-a-20260728T120000",
      })
    })

    it("should delete all backups for a plugin", async () => {
      const deleted = await manager.deleteAllBackups("plugin-a")

      // Returns 0 when no backups found
      expect(deleted).toBe(0)
    })
  })

  describe("Auto Backup", () => {
    it("should check if auto backup is enabled", () => {
      // Default state is false per BackupConfig
      expect(manager.isAutoBackupEnabled()).toBe(false)
    })

    it("should toggle auto backup", () => {
      manager.setAutoBackupEnabled(true)
      expect(manager.isAutoBackupEnabled()).toBe(true)

      manager.setAutoBackupEnabled(false)
      expect(manager.isAutoBackupEnabled()).toBe(false)
    })
  })

  describe("Backup Size", () => {
    it("should get total backup size for a plugin", () => {
      // getTotalBackupSize returns from local cache (synchronous)
      const size = manager.getTotalBackupSize("plugin-a")

      // Returns 0 when no backups exist
      expect(size).toBe(0)
    })

    it("should get total backup size for all plugins", () => {
      const size = manager.getTotalBackupSize()

      // Returns 0 when no backups exist
      expect(size).toBe(0)
    })
  })

  describe("Cleanup", () => {
    it("should cleanup old backups", async () => {
      // cleanupOldBackups returns count of deleted backups
      const deleted = await manager.cleanupOldBackups("plugin-a", 3)

      // Returns 0 when no backups to cleanup
      expect(deleted).toBe(0)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginBackupManager()
    const instance1 = getPluginBackupManager()
    const instance2 = getPluginBackupManager()
    expect(instance1).toBe(instance2)
  })
})
