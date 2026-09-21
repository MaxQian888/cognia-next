"use client"

/**
 * Mirrors the artifact half of `useArtifactStore` into the Dexie `artifacts` /
 * `artifactVersions` tables, and carries the legacy `cognia-artifacts`
 * localStorage blob into them on first boot (ADR-0158).
 *
 * Dexie is AUTHORITATIVE here, unlike `lib/canvas/dexie-bridge.ts` where it
 * started life as a backup mirror. The Zustand store keeps the working copy in
 * memory and, after the initial migration commits, `partialize` no longer
 * writes artifacts to localStorage, so:
 *
 *   - Hydration seeds the store from Dexie for every artifact memory does not
 *     already hold. Memory still wins on a conflict — it is either what the
 *     user is editing right now, or the legacy blob that has not been migrated
 *     yet, and both are newer than the row.
 *   - The subscription then diffs every store write against the mirror and
 *     pushes adds/updates/deletes. Versions are flattened out of the store's
 *     `Record<artifactId, ArtifactVersion[]>` into their own table so a
 *     restore on another device gets the history too.
 *
 * Two safety rules the account lifecycle forces:
 *
 *   1. **Never write to a database this mirror was not built against.** Locking
 *      an account clears the Dexie selection BEFORE it clears the store
 *      (`stores/account/account-store.ts`), so a live subscription would
 *      observe an empty store pointed at a different database and delete every
 *      row in it. The db name is captured at hydration and re-checked on every
 *      flush; a mismatch drops the write and waits for the provider to restart
 *      the bridge against the new database.
 *   2. **A failed hydration disables the mirror entirely.** Deletes are derived
 *      from "in the mirror, absent from memory". If hydration threw, memory is
 *      an unknown subset of the table, and syncing it would delete the rest.
 */

import type { Artifact, ArtifactVersion } from "@/types/artifact/artifact"
import { completeArtifactDexieMigration, useArtifactStore } from "@/stores/artifact/artifact-store"
import { getDb } from "@/lib/db/schema"
import {
  artifactFromRow,
  artifactRowFrom,
  artifactVersionFromRow,
  artifactVersionRowFrom,
  type ArtifactRow,
  type ArtifactVersionRow,
} from "@/lib/db/artifact-types"
import {
  capturePendingArtifactMigration,
  clearPendingArtifactMigration,
  getArtifactMigrationScope,
  type PendingArtifactMigration,
} from "@/lib/artifacts/localstorage-migration"
import { loggers } from "@cognia/logging"

/**
 * How long a burst of edits may accumulate before it reaches Dexie. An
 * artifact edit arrives per keystroke while the review pane is open; one
 * transaction per keystroke is what this batch exists to remove.
 */
export const ARTIFACT_SYNC_DEBOUNCE_MS = 500

let activeBridge: { dispose: () => void; cancel: () => void } | null = null
// A restarted bridge waits for its own database's final write. An unrelated
// account must not block behind a stalled transaction in another database.
const previousWrites = new Map<string, Promise<void>>()

interface ArtifactSnapshot {
  artifacts: Record<string, Artifact>
  versions: Record<string, ArtifactVersion[]>
}

interface RetainedArtifactWrite {
  snapshot: ArtifactSnapshot
  deletedIds: Set<string>
}

// Failed final writes stay in the existing queue across bridge restarts. Keep
// these account/database scoped and in memory: writing modern artifact content
// into plaintext localStorage would bypass the account database's encryption.
const retainedWrites = new Map<string, RetainedArtifactWrite>()

/** Test-only: cancel subscriptions and timers as well as the active instance. */
export function __resetArtifactDexieBridgeForTesting(): void {
  activeBridge?.cancel()
  activeBridge = null
  previousWrites.clear()
  retainedWrites.clear()
}

/**
 * The parked blob went through `JSON.stringify`, so its `Date` fields are ISO
 * strings. The row converters accept either, but the store's own consumers call
 * `.getTime()` directly — so coerce on the way in rather than leaving two
 * shapes of `createdAt` in the same map.
 */
function rehydrateArtifactMap(raw: Record<string, Artifact>): Record<string, Artifact> {
  const out: Record<string, Artifact> = {}
  for (const [id, artifact] of Object.entries(raw)) {
    if (!artifact || typeof artifact !== "object") continue
    out[id] = artifactFromRow(artifactRowFrom(artifact))
  }
  return out
}

function rehydrateVersionMap(
  raw: Record<string, ArtifactVersion[]>
): Record<string, ArtifactVersion[]> {
  const out: Record<string, ArtifactVersion[]> = {}
  for (const [artifactId, versions] of Object.entries(raw)) {
    if (!Array.isArray(versions)) continue
    out[artifactId] = versions.map((version) =>
      artifactVersionFromRow(artifactVersionRowFrom(version))
    )
  }
  return out
}

interface ArtifactMirrorDiff {
  removedArtifactIds: string[]
  artifactUpserts: ArtifactRow[]
  removedVersionIds: string[]
  versionUpserts: ArtifactVersionRow[]
}

/**
 * What changed between the mirror and the store. Pure, so the diff rules are
 * testable without an IndexedDB. `seenVersionIds` is returned rather than
 * assigned here because it only becomes the new baseline once the write lands.
 */
export function diffArtifactMirror(
  previous: Record<string, Artifact>,
  previousVersionIds: ReadonlySet<string>,
  next: Record<string, Artifact>,
  nextVersions: Record<string, ArtifactVersion[]>
): ArtifactMirrorDiff & { seenVersionIds: Set<string> } {
  const nextIds = new Set(Object.keys(next))
  const removedArtifactIds: string[] = []
  for (const id of Object.keys(previous)) {
    if (!nextIds.has(id)) removedArtifactIds.push(id)
  }

  // Object identity is the "did this change" test: every store mutation
  // replaces the artifact object, so an unchanged reference cannot hide an
  // edit. Without it a single keystroke re-put the whole corpus.
  const artifactUpserts: ArtifactRow[] = []
  for (const id of nextIds) {
    if (previous[id] === next[id]) continue
    artifactUpserts.push(artifactRowFrom(next[id]))
  }

  // A version is immutable once written, so an id already mirrored needs no
  // rewrite — only the ones we have never seen, and the ones that disappeared
  // (version pruning, or the parent artifact being deleted).
  const seenVersionIds = new Set<string>()
  const versionUpserts: ArtifactVersionRow[] = []
  for (const [artifactId, versions] of Object.entries(nextVersions)) {
    // Versions whose artifact is gone are dropped with it; keeping them would
    // resurrect history for an id that no longer resolves.
    if (!nextIds.has(artifactId)) continue
    for (const version of versions) {
      seenVersionIds.add(version.id)
      if (previousVersionIds.has(version.id)) continue
      versionUpserts.push(artifactVersionRowFrom(version, next[artifactId]?.projectId))
    }
  }
  const removedVersionIds: string[] = []
  for (const id of previousVersionIds) {
    if (!seenVersionIds.has(id)) removedVersionIds.push(id)
  }

  return {
    removedArtifactIds,
    artifactUpserts,
    removedVersionIds,
    versionUpserts,
    seenVersionIds,
  }
}

/**
 * Seed the store from Dexie and prime the mirror with exactly what was seeded.
 *
 * Priming matters: without it the first sync after a reload re-puts every
 * artifact it just read, which on a large library is a multi-megabyte write
 * that changes nothing. Rows already present in memory are deliberately NOT
 * primed — memory won the conflict, so the row on disk is stale and has to be
 * overwritten by the first sync.
 */
async function hydrateFromDexie(
  db: ReturnType<typeof getDb>,
  pending: PendingArtifactMigration | null,
  canApply: () => boolean,
  deletedIds: Set<string>,
  changedIds: Set<string>,
  retained?: RetainedArtifactWrite
): Promise<{ artifacts: Record<string, Artifact>; versionIds: Set<string> } | null> {
  const [artifactRows, versionRows] = await Promise.all([
    db.artifacts.toArray(),
    db.artifactVersions.toArray(),
  ])
  if (!canApply()) return null

  // Rows a previous, interrupted migration parked but never wrote. Restoring
  // them BEFORE the Dexie read is compared against memory means they take the
  // same "memory wins" path as anything the store rehydrated itself, and the
  // initial sync then carries them into Dexie.
  if (pending || retained) {
    useArtifactStore.setState((state) => {
      const artifacts = { ...rehydrateArtifactMap(pending?.artifacts ?? {}), ...state.artifacts }
      const artifactVersions = {
        ...rehydrateVersionMap(pending?.artifactVersions ?? {}),
        ...state.artifactVersions,
      }
      if (retained) {
        for (const [id, artifact] of Object.entries(retained.snapshot.artifacts)) {
          if (changedIds.has(id)) continue
          artifacts[id] = artifact
          artifactVersions[id] = retained.snapshot.versions[id] ?? []
        }
        for (const id of retained.deletedIds) {
          if (!changedIds.has(id)) deletedIds.add(id)
        }
      }
      for (const id of deletedIds) {
        delete artifacts[id]
        delete artifactVersions[id]
      }
      return { artifacts, artifactVersions }
    })
  }

  const memory = useArtifactStore.getState()
  const memoryArtifacts = memory.artifacts
  const memoryVersions = memory.artifactVersions

  const versionsByArtifact = new Map<string, ArtifactVersion[]>()
  for (const row of versionRows) {
    const list = versionsByArtifact.get(row.artifactId) ?? []
    list.push(artifactVersionFromRow(row))
    versionsByArtifact.set(row.artifactId, list)
  }
  for (const list of versionsByArtifact.values()) {
    list.sort((a, b) => a.version - b.version)
  }

  const artifactPatch: Record<string, Artifact> = {}
  const deletedArtifacts: Record<string, Artifact> = {}
  const versionPatch: Record<string, ArtifactVersion[]> = {}
  const primedVersionIds = new Set<string>()
  for (const row of artifactRows) {
    if (deletedIds.has(row.id)) {
      // A deletion during the read wins over the database row, but the row
      // remains in the committed baseline so the first write removes it.
      deletedArtifacts[row.id] = artifactFromRow(row)
      for (const version of versionsByArtifact.get(row.id) ?? []) primedVersionIds.add(version.id)
      continue
    }
    if (memoryArtifacts[row.id]) continue // memory wins
    const artifact = artifactFromRow(row)
    artifactPatch[row.id] = artifact
    const versions = versionsByArtifact.get(row.id)
    if (versions && !memoryVersions[row.id]) {
      versionPatch[row.id] = versions
      for (const version of versions) primedVersionIds.add(version.id)
    }
  }

  if (Object.keys(artifactPatch).length > 0 || Object.keys(versionPatch).length > 0) {
    useArtifactStore.setState((state) => ({
      artifacts: { ...artifactPatch, ...state.artifacts },
      artifactVersions: { ...versionPatch, ...state.artifactVersions },
    }))
  }

  return { artifacts: { ...artifactPatch, ...deletedArtifacts }, versionIds: primedVersionIds }
}

/**
 * Start the bridge. Idempotent; the returned disposer flushes any pending
 * write and lets a later call start a fresh mirror — which is how an account
 * switch is handled (`CanvasBridgeProvider` re-runs this per account).
 */
export function startArtifactDexieBridge(): () => void {
  if (activeBridge || typeof window === "undefined") return () => {}

  const db = getDb()
  const scope = getArtifactMigrationScope()
  const queueKey = JSON.stringify([db.name, scope])
  let pending = capturePendingArtifactMigration(scope)
  const predecessor = previousWrites.get(queueKey) ?? Promise.resolve()
  let disposed = false
  let unsubscribe: () => void = () => {}
  let mirroredArtifacts: Record<string, Artifact> = {}
  let mirroredVersionIds = new Set<string>()
  let migrationCompleted = false
  let hydrated = false
  const deletedIds = new Set<string>()
  const changedIds = new Set<string>()
  let retained: RetainedArtifactWrite | undefined
  let retryDelay = ARTIFACT_SYNC_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let queued: ArtifactSnapshot | null = null
  const initial = useArtifactStore.getState()
  let lastSeenArtifacts = initial.artifacts
  let lastSeenVersions = initial.artifactVersions

  const retain = (snapshot: ArtifactSnapshot) => {
    retained = {
      snapshot,
      deletedIds: new Set([
        ...[...deletedIds].filter((id) => !snapshot.artifacts[id]),
        ...Object.keys(pending?.artifacts ?? {}).filter((id) => !snapshot.artifacts[id]),
        ...Object.keys(mirroredArtifacts).filter((id) => !snapshot.artifacts[id]),
      ]),
    }
    retainedWrites.set(queueKey, retained)
  }

  const ownsCurrentScope = () => {
    try {
      return getDb().name === db.name && getArtifactMigrationScope() === scope
    } catch {
      // An account can be locked between scheduling a write and starting it.
      return false
    }
  }
  const canApply = () => !disposed && activeBridge === bridge && ownsCurrentScope()
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const schedule = (delay: number) => {
    clearTimer()
    timer = setTimeout(flush, delay)
  }

  // There is only one writer per bridge. Diff computation and both mirror
  // updates belong to the same queue, so a later deletion sees an earlier add
  // only AFTER that add committed. Edits during a write replace the pending
  // snapshot instead of adding one transaction per keystroke.
  const drain = (): Promise<void> => {
    if (inFlight) return inFlight
    const write: Promise<void> = Promise.resolve()
      .then(async () => {
        while (queued) {
          if (!ownsCurrentScope()) {
            retain(queued)
            queued = null
            return
          }
          clearTimer()
          const snapshot = queued
          queued = null
          const diff = diffArtifactMirror(
            mirroredArtifacts,
            mirroredVersionIds,
            snapshot.artifacts,
            snapshot.versions
          )
          try {
            if (
              diff.removedArtifactIds.length ||
              diff.artifactUpserts.length ||
              diff.removedVersionIds.length ||
              diff.versionUpserts.length
            ) {
              await db.transaction("rw", db.artifacts, db.artifactVersions, async () => {
                for (const id of diff.removedArtifactIds) {
                  await db.artifactVersions.where("artifactId").equals(id).delete()
                  await db.artifacts.delete(id)
                }
                if (diff.artifactUpserts.length) await db.artifacts.bulkPut(diff.artifactUpserts)
                if (diff.removedVersionIds.length)
                  await db.artifactVersions.bulkDelete(diff.removedVersionIds)
                if (diff.versionUpserts.length)
                  await db.artifactVersions.bulkPut(diff.versionUpserts)
              })
            }
          } catch (err) {
            // Keep the newest snapshot and the last COMMITTED baseline. Retrying
            // needs no further user edit, and backoff avoids a quota-error loop.
            queued ??= snapshot
            retain(queued)
            loggers.canvas.warn("artifact dexie-bridge sync failed", { err: String(err) })
            if (canApply()) {
              schedule(retryDelay)
              retryDelay = Math.min(retryDelay * 2, 30_000)
            }
            return
          }
          mirroredArtifacts = snapshot.artifacts
          mirroredVersionIds = diff.seenVersionIds
          retryDelay = ARTIFACT_SYNC_DEBOUNCE_MS
          if (!queued && retainedWrites.get(queueKey) === retained) retainedWrites.delete(queueKey)
          if (!queued) {
            // Cleanup is scoped to the committed database even if the account
            // changed during its transaction. Only the live store's marker
            // requires the active lifecycle guard.
            if (pending) clearPendingArtifactMigration(scope)
            if (canApply() && !migrationCompleted) {
              migrationCompleted = true
              completeArtifactDexieMigration()
            }
          }
        }
      })
      .finally(() => {
        inFlight = null
        if (previousWrites.get(queueKey) === write) previousWrites.delete(queueKey)
      })
    inFlight = write
    previousWrites.set(queueKey, write)
    return write
  }

  function flush() {
    clearTimer()
    if (queued) void drain()
  }

  const dispose = (flushPending: boolean) => {
    if (disposed) return
    disposed = true
    unsubscribe()
    clearTimer()
    window.removeEventListener("pagehide", flush)
    if (flushPending && !hydrated && changedIds.size) {
      retain({ artifacts: lastSeenArtifacts, versions: lastSeenVersions })
    }
    if (flushPending) flush()
    else queued = null
    if (activeBridge === bridge) activeBridge = null
  }
  const bridge = { dispose: () => dispose(true), cancel: () => dispose(false) }
  activeBridge = bridge

  // Subscribe before the database read so a user's delete cannot be mistaken
  // for an artifact that simply has not loaded yet.
  unsubscribe = useArtifactStore.subscribe((state) => {
    if (!canApply()) return
    if (state.artifacts === lastSeenArtifacts && state.artifactVersions === lastSeenVersions) return
    if (!hydrated) {
      const ids = new Set([...Object.keys(lastSeenArtifacts), ...Object.keys(state.artifacts)])
      for (const id of ids) {
        if (
          lastSeenArtifacts[id] === state.artifacts[id] &&
          lastSeenVersions[id] === state.artifactVersions[id]
        )
          continue
        changedIds.add(id)
        if (state.artifacts[id]) deletedIds.delete(id)
        else deletedIds.add(id)
      }
    }
    lastSeenArtifacts = state.artifacts
    lastSeenVersions = state.artifactVersions
    if (!hydrated) return
    queued = { artifacts: state.artifacts, versions: state.artifactVersions }
    schedule(ARTIFACT_SYNC_DEBOUNCE_MS)
  })

  void predecessor
    .then(async () => {
      if (!canApply()) return
      // The previous instance may have completed migration while we waited.
      pending = capturePendingArtifactMigration(scope)
      retained = retainedWrites.get(queueKey)
      const mirror = await hydrateFromDexie(db, pending, canApply, deletedIds, changedIds, retained)
      if (!mirror || !canApply()) return
      mirroredArtifacts = mirror.artifacts
      mirroredVersionIds = mirror.versionIds
      hydrated = true
      const initial = useArtifactStore.getState()
      window.addEventListener("pagehide", flush)
      queued = { artifacts: initial.artifacts, versions: initial.artifactVersions }
      flush()
    })
    .catch((err) => {
      unsubscribe()
      // An incomplete hydration must never turn an unknown subset into deletes.
      loggers.canvas.warn("artifact dexie-bridge hydration failed; mirror disabled", {
        err: String(err),
      })
    })

  return bridge.dispose
}
