/**
 * CRUD layer for the `twins` Dexie table (schema v29).
 *
 * The Twin row is the multi-twin container — characters bind to a twin via
 * `Character.twinId`, and every twin* table (sources / chunks / profile /
 * drafts / jobs) filters by the same id. Decoupling the registry from
 * Character lets one twin power several characters and lets the user
 * rename / archive / delete a twin from a single place.
 *
 * Cascade-delete semantics live in `deleteTwin` — it wipes every twin* row
 * and (best-effort) detaches any Character that still references the id.
 * The remote vector store is the caller's responsibility because deletion
 * needs the current vector backend config; see the Twin Selector UI for
 * the wiring.
 */

import type { Twin } from "@/types/twin"
import { getDb } from "./schema"

function newId(): string {
  return "twn_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type TwinInput = Omit<Twin, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Twin, "id" | "createdAt" | "updatedAt">>

export async function createTwin(draft: TwinInput): Promise<Twin> {
  const now = Date.now()
  const row: Twin = {
    id: draft.id ?? newId(),
    name: draft.name,
    color: draft.color,
    description: draft.description,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
    archived: draft.archived,
  }
  await getDb().twins.add(row)
  return row
}

export async function getTwin(id: string): Promise<Twin | undefined> {
  return getDb().twins.get(id)
}

export async function listTwins(opts: { includeArchived?: boolean } = {}): Promise<Twin[]> {
  const rows = await getDb().twins.orderBy("updatedAt").reverse().toArray()
  if (opts.includeArchived) return rows
  return rows.filter((t) => !t.archived)
}

/** Convenience for `useLiveQuery` — same shape, returns array directly. */
export function observeTwins(opts: { includeArchived?: boolean } = {}): Promise<Twin[]> {
  return listTwins(opts)
}

export async function renameTwin(id: string, name: string): Promise<Twin | undefined> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("renameTwin: name must be non-empty")
  await getDb().twins.update(id, { name: trimmed, updatedAt: Date.now() })
  return getDb().twins.get(id)
}

export async function updateTwin(
  id: string,
  patch: Partial<Omit<Twin, "id" | "createdAt">>
): Promise<Twin | undefined> {
  await getDb().twins.update(id, { ...patch, updatedAt: Date.now() })
  return getDb().twins.get(id)
}

export async function archiveTwin(id: string, archived = true): Promise<Twin | undefined> {
  return updateTwin(id, { archived })
}

/**
 * Clone the twin metadata row. Sources / chunks / profile / drafts / jobs
 * are NOT copied — those live in their own tables and are cheap to
 * recreate via re-ingest. UI should warn the user that the clone starts
 * empty so they re-upload (or M1's "Re-parse" path handles it).
 *
 * Returns the new Twin row.
 */
export async function cloneTwin(sourceId: string, newName: string): Promise<Twin> {
  const source = await getTwin(sourceId)
  if (!source) throw new Error(`cloneTwin: source twin ${sourceId} not found`)
  return createTwin({
    name: newName.trim() || `${source.name} (copy)`,
    color: source.color,
    description: source.description,
  })
}

/**
 * Hard-delete a twin and every twin* row that references it. The remote
 * vector store is NOT touched here — caller must drop those entries via
 * the active store client (see `components/twin/twin-selector.tsx`).
 *
 * Returns counts so the UI can render a useful confirmation toast.
 */
export interface DeleteTwinResult {
  sources: number
  chunks: number
  drafts: number
  jobs: number
  profileDeleted: boolean
  detachedCharacterIds: string[]
}

export async function deleteTwin(id: string): Promise<DeleteTwinResult> {
  const db = getDb()
  const result: DeleteTwinResult = {
    sources: 0,
    chunks: 0,
    drafts: 0,
    jobs: 0,
    profileDeleted: false,
    detachedCharacterIds: [],
  }
  await db.transaction(
    "rw",
    [
      db.twins,
      db.twinSources,
      db.twinChunks,
      db.twinProfile,
      db.twinDrafts,
      db.twinJobs,
      db.characters,
    ],
    async () => {
      result.chunks = await db.twinChunks.where("twinId").equals(id).delete()
      result.sources = await db.twinSources.where("twinId").equals(id).delete()
      result.drafts = await db.twinDrafts.where("twinId").equals(id).delete()
      result.jobs = await db.twinJobs.where("twinId").equals(id).delete()
      const profile = await db.twinProfile.where("twinId").equals(id).first()
      if (profile) {
        await db.twinProfile.delete(profile.id)
        result.profileDeleted = true
      }
      // Detach any character that still references this id so it doesn't
      // dangle with a stale twinId pointing at a now-missing row. We scan
      // in memory because `characters.twinId` is not indexed (the field
      // was bolted on after the table existed for two schema versions).
      const characters = await db.characters.toArray()
      for (const character of characters) {
        if (character.twinId !== id) continue
        await db.characters.update(character.id, (obj) => {
          const o = obj as unknown as Record<string, unknown>
          delete o.twinId
          delete o.twinSettings
        })
        result.detachedCharacterIds.push(character.id)
      }
      await db.twins.delete(id)
    }
  )

  // Resources that live OUTSIDE the twin Dexie DB can't be part of the
  // transaction above, so clean them up after it commits. Both are best-effort
  // — a failure here must not turn a successful row delete into an error.
  //
  //  • Scheduler cron tasks: otherwise `twin::<id>::ingest|distill` keep firing
  //    and enqueueing jobs for a now-missing twin. `syncTwinCronToScheduler`
  //    with `undefined` removes both task rows.
  //  • Remote vector collection: otherwise every vector for the twin is
  //    orphaned in the remote store with nothing referencing it.
  try {
    const { syncTwinCronToScheduler } = await import("@/lib/twin/cron/cron-bridge")
    await syncTwinCronToScheduler(id, undefined)
  } catch (err) {
    console.warn(`deleteTwin: failed to remove scheduler cron tasks for ${id}`, err)
  }
  try {
    const [{ tryBuildTwinDeps }, { vectorCollectionName }] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/twin/ingest/persist"),
    ])
    const deps = await tryBuildTwinDeps()
    const store = deps?.store as { deleteCollection?: (name: string) => Promise<void> } | undefined
    await store?.deleteCollection?.(vectorCollectionName(id))
  } catch (err) {
    console.warn(`deleteTwin: failed to drop remote vector collection for ${id}`, err)
  }

  return result
}

/**
 * Migration helper — discovers every distinct `twinId` referenced by an
 * existing twin* row and ensures a `twins` row exists for each. Used by
 * the v29 upgrade hook (and by tests) so users with twins created before
 * the registry table land in a coherent state.
 */
export async function backfillTwinRegistryFromUsage(): Promise<Twin[]> {
  const db = getDb()
  const existing = new Set((await db.twins.toArray()).map((t) => t.id))
  const seen = new Set<string>()
  for (const source of await db.twinSources.toArray()) seen.add(source.twinId)
  for (const chunk of await db.twinChunks.toArray()) seen.add(chunk.twinId)
  for (const profile of await db.twinProfile.toArray()) seen.add(profile.twinId)
  for (const draft of await db.twinDrafts.toArray()) seen.add(draft.twinId)
  for (const job of await db.twinJobs.toArray()) seen.add(job.twinId)
  for (const character of await db.characters.toArray()) {
    if (character.twinId) seen.add(character.twinId)
  }
  // Build a twinId → first-character lookup in memory because the
  // `characters` table does not have `twinId` indexed.
  const charactersByTwin = new Map<string, { name?: string }>()
  for (const character of await db.characters.toArray()) {
    if (character.twinId && !charactersByTwin.has(character.twinId)) {
      charactersByTwin.set(character.twinId, character)
    }
  }
  const created: Twin[] = []
  const now = Date.now()
  for (const id of seen) {
    if (!id || existing.has(id)) continue
    const character = charactersByTwin.get(id)
    const row: Twin = {
      id,
      name: character?.name || id,
      createdAt: now,
      updatedAt: now,
    }
    await db.twins.add(row)
    created.push(row)
  }
  return created
}
