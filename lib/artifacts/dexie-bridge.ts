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
  type PendingArtifactMigration,
} from "@/lib/artifacts/localstorage-migration"
import { loggers } from "@cognia/logging"

/**
 * How long a burst of edits may accumulate before it reaches Dexie. An
 * artifact edit arrives per keystroke while the review pane is open; one
 * transaction per keystroke is what this batch exists to remove.
 */
export const ARTIFACT_SYNC_DEBOUNCE_MS = 500

let started = false
let flushArtifactSync: (() => void) | null = null
let mirroredArtifacts: Record<string, Artifact> = {}
let mirroredVersionIds = new Set<string>()
let mirroredDbName: string | null = null

/** Test-only: drop the module-level mirror so suites don't leak into each other. */
export function __resetArtifactDexieBridgeForTesting(): void {
  started = false
  flushArtifactSync = null
  mirroredArtifacts = {}
  mirroredVersionIds = new Set()
  mirroredDbName = null
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
 * Push the store's artifacts into Dexie.
 *
 * Answers whether the mirror may now be advanced to `next`. `false` means the
 * write was refused, so the caller must NOT record `next` as the new baseline —
 * doing so would claim rows were persisted that never were, and the next diff
 * against that baseline would skip them.
 */
async function syncArtifacts(
  next: Record<string, Artifact>,
  nextVersions: Record<string, ArtifactVersion[]>
): Promise<boolean> {
  const db = getDb()
  // Rule 1 — see the module docstring. The mirror describes one database; a
  // different one means the account changed under us and the provider is about
  // to restart the bridge.
  if (mirroredDbName !== null && db.name !== mirroredDbName) return false

  const diff = diffArtifactMirror(mirroredArtifacts, mirroredVersionIds, next, nextVersions)
  if (
    diff.removedArtifactIds.length === 0 &&
    diff.artifactUpserts.length === 0 &&
    diff.removedVersionIds.length === 0 &&
    diff.versionUpserts.length === 0
  ) {
    // Nothing to write, and the mirror already describes this database — so
    // `next` is a legitimate baseline.
    return true
  }

  await db.transaction("rw", db.artifacts, db.artifactVersions, async () => {
    for (const id of diff.removedArtifactIds) {
      await db.artifactVersions.where("artifactId").equals(id).delete()
      await db.artifacts.delete(id)
    }
    if (diff.artifactUpserts.length > 0) await db.artifacts.bulkPut(diff.artifactUpserts)
    if (diff.removedVersionIds.length > 0) {
      await db.artifactVersions.bulkDelete(diff.removedVersionIds)
    }
    if (diff.versionUpserts.length > 0) await db.artifactVersions.bulkPut(diff.versionUpserts)
  })

  mirroredVersionIds = diff.seenVersionIds
  return true
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
async function hydrateFromDexie(pending: PendingArtifactMigration | null): Promise<void> {
  const db = getDb()
  const [artifactRows, versionRows] = await Promise.all([
    db.artifacts.toArray(),
    db.artifactVersions.toArray(),
  ])

  // Rows a previous, interrupted migration parked but never wrote. Restoring
  // them BEFORE the Dexie read is compared against memory means they take the
  // same "memory wins" path as anything the store rehydrated itself, and the
  // initial sync then carries them into Dexie.
  if (pending) {
    useArtifactStore.setState((state) => ({
      artifacts: { ...rehydrateArtifactMap(pending.artifacts), ...state.artifacts },
      artifactVersions: {
        ...rehydrateVersionMap(pending.artifactVersions),
        ...state.artifactVersions,
      },
    }))
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
  const versionPatch: Record<string, ArtifactVersion[]> = {}
  const primedVersionIds = new Set<string>()
  for (const row of artifactRows) {
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

  mirroredArtifacts = { ...artifactPatch }
  mirroredVersionIds = primedVersionIds
  mirroredDbName = db.name
}

/**
 * Start the bridge. Idempotent; the returned disposer flushes any pending
 * write and lets a later call start a fresh mirror — which is how an account
 * switch is handled (`CanvasBridgeProvider` re-runs this per account).
 */
export function startArtifactDexieBridge(): () => void {
  if (started || typeof window === "undefined") return () => {}
  started = true

  let unsubscribe: () => void = () => {}
  let disposed = false

  // Synchronous, and first: keep the replay copy as an extra recovery path for
  // a blob left behind by an interrupted migration. The store also retains the
  // original maps while its migration marker is set.
  const pending = capturePendingArtifactMigration()

  void hydrateFromDexie(pending)
    .then(() => {
      if (disposed) return
      const initial = useArtifactStore.getState()
      void syncArtifacts(initial.artifacts, initial.artifactVersions)
        .then((applied) => {
          // `disposed` because the disposer clears the mirror synchronously and
          // a late landing would repopulate it with THIS account's artifacts;
          // `applied` because a write the db-name guard refused never happened.
          if (disposed || !applied) return
          mirroredArtifacts = { ...initial.artifacts }
          completeArtifactDexieMigration()
          // The rows are in Dexie now, so the parked copy has done its job.
          if (pending) clearPendingArtifactMigration()
        })
        .catch((err) =>
          loggers.canvas.warn("artifact dexie-bridge initial sync failed", {
            err: String(err),
          })
        )

      let lastSeenArtifacts = initial.artifacts
      let lastSeenVersions = initial.artifactVersions
      // Named for the timer, not the migration: an outer `pending` holds the
      // parked migration, and shadowing it here left the parked copy in
      // localStorage forever.
      let pendingTimer: ReturnType<typeof setTimeout> | null = null
      let queued: {
        artifacts: Record<string, Artifact>
        versions: Record<string, ArtifactVersion[]>
      } | null = null

      const run = () => {
        pendingTimer = null
        const snapshot = queued
        queued = null
        if (!snapshot) return
        void syncArtifacts(snapshot.artifacts, snapshot.versions)
          .then((applied) => {
            if (disposed || !applied) return
            mirroredArtifacts = { ...snapshot.artifacts }
          })
          .catch((err) =>
            loggers.canvas.warn("artifact dexie-bridge sync failed", { err: String(err) })
          )
      }

      flushArtifactSync = () => {
        if (pendingTimer !== null) {
          clearTimeout(pendingTimer)
          run()
        }
      }

      // The subscription is unselected — it fires on every artifact-store
      // write, canvas edits included. Bail on identity before doing any work.
      unsubscribe = useArtifactStore.subscribe((state) => {
        if (state.artifacts === lastSeenArtifacts && state.artifactVersions === lastSeenVersions) {
          return
        }
        lastSeenArtifacts = state.artifacts
        lastSeenVersions = state.artifactVersions
        queued = { artifacts: state.artifacts, versions: state.artifactVersions }
        if (pendingTimer !== null) clearTimeout(pendingTimer)
        pendingTimer = setTimeout(run, ARTIFACT_SYNC_DEBOUNCE_MS)
      })

      window.addEventListener("pagehide", flushArtifactSync)
    })
    .catch((err) => {
      // Rule 2 — see the module docstring. No mirror, no deletes.
      loggers.canvas.warn("artifact dexie-bridge hydration failed; mirror disabled", {
        err: String(err),
      })
    })

  return () => {
    disposed = true
    flushArtifactSync?.()
    if (flushArtifactSync) window.removeEventListener("pagehide", flushArtifactSync)
    flushArtifactSync = null
    unsubscribe()
    mirroredArtifacts = {}
    mirroredVersionIds = new Set()
    mirroredDbName = null
    started = false
  }
}
