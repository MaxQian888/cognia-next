// CRUD for the `a2uiTemplates` Dexie table (v13). Holds *user-defined*
// templates only; the 14 built-in templates ship statically in
// `lib/a2ui/templates/`.

import { getDb } from "./schema"
import type { A2UITemplateRow } from "./a2ui-types"

export async function listTemplates(): Promise<A2UITemplateRow[]> {
  return getDb().a2uiTemplates.orderBy("updatedAt").reverse().toArray()
}

export async function getTemplate(id: string): Promise<A2UITemplateRow | undefined> {
  return getDb().a2uiTemplates.get(id)
}

export async function listTemplatesByCategory(category: string): Promise<A2UITemplateRow[]> {
  return getDb().a2uiTemplates.where("category").equals(category).toArray()
}

export async function upsertTemplate(row: A2UITemplateRow): Promise<void> {
  await getDb().a2uiTemplates.put(row)
}

export async function bulkUpsertTemplates(rows: A2UITemplateRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().a2uiTemplates.bulkPut(rows)
}

export async function deleteTemplate(id: string): Promise<void> {
  await getDb().a2uiTemplates.delete(id)
}

export async function deleteAllUserTemplates(): Promise<number> {
  const count = await getDb().a2uiTemplates.count()
  await getDb().a2uiTemplates.clear()
  return count
}
