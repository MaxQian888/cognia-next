/**
 * Shared coloured-label catalogue — Dexie table `labels` (schema v170).
 *
 * Generalises the connector CRM catalogue (`conversationLabels`, v83) into one
 * scope-discriminated table so the issue tracker does not add a *second*
 * coloured-label system. `lib/db/conversation-labels.ts` now delegates here
 * with `scope: "conversation"`; the issue tracker uses `scope: "issue"`.
 *
 * This module is mechanical — no gating, no i18n, no LLM. Label *names* are
 * user data (like the pre-existing "follow-up"/"vip" seeds), which is why the
 * built-in seeds are literal strings rather than translation keys.
 *
 * Deletion cascades to every table that references label ids, inside a single
 * `rw` transaction, matching the behaviour `conversation-labels.ts` had.
 */

import type { LabelRow, LabelScope } from "@/types/labels"
import { defaultLabelColor } from "@/types/labels"
import { getDb } from "./schema"

function newLabelId(): string {
  return `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateLabelInput {
  scope: LabelScope
  name: string
  color?: string
  description?: string
  builtin?: boolean
  sortOrder?: number
  /** Explicit id — used by the v170 migration to preserve existing ids. */
  id?: string
}

/**
 * Create a label. Names are unique per scope; an existing row with the same
 * (scope, name) is returned untouched rather than duplicated, which makes
 * seeding and GitHub label import idempotent.
 */
export async function createLabel(input: CreateLabelInput): Promise<LabelRow> {
  const db = getDb()
  const name = input.name.trim()
  if (!name) throw new Error("Label name is required")

  const existing = await findLabelByName(input.scope, name)
  if (existing) return existing

  const now = Date.now()
  const maxOrder = await db.labels.where("scope").equals(input.scope).count()
  const row: LabelRow = {
    id: input.id ?? newLabelId(),
    scope: input.scope,
    name,
    color: input.color ?? defaultLabelColor(name),
    ...(input.description ? { description: input.description } : {}),
    ...(input.builtin ? { builtin: true } : {}),
    sortOrder: input.sortOrder ?? maxOrder,
    createdAt: now,
    updatedAt: now,
  }
  await db.labels.put(row)
  return row
}

export async function getLabel(id: string): Promise<LabelRow | undefined> {
  return getDb().labels.get(id)
}

export async function findLabelByName(
  scope: LabelScope,
  name: string
): Promise<LabelRow | undefined> {
  const needle = name.trim().toLowerCase()
  const rows = await getDb().labels.where("scope").equals(scope).toArray()
  return rows.find((row) => row.name.toLowerCase() === needle)
}

/** Every label in a scope, in manual order then alphabetically. */
export async function listLabels(scope: LabelScope): Promise<LabelRow[]> {
  const rows = await getDb().labels.where("scope").equals(scope).toArray()
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** Resolve a set of ids to rows, preserving the caller's order. */
export async function getLabelsByIds(ids: readonly string[]): Promise<LabelRow[]> {
  if (ids.length === 0) return []
  const rows = await getDb().labels.bulkGet([...ids])
  return rows.filter((row): row is LabelRow => Boolean(row))
}

export interface LabelUpdatePatch {
  name?: string
  color?: string
  description?: string
  sortOrder?: number
}

export async function updateLabel(id: string, patch: LabelUpdatePatch): Promise<void> {
  const db = getDb()
  const existing = await db.labels.get(id)
  if (!existing) return
  const next: LabelRow = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    updatedAt: Date.now(),
  }
  await db.labels.put(next)
}

/**
 * Delete a label and strip it from everything that references it.
 *
 * Built-in labels are undeletable (same rule the CRM catalogue enforced).
 * The cascade covers both scopes' referencing tables in one transaction so a
 * crash can never leave a dangling id behind.
 */
export async function deleteLabel(id: string): Promise<void> {
  const db = getDb()
  const label = await db.labels.get(id)
  if (!label) return
  if (label.builtin) throw new Error("Built-in labels cannot be deleted")

  await db.transaction(
    "rw",
    db.labels,
    db.conversationOverrides,
    db.cannedResponses,
    db.issues,
    async () => {
      await db.labels.delete(id)

      const now = Date.now()

      // All three referencing tables carry a `*labelIds` multi-entry index, so
      // these are index lookups rather than full scans.
      const conversations = await db.conversationOverrides.where("labelIds").equals(id).toArray()
      for (const row of conversations) {
        await db.conversationOverrides.update(row.id, {
          labelIds: (row.labelIds ?? []).filter((labelId) => labelId !== id),
          updatedAt: now,
        })
      }

      const canned = await db.cannedResponses.where("labelIds").equals(id).toArray()
      for (const row of canned) {
        await db.cannedResponses.update(row.id, {
          labelIds: (row.labelIds ?? []).filter((labelId) => labelId !== id),
          updatedAt: now,
        })
      }

      const issues = await db.issues.where("labelIds").equals(id).toArray()
      for (const row of issues) {
        await db.issues.update(row.id, {
          labelIds: row.labelIds.filter((labelId) => labelId !== id),
          updatedAt: now,
        })
      }
    }
  )
}

/** Rewrite manual order from an explicit id sequence. */
export async function reorderLabels(
  scope: LabelScope,
  orderedIds: readonly string[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.labels, async () => {
    const now = Date.now()
    for (const [index, id] of orderedIds.entries()) {
      const row = await db.labels.get(id)
      if (!row || row.scope !== scope) continue
      await db.labels.put({ ...row, sortOrder: index, updatedAt: now })
    }
  })
}

/** Starter labels for the issue tracker; names align with GitHub's defaults. */
export const BUILTIN_ISSUE_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: "bug", color: "oklch(0.65 0.19 25)" },
  { name: "feature", color: "oklch(0.62 0.18 265)" },
  { name: "improvement", color: "oklch(0.75 0.15 130)" },
  { name: "documentation", color: "oklch(0.70 0.13 195)" },
  { name: "chore", color: "oklch(0.60 0.02 260)" },
]

/**
 * Seed the issue label catalogue. Idempotent — `createLabel` returns the
 * existing row when the name is already taken, so re-running on every boot is
 * safe and cheap.
 */
export async function seedBuiltinIssueLabels(): Promise<void> {
  for (const [index, seed] of BUILTIN_ISSUE_LABELS.entries()) {
    await createLabel({
      scope: "issue",
      name: seed.name,
      color: seed.color,
      builtin: true,
      sortOrder: index,
    })
  }
}
