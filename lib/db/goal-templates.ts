/**
 * CRUD for the `goalTemplates` Dexie table (ADR-0019 Phase 2, schema v53).
 *
 * Reusable preset objectives shown in the goal picker. Built-ins are seeded
 * on access (`lib/goal/seed-templates.ts`) and clone-on-edit; user rows are
 * fully mutable. Booleans (`builtin` / `isFavorite`) are filtered in-memory
 * because IndexedDB doesn't index booleans reliably — the same approach the
 * v12 `promptPresets` table uses.
 */

import type { GoalTemplate } from "@/types/goal"
import { getDb } from "./schema"

/**
 * List all templates, favourites first, then by `sortOrder` ascending, then
 * by title. The default goal picker order.
 */
export async function listGoalTemplates(): Promise<GoalTemplate[]> {
  const rows = await getDb().goalTemplates.toArray()
  return rows.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.title.localeCompare(b.title)
  })
}

export function getGoalTemplate(id: string): Promise<GoalTemplate | undefined> {
  return getDb().goalTemplates.get(id)
}

/** Insert or replace a template row. Stamps `updatedAt`. */
export async function upsertGoalTemplate(template: GoalTemplate): Promise<GoalTemplate> {
  const row: GoalTemplate = { ...template, updatedAt: Date.now() }
  await getDb().goalTemplates.put(row)
  return row
}

/** Delete a template. Built-ins are clone-on-edit, so callers should guard. */
export async function deleteGoalTemplate(id: string): Promise<void> {
  await getDb().goalTemplates.delete(id)
}

/** Toggle a template's favourite flag. No-op when the row is missing. */
export async function setTemplateFavorite(id: string, isFavorite: boolean): Promise<void> {
  const existing = await getDb().goalTemplates.get(id)
  if (!existing) return
  await getDb().goalTemplates.put({ ...existing, isFavorite, updatedAt: Date.now() })
}
