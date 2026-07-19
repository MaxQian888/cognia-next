// CRUD for the `a2uiApps` Dexie table (v13). Mini-app definitions saved
// from the Hub or auto-imported from a Workspace export.

import { getDb } from "./schema"
import type { A2UIAppRow } from "./a2ui-types"
import type { A2UIAppInstance } from "@/hooks/a2ui/app-builder/types"

export type A2UIAppMetadataPatch = Partial<
  Omit<A2UIAppInstance, "id" | "templateId" | "createdAt"> &
    Pick<A2UIAppRow, "isFavorite" | "sortOrder">
>

export async function listApps(): Promise<A2UIAppRow[]> {
  return getDb().a2uiApps.orderBy("updatedAt").reverse().toArray()
}

export async function getApp(id: string): Promise<A2UIAppRow | undefined> {
  return getDb().a2uiApps.get(id)
}

export async function upsertApp(row: A2UIAppRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.a2uiApps, async () => {
    const existing = await db.a2uiApps.get(row.id)
    if (existing?.isBuiltIn) {
      throw new Error(`Cannot modify built-in app ${row.id}`)
    }
    await db.a2uiApps.put(row)
  })
}

export async function bulkUpsertApps(rows: A2UIAppRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.a2uiApps, async () => {
    const existingRows = await db.a2uiApps.bulkGet(rows.map((row) => row.id))
    const protectedRow = existingRows.find((row) => row?.isBuiltIn)
    if (protectedRow) {
      throw new Error(`Cannot modify built-in app ${protectedRow.id}`)
    }
    await db.a2uiApps.bulkPut(rows)
  })
}

/**
 * Patch metadata on an existing durable app without replacing its component
 * tree or creating a structurally incomplete row. Unsaved apps return false;
 * callers can still update their local instance cache. Built-ins are read-only.
 */
export async function patchAppMetadata(
  id: string,
  patch: A2UIAppMetadataPatch,
  when: number = Date.now()
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.a2uiApps, async () => {
    const row = await db.a2uiApps.get(id)
    if (!row) return false
    if (row.isBuiltIn) {
      throw new Error(`Cannot modify built-in app ${id}`)
    }
    await db.a2uiApps.update(id, { ...patch, updatedAt: when })
    return true
  })
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
