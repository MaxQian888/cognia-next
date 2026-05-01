// CRUD for the `a2uiApps` Dexie table (v13). Mini-app definitions saved
// from the Hub or auto-imported from a Workspace export.

import { getDb } from "./schema"
import type { A2UIAppRow } from "./a2ui-types"

export async function listApps(): Promise<A2UIAppRow[]> {
  return getDb().a2uiApps.orderBy("updatedAt").reverse().toArray()
}

export async function getApp(id: string): Promise<A2UIAppRow | undefined> {
  return getDb().a2uiApps.get(id)
}

export async function upsertApp(row: A2UIAppRow): Promise<void> {
  await getDb().a2uiApps.put(row)
}

export async function bulkUpsertApps(rows: A2UIAppRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().a2uiApps.bulkPut(rows)
}

export async function deleteApp(id: string): Promise<void> {
  const row = await getDb().a2uiApps.get(id)
  if (row?.isBuiltIn) {
    throw new Error(`Cannot delete built-in app ${id}`)
  }
  await getDb().a2uiApps.delete(id)
}

export async function deleteAllUserApps(): Promise<number> {
  // Built-ins survive a "clear" — same convention as characters/skills/teams.
  const all = await getDb().a2uiApps.toArray()
  const userIds = all.filter((a) => !a.isBuiltIn).map((a) => a.id)
  if (userIds.length === 0) return 0
  await getDb().a2uiApps.bulkDelete(userIds)
  return userIds.length
}

export async function touchApp(id: string, when: number = Date.now()): Promise<void> {
  await getDb().a2uiApps.update(id, {
    lastUsedAt: when,
    usageCount: ((await getApp(id))?.usageCount ?? 0) + 1,
  })
}
