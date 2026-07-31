/**
 * CRUD for the `cannedResponses` table (schema v83) — the global saved-reply
 * library inserted from the inbox composer. Distinct from per-adapter
 * quick-commands (inbound text triggers); these are outbound templates with
 * `{{variable}}` interpolation (see lib/connectors/canned-interpolate.ts).
 */

import type { CannedResponseRow } from "./crm-types"
import { getDb } from "./schema"

function newId(): string {
  return "can_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface CreateCannedInput {
  title: string
  body: string
  category?: string
  shortcut?: string
  labelIds?: string[]
  sortOrder?: number
}

export async function createCanned(input: CreateCannedInput): Promise<CannedResponseRow> {
  const db = getDb()
  const now = Date.now()
  const row: CannedResponseRow = {
    id: newId(),
    title: input.title,
    body: input.body,
    category: input.category,
    shortcut: input.shortcut,
    labelIds: input.labelIds,
    sortOrder: input.sortOrder ?? (await db.cannedResponses.count()),
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await db.cannedResponses.add(row)
  return row
}

export async function updateCanned(
  id: string,
  patch: Partial<
    Pick<CannedResponseRow, "title" | "body" | "category" | "shortcut" | "labelIds" | "sortOrder">
  >
): Promise<void> {
  await getDb().cannedResponses.update(id, { ...patch, updatedAt: Date.now() })
}

/** Delete a canned response. Built-in starters are protected (throws). */
export async function deleteCanned(id: string): Promise<void> {
  const db = getDb()
  const row = await db.cannedResponses.get(id)
  if (!row) return
  if (row.isBuiltIn) throw new Error(`Cannot delete built-in canned response "${row.title}"`)
  await db.cannedResponses.delete(id)
}

/** List canned responses sorted by `sortOrder`, then title. */
export async function listCanned(): Promise<CannedResponseRow[]> {
  const all = await getDb().cannedResponses.toArray()
  return all.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
}

/** Bump the usage counter when a response is inserted (best-effort). */
export async function incrementUsage(id: string): Promise<void> {
  const db = getDb()
  const row = await db.cannedResponses.get(id)
  if (!row) return
  await db.cannedResponses.update(id, { usageCount: (row.usageCount ?? 0) + 1 })
}

const BUILTIN_CANNED: ReadonlyArray<{ id: string; title: string; body: string }> = [
  {
    id: "can-builtin-greeting",
    title: "Greeting",
    body: "Hi {{contact.name}}, thanks for reaching out!",
  },
  {
    id: "can-builtin-ack",
    title: "Acknowledge",
    body: "Got it — looking into this now and will get back to you shortly.",
  },
  {
    id: "can-builtin-resolved",
    title: "Resolved",
    body: "Glad that's sorted! Closing this out — reply any time to reopen.",
  },
]

/** Seed the starter canned responses. Idempotent. */
export async function seedBuiltinCanned(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  for (let i = 0; i < BUILTIN_CANNED.length; i++) {
    const b = BUILTIN_CANNED[i]
    if (await db.cannedResponses.get(b.id)) continue
    await db.cannedResponses.add({
      id: b.id,
      title: b.title,
      body: b.body,
      isBuiltIn: true,
      sortOrder: i,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    })
  }
}
