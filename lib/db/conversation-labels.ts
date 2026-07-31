/**
 * CRUD for the `conversationLabels` catalog (schema v83). Labels are assigned
 * to conversations via `ConversationOverrideRow.labelIds`; deleting a label
 * strips it from every tagged conversation in one transaction so no dangling
 * id remains. A small set of built-in labels is seeded on access and protected
 * from deletion.
 */

import type { ConversationLabelRow } from "./crm-types"
import { getDb } from "./schema"

function newId(): string {
  return "lbl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface CreateLabelInput {
  name: string
  color?: string
  description?: string
  sortOrder?: number
}

export async function createLabel(input: CreateLabelInput): Promise<ConversationLabelRow> {
  const db = getDb()
  const now = Date.now()
  const row: ConversationLabelRow = {
    id: newId(),
    name: input.name,
    color: input.color,
    description: input.description,
    sortOrder: input.sortOrder ?? (await db.conversationLabels.count()),
    createdAt: now,
    updatedAt: now,
  }
  await db.conversationLabels.add(row)
  return row
}

export async function updateLabel(
  id: string,
  patch: Partial<Pick<ConversationLabelRow, "name" | "color" | "description" | "sortOrder">>
): Promise<void> {
  await getDb().conversationLabels.update(id, { ...patch, updatedAt: Date.now() })
}

/** List labels sorted by `sortOrder`, then name. */
export async function listLabels(): Promise<ConversationLabelRow[]> {
  const all = await getDb().conversationLabels.toArray()
  return all.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/**
 * Delete a label and strip it from every conversation that carries it, in one
 * transaction. Built-in labels are protected — the call throws and the
 * transaction aborts (nothing deleted).
 */
export async function deleteLabel(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.conversationLabels, db.conversationOverrides, async () => {
    const label = await db.conversationLabels.get(id)
    if (!label) return
    if (label.builtin) throw new Error(`Cannot delete built-in label "${label.name}"`)
    await db.conversationLabels.delete(id)
    const tagged = await db.conversationOverrides.where("labelIds").equals(id).toArray()
    const now = Date.now()
    for (const row of tagged) {
      await db.conversationOverrides.update(row.id, {
        labelIds: (row.labelIds ?? []).filter((l) => l !== id),
        updatedAt: now,
      })
    }
  })
}

const BUILTIN_LABELS: ReadonlyArray<{ id: string; name: string; color: string }> = [
  { id: "lbl-builtin-follow-up", name: "Follow-up", color: "#f59e0b" },
  { id: "lbl-builtin-vip", name: "VIP", color: "#a855f7" },
  { id: "lbl-builtin-bug", name: "Bug", color: "#ef4444" },
  { id: "lbl-builtin-resolved", name: "Resolved", color: "#22c55e" },
]

/** Seed the starter built-in labels. Idempotent (skips ids that already exist). */
export async function seedBuiltinLabels(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  for (let i = 0; i < BUILTIN_LABELS.length; i++) {
    const b = BUILTIN_LABELS[i]
    if (await db.conversationLabels.get(b.id)) continue
    await db.conversationLabels.add({
      id: b.id,
      name: b.name,
      color: b.color,
      builtin: true,
      sortOrder: i,
      createdAt: now,
      updatedAt: now,
    })
  }
}
