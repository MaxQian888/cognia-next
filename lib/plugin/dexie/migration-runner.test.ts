/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { Transaction } from "dexie"
import { runPendingMigrations, type MigrationContext } from "./migration-runner"
import type { PluginDexieMigrationDef } from "@/types/plugin"

function makeTx(): Transaction {
  // jest mock — we only test that the right handlers are called
  return {} as Transaction
}

describe("runPendingMigrations", () => {
  it("runs migrations whose toVersion is > previousVersion and <= currentVersion", async () => {
    const v2 = jest.fn().mockResolvedValue(undefined)
    const v3 = jest.fn().mockResolvedValue(undefined)
    const migrations: PluginDexieMigrationDef[] = [
      { toVersion: 2, upgrade: "migrateToV2" },
      { toVersion: 3, upgrade: "migrateToV3" },
    ]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 3,
      upgradeHandlers: { migrateToV2: v2, migrateToV3: v3 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(v2).toHaveBeenCalledTimes(1)
    expect(v3).toHaveBeenCalledTimes(1)
  })

  it("skips migrations that are already applied (toVersion <= previousVersion)", async () => {
    const v2 = jest.fn().mockResolvedValue(undefined)
    const migrations: PluginDexieMigrationDef[] = [{ toVersion: 2, upgrade: "migrateToV2" }]
    const ctx: MigrationContext = {
      previousVersion: 2,
      currentVersion: 3,
      upgradeHandlers: { migrateToV2: v2 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(v2).not.toHaveBeenCalled()
  })

  it("runs migrations in ascending toVersion order", async () => {
    const order: number[] = []
    const v2 = jest.fn().mockImplementation(async () => {
      order.push(2)
    })
    const v3 = jest.fn().mockImplementation(async () => {
      order.push(3)
    })
    const migrations: PluginDexieMigrationDef[] = [
      { toVersion: 3, upgrade: "v3" },
      { toVersion: 2, upgrade: "v2" },
    ]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 3,
      upgradeHandlers: { v2, v3 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(order).toEqual([2, 3])
  })

  it("throws when an upgrade function is not found", async () => {
    const migrations: PluginDexieMigrationDef[] = [{ toVersion: 2, upgrade: "missingFn" }]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 2,
      upgradeHandlers: {},
    }
    await expect(runPendingMigrations(makeTx(), migrations, ctx)).rejects.toThrow(
      /missingFn.*not found/
    )
  })

  it("does nothing when migrations array is empty", async () => {
    await expect(
      runPendingMigrations(makeTx(), [], {
        previousVersion: 1,
        currentVersion: 5,
        upgradeHandlers: {},
      })
    ).resolves.toBeUndefined()
  })
})
