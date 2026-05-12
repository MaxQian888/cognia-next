/**
 * Runs plugin-declared Dexie migrations on schema version bumps.
 *
 * Plugins can declare an optional `migrations` array in their manifest.dexie
 * block. Each entry has a `toVersion` (the manifest version it targets) and an
 * `upgrade` key that names an exported function in the plugin's entry module.
 *
 * Cognia runs the matching upgrade functions once — and only once — when the
 * plugin version advances past each migration's toVersion.
 */

import type { Transaction } from "dexie"
import type { PluginDexieMigrationDef } from "@/types/plugin"

export interface MigrationContext {
  /** The plugin manifest version before this upgrade. */
  previousVersion: number
  /** The plugin manifest version being installed now. */
  currentVersion: number
  /** Resolved upgrade functions exported by the plugin entry module. */
  upgradeHandlers: Record<string, (tx: Transaction) => Promise<void>>
}

/**
 * Runs all pending migrations whose toVersion is > previousVersion and
 * <= currentVersion, in ascending toVersion order.
 *
 * Callers are responsible for:
 *  1. Opening a Dexie transaction covering the tables that may be mutated.
 *  2. Passing the resolved plugin export map as upgradeHandlers.
 *
 * Throws if a migration's `upgrade` name is not found in upgradeHandlers.
 */
export async function runPendingMigrations(
  tx: Transaction,
  migrations: PluginDexieMigrationDef[],
  ctx: MigrationContext
): Promise<void> {
  const pending = migrations
    .filter((m) => m.toVersion > ctx.previousVersion && m.toVersion <= ctx.currentVersion)
    .sort((a, b) => a.toVersion - b.toVersion)

  for (const mig of pending) {
    const fn = ctx.upgradeHandlers[mig.upgrade]
    if (!fn) {
      throw new Error(
        `Migration upgrade function "${mig.upgrade}" not found in plugin exports ` +
          `(toVersion=${mig.toVersion})`
      )
    }
    await fn(tx)
  }
}
