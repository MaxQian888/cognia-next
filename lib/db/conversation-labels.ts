/**
 * CRUD for the conversation label catalog.
 *
 * As of schema v170 this is a thin, scope-bound facade over the shared
 * catalogue in `lib/db/labels.ts` (table `labels`, `scope: "conversation"`).
 * The v170 upgrade copied every `conversationLabels` row across with its id
 * preserved, so `ConversationOverrideRow.labelIds[]` and
 * `CannedResponseRow.labelIds[]` keep resolving with no migration of their own.
 *
 * The exported surface is unchanged so every existing caller
 * (`hooks/connectors/use-conversation-labels.ts`, `components/inbox/label-picker.tsx`,
 * `components/settings/connections/tabs/labels-tab.tsx`) keeps working.
 * Deleting a label still strips it from every tagged conversation in one
 * transaction, and built-in labels are still protected.
 */

import type { ConversationLabelRow } from "./crm-types"
import {
  createLabel as createSharedLabel,
  deleteLabel as deleteSharedLabel,
  listLabels as listSharedLabels,
  updateLabel as updateSharedLabel,
} from "./labels"
import { getDb } from "./schema"

export interface CreateLabelInput {
  name: string
  color?: string
  description?: string
  sortOrder?: number
}

export async function createLabel(input: CreateLabelInput): Promise<ConversationLabelRow> {
  return createSharedLabel({ ...input, scope: "conversation" })
}

export async function updateLabel(
  id: string,
  patch: Partial<Pick<ConversationLabelRow, "name" | "color" | "description" | "sortOrder">>
): Promise<void> {
  await updateSharedLabel(id, patch)
}

/** List conversation labels sorted by `sortOrder`, then name. */
export async function listLabels(): Promise<ConversationLabelRow[]> {
  return listSharedLabels("conversation")
}

/**
 * Delete a label and strip it from every conversation that carries it, in one
 * transaction. Built-in labels are protected — the call throws and nothing is
 * deleted.
 */
export async function deleteLabel(id: string): Promise<void> {
  await deleteSharedLabel(id)
}

const BUILTIN_LABELS: ReadonlyArray<{ id: string; name: string; color: string }> = [
  { id: "lbl-builtin-follow-up", name: "Follow-up", color: "#f59e0b" },
  { id: "lbl-builtin-vip", name: "VIP", color: "#a855f7" },
  { id: "lbl-builtin-bug", name: "Bug", color: "#ef4444" },
  { id: "lbl-builtin-resolved", name: "Resolved", color: "#22c55e" },
]

/**
 * Seed the starter built-in labels. Idempotent (skips ids that already exist).
 *
 * Writes through `getDb().labels` directly rather than `createLabel` because
 * these rows carry fixed, well-known ids that other code and older backups
 * reference by value.
 */
export async function seedBuiltinLabels(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  for (let i = 0; i < BUILTIN_LABELS.length; i++) {
    const b = BUILTIN_LABELS[i]
    if (await db.labels.get(b.id)) continue
    await db.labels.add({
      id: b.id,
      scope: "conversation",
      name: b.name,
      color: b.color,
      builtin: true,
      sortOrder: i,
      createdAt: now,
      updatedAt: now,
    })
  }
}
