// Telemetry for plugin-contributed skills. Plugin skills don't live in the
// Dexie `skills` table — they're runtime entities registered via the
// overlay registry — so their `usageCount` / `lastUsedAt` counters live in
// a sidecar table introduced at schema v37.
//
// Write path: `lib/claude/build-options.ts` calls `recordPluginSkillUsage`
// once per chat send that resolves any plugin skill. Read path: plugin
// telemetry surfaces (settings → plugins → details, marketplace cards) can
// query this table to display per-skill activity.

import { getDb } from "./schema"

export interface PluginSkillUsageRow {
  /** Plugin skill id (the same id returned by `defineSkill`). */
  pluginSkillId: string
  /** Owning plugin id, so `unregisterPluginSkillUsage` can bulk-delete. */
  pluginId?: string
  usageCount: number
  /** Epoch ms of the most recent invocation. */
  lastUsedAt: number
  /** Epoch ms of the first invocation. */
  firstUsedAt: number
}

export async function recordPluginSkillUsage(
  ids: string[],
  pluginIdMap?: Map<string, string>
): Promise<void> {
  if (ids.length === 0) return
  const now = Date.now()
  const db = getDb()
  await db.transaction("rw", db.pluginSkillUsage, async () => {
    for (const id of ids) {
      const row = await db.pluginSkillUsage.get(id)
      if (row) {
        await db.pluginSkillUsage.update(id, {
          usageCount: row.usageCount + 1,
          lastUsedAt: now,
          // Allow callers to backfill the owning plugin id if it wasn't
          // known on first insert.
          pluginId: row.pluginId ?? pluginIdMap?.get(id),
        })
      } else {
        await db.pluginSkillUsage.put({
          pluginSkillId: id,
          pluginId: pluginIdMap?.get(id),
          usageCount: 1,
          firstUsedAt: now,
          lastUsedAt: now,
        })
      }
    }
  })
}

export async function getPluginSkillUsage(
  pluginSkillId: string
): Promise<PluginSkillUsageRow | undefined> {
  return getDb().pluginSkillUsage.get(pluginSkillId)
}

export async function listPluginSkillUsage(): Promise<PluginSkillUsageRow[]> {
  return getDb().pluginSkillUsage.toArray()
}

/**
 * Bulk-drop every telemetry row belonging to a plugin. Called from the
 * plugin manager on uninstall so usage rows don't outlive the plugin.
 */
export async function deletePluginSkillUsageByPlugin(pluginId: string): Promise<number> {
  return getDb().pluginSkillUsage.where("pluginId").equals(pluginId).delete()
}
