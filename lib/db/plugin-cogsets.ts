// Cogsets and the host's cogset state (Dexie v235, ADR-0209).
//
// A cogset owns which plugins *should* run together; the plugin manager owns
// what is loaded. Nothing here enables or disables anything: activation is the
// reconciliation in `lib/plugin/cogset/reconcile.ts`, which goes through
// `PluginManager.setPluginIntent` like every other toggle.

import {
  COGSET_STATE_ID,
  type CogsetMember,
  type CogsetRow,
  type CogsetSource,
  type CogsetStateRow,
} from "@/types/plugin/plugin-cogset"

import { recordTombstones } from "@/lib/sync/tombstones"

import { getDb } from "./schema"

function newId(): string {
  return "cogset_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Members deduplicated by plugin id (last wins) and sorted, so equal sets compare equal. */
export function normalizeCogsetMembers(members: readonly CogsetMember[]): CogsetMember[] {
  const byId = new Map<string, CogsetMember>()
  for (const member of members) {
    const pluginId = member.pluginId.trim()
    if (!pluginId) continue
    byId.set(pluginId, {
      pluginId,
      ...(member.expectedVersion ? { expectedVersion: member.expectedVersion } : {}),
      ...(member.config ? { config: member.config } : {}),
      ...(member.optional ? { optional: true } : {}),
    })
  }
  return [...byId.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

export async function listCogsets(): Promise<CogsetRow[]> {
  return getDb().pluginCogsets.orderBy("name").toArray()
}

export async function getCogset(id: string): Promise<CogsetRow | undefined> {
  return getDb().pluginCogsets.get(id)
}

export interface CogsetDraft {
  name: string
  description?: string
  members: readonly CogsetMember[]
  source: CogsetSource
}

export async function createCogset(draft: CogsetDraft, now = Date.now()): Promise<CogsetRow> {
  const name = draft.name.trim()
  if (!name) throw new Error("A cogset needs a name")
  const row: CogsetRow = {
    id: newId(),
    name,
    ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
    members: normalizeCogsetMembers(draft.members),
    source: draft.source,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().pluginCogsets.add(row)
  return row
}

export type CogsetPatch = Partial<
  Pick<CogsetRow, "name" | "description" | "members" | "source" | "lastApplied">
>

/** Apply `patch` to a cogset. Resolves to the updated row, or undefined when it does not exist. */
export async function updateCogset(
  id: string,
  patch: CogsetPatch,
  now = Date.now()
): Promise<CogsetRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.pluginCogsets, async () => {
    const existing = await db.pluginCogsets.get(id)
    if (!existing) return undefined
    const name = patch.name === undefined ? existing.name : patch.name.trim()
    if (!name) throw new Error("A cogset needs a name")
    const next: CogsetRow = {
      ...existing,
      ...patch,
      name,
      members:
        patch.members === undefined ? existing.members : normalizeCogsetMembers(patch.members),
      updatedAt: now,
    }
    if (patch.description !== undefined && !patch.description.trim()) delete next.description
    await db.pluginCogsets.put(next)
    return next
  })
}

/**
 * Delete a cogset. Clears every state reference to it in the same transaction
 * so the host never points at a cogset that no longer exists. Never uninstalls
 * a plugin; the caller offers that separately.
 */
export async function deleteCogset(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [db.pluginCogsets, db.pluginCogsetState, db.projects, db.cogpackInstalls, db.syncTombstones],
    async () => {
      await db.pluginCogsets.delete(id)
      // Paired clients mirror cogsets and learn about a deletion only from this.
      await recordTombstones("pluginCogsets", [id])
      const state = await db.pluginCogsetState.get(COGSET_STATE_ID)
      if (state) {
        const next: CogsetStateRow = { ...state, updatedAt: now }
        if (next.globalCogsetId === id) delete next.globalCogsetId
        if (next.appliedCogsetId === id) {
          delete next.appliedCogsetId
          delete next.appliedAt
        }
        if (next.pending?.cogsetId === id) delete next.pending
        await db.pluginCogsetState.put(next)
      }
      await db.projects
        .filter((project) => project.pluginCogsetId === id)
        .modify((project) => {
          delete project.pluginCogsetId
        })
      // An import record names the cogset it created; without that cogset it
      // is no longer an update base, so a re-import starts a new cogset.
      await db.cogpackInstalls.where("cogsetId").equals(id).delete()
    }
  )
}

function emptyState(now: number): CogsetStateRow {
  return { id: COGSET_STATE_ID, alwaysOn: [], updatedAt: now }
}

export async function getCogsetState(): Promise<CogsetStateRow> {
  return (await getDb().pluginCogsetState.get(COGSET_STATE_ID)) ?? emptyState(Date.now())
}

export type CogsetStatePatch = Partial<Omit<CogsetStateRow, "id" | "updatedAt">>

/**
 * Merge `patch` into the singleton. A key set to `undefined` in the patch is
 * removed, so callers can clear `pending` or `globalCogsetId` explicitly.
 */
export async function updateCogsetState(
  patch: CogsetStatePatch,
  now = Date.now()
): Promise<CogsetStateRow> {
  const db = getDb()
  return db.transaction("rw", db.pluginCogsetState, async () => {
    const current = (await db.pluginCogsetState.get(COGSET_STATE_ID)) ?? emptyState(now)
    const next: CogsetStateRow = { ...current, updatedAt: now }
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof CogsetStatePatch, CogsetStatePatch[keyof CogsetStatePatch]]
    >) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key]
      else (next as unknown as Record<string, unknown>)[key] = value
    }
    next.alwaysOn = [
      ...new Set((next.alwaysOn ?? []).map((id) => id.trim()).filter(Boolean)),
    ].sort()
    await db.pluginCogsetState.put(next)
    return next
  })
}
