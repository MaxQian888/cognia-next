// Pure helpers for reading/writing many `LocalStorageSnapshot`s at once.
//
// `apply-package.ts` runs Dexie writes inside a transaction, then — only on
// commit — calls `writeAllSnapshots` here. If anything past that point fails
// we use `restoreFromPreSnap` (whose input was captured *before* the Dexie
// transaction) to roll the localStorage face back to its pre-import state.
//
// All helpers are side-effect-free except for the `env.storage.setItem`
// calls; tests pass a fake `SnapshotStorage` and assert on the resulting
// internal map.

import type { ImportMergeStrategy } from "./../types"
import type { LocalStorageSnapshot, SnapshotEnv, SnapshotModule, SnapshotStorage } from "./types"

export interface ReadAllResult {
  /** Snapshots successfully captured, keyed by persist name. */
  snapshots: Record<string, LocalStorageSnapshot>
  /** Modules whose `read()` returned `null` (key missing or unreadable). */
  missing: string[]
}

/** Capture every registered module's current state. Never throws. */
export function readAllSnapshots(
  modules: ReadonlyArray<SnapshotModule>,
  env: SnapshotEnv
): ReadAllResult {
  const snapshots: Record<string, LocalStorageSnapshot> = {}
  const missing: string[] = []
  for (const mod of modules) {
    try {
      const snap = mod.read(env)
      if (snap) {
        snapshots[mod.key] = snap
      } else {
        missing.push(mod.key)
      }
    } catch (err) {
      env.warn?.(`snapshot.read failed for ${mod.key}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      missing.push(mod.key)
    }
  }
  return { snapshots, missing }
}

export interface WriteAllResult {
  written: string[]
  skipped: string[]
  errors: { key: string; error: string }[]
}

/** Apply a payload of snapshots through every matching registered module.
 * Snapshot entries with no corresponding module are silently skipped (this
 * happens when an old build receives a backup written by a newer one with
 * extra stores). */
export function writeAllSnapshots(
  modules: ReadonlyArray<SnapshotModule>,
  payload: Record<string, LocalStorageSnapshot>,
  strategy: ImportMergeStrategy,
  env: SnapshotEnv
): WriteAllResult {
  const written: string[] = []
  const skipped: string[] = []
  const errors: { key: string; error: string }[] = []
  const byKey = new Map<string, SnapshotModule>(modules.map((m) => [m.key, m]))
  for (const [key, snap] of Object.entries(payload)) {
    const mod = byKey.get(key)
    if (!mod) {
      skipped.push(key)
      continue
    }
    try {
      mod.write(snap, strategy, env)
      written.push(key)
    } catch (err) {
      errors.push({ key, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { written, skipped, errors }
}

/** Restore the full pre-import snapshot face. Used on apply failure to undo
 * any partial localStorage writes — Dexie rolls itself back via transaction
 * abort, but localStorage doesn't have transactions, so we replay the
 * snapshot we captured up front.
 *
 * `removeMissingKeys = true` (the default) also wipes any keys that exist
 * now but didn't exist pre-import — handles the case where the user had no
 * persisted state for a store before the failed import added one. */
export function restoreFromPreSnap(
  modules: ReadonlyArray<SnapshotModule>,
  preSnap: Record<string, LocalStorageSnapshot>,
  env: SnapshotEnv,
  removeMissingKeys = true
): { restored: string[]; cleared: string[] } {
  const restored: string[] = []
  const cleared: string[] = []
  for (const mod of modules) {
    const prev = preSnap[mod.key]
    if (prev) {
      try {
        // Restore ALWAYS overwrites — we want the key in lockstep with
        // pre-import state, regardless of the user's chosen merge strategy.
        mod.write(prev, "overwrite", env)
        restored.push(mod.key)
      } catch (err) {
        env.warn?.(`snapshot.restore failed for ${mod.key}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }
    if (removeMissingKeys) {
      try {
        env.storage.removeItem(mod.key)
        cleared.push(mod.key)
      } catch (err) {
        env.warn?.(`snapshot.clear failed for ${mod.key}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  return { restored, cleared }
}

/** Drive every module's optional `migrate()` hook over a payload before
 * writing. Returns a new payload (input not mutated). */
export function migrateAllSnapshots(
  modules: ReadonlyArray<SnapshotModule>,
  payload: Record<string, LocalStorageSnapshot>,
  currentVersions: Record<string, number>
): Record<string, LocalStorageSnapshot> {
  const out: Record<string, LocalStorageSnapshot> = {}
  const byKey = new Map<string, SnapshotModule>(modules.map((m) => [m.key, m]))
  for (const [key, snap] of Object.entries(payload)) {
    const mod = byKey.get(key)
    const target = currentVersions[key]
    if (mod?.migrate && typeof target === "number" && target !== snap.storeVersion) {
      out[key] = mod.migrate(snap, target)
    } else {
      out[key] = snap
    }
  }
  return out
}

/** Build an in-memory `SnapshotStorage` for tests. Backed by a `Map`. */
export function createMemoryStorage(initial?: Record<string, string>): {
  storage: SnapshotStorage
  data: Map<string, string>
} {
  const data = new Map<string, string>(initial ? Object.entries(initial) : [])
  const storage: SnapshotStorage = {
    getItem(key) {
      return data.has(key) ? (data.get(key) ?? null) : null
    },
    setItem(key, value) {
      data.set(key, value)
    },
    removeItem(key) {
      data.delete(key)
    },
  }
  return { storage, data }
}
