"use client"

/**
 * Crash-safe hand-off of the artifacts that used to live inside the
 * `cognia-artifacts` Zustand persist blob (schema v206, ADR-0158).
 *
 * The store rehydrates the legacy blob into memory on boot and retains those
 * maps while its migration marker is set. This helper also parks a replay copy
 * before Dexie access, allowing recovery from a blob already cleaned by an
 * interrupted earlier migration attempt.
 *
 * So the bridge parks a copy under {@link ARTIFACT_MIGRATION_PENDING_KEY}
 * BEFORE it touches Dexie, and clears it only once the write has landed. A boot
 * that finds the key still present replays it: the migration is idempotent and
 * survives being interrupted at any point.
 *
 * Only the ACTIVE persist bucket is read. Account buckets
 * (`cognia-artifacts:<localAccountId>`) belong to a different Dexie database, and
 * merging one into whichever database happens to be selected would leak another
 * account's artifacts into this one.
 */

import type { Artifact, ArtifactVersion } from "@/types/artifact/artifact"
import { ARTIFACT_STORAGE_KEY, useArtifactStore } from "@/stores/artifact/artifact-store"
import { loggers } from "@cognia/logging"

export const ARTIFACT_MIGRATION_PENDING_KEY = "cognia-artifacts:pending-migration"

export interface PendingArtifactMigration {
  /** Raw persisted shape — `Date` fields are ISO strings until rehydrated. */
  artifacts: Record<string, Artifact>
  artifactVersions: Record<string, ArtifactVersion[]>
}

function readJson(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {}
}

/** The persist bucket currently in use — the account-scoped one after sign-in. */
function activePersistKey(): string {
  const name = (
    useArtifactStore as unknown as { persist?: { getOptions?: () => { name?: string } } }
  ).persist?.getOptions?.().name
  return name ?? ARTIFACT_STORAGE_KEY
}

export function readPendingArtifactMigration(): PendingArtifactMigration | null {
  const parsed = readJson(ARTIFACT_MIGRATION_PENDING_KEY)
  if (!parsed) return null
  const artifacts = asRecord<Artifact>(parsed.artifacts)
  const artifactVersions = asRecord<ArtifactVersion[]>(parsed.artifactVersions)
  if (Object.keys(artifacts).length === 0 && Object.keys(artifactVersions).length === 0) return null
  return { artifacts, artifactVersions }
}

export function clearPendingArtifactMigration(): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(ARTIFACT_MIGRATION_PENDING_KEY)
}

/**
 * Park whatever the legacy blob still carries, and return everything now
 * awaiting a Dexie write — the freshly captured rows merged over any that a
 * previous, interrupted run left behind.
 *
 * Never throws: a quota-exceeded write here must not stop the bridge from
 * starting. It narrows the crash window rather than being load-bearing.
 */
export function capturePendingArtifactMigration(): PendingArtifactMigration | null {
  const existing = readPendingArtifactMigration()
  const blob = readJson(activePersistKey())
  const state = blob && typeof blob.state === "object" ? asRecord<unknown>(blob.state) : null
  const legacyArtifacts = asRecord<Artifact>(state?.artifacts)
  const legacyVersions = asRecord<ArtifactVersion[]>(state?.artifactVersions)

  if (Object.keys(legacyArtifacts).length === 0 && Object.keys(legacyVersions).length === 0) {
    return existing
  }

  // Anything already parked wins: it was captured from an older blob that the
  // current one may have truncated, and a re-run must not shrink the set.
  const merged: PendingArtifactMigration = {
    artifacts: { ...legacyArtifacts, ...(existing?.artifacts ?? {}) },
    artifactVersions: { ...legacyVersions, ...(existing?.artifactVersions ?? {}) },
  }

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(ARTIFACT_MIGRATION_PENDING_KEY, JSON.stringify(merged))
    } catch (err) {
      loggers.canvas.warn("could not park the legacy artifact blob for migration", {
        err: String(err),
      })
    }
  }
  return merged
}
