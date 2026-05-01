// Factory that produces a `SnapshotModule` for the common case: a Zustand
// `persist` store keyed by name in `localStorage`, whose envelope shape is
// `{ state, version }`.
//
// Modules with extra needs (Date revival, size warnings, custom merge under
// `skip`) compose this factory's output and then add what they need.

import type { ImportMergeStrategy } from "./../types"
import {
  isLocalStorageSnapshot,
  makeSnapshot,
  parsePersistEnvelope,
  type LocalStorageSnapshot,
  type SnapshotModule,
} from "./types"

export interface GenericSnapshotOptions<T = unknown> {
  /** Zustand persist `name`. */
  key: string
  /** UI label key under `settings.data.snapshots.<labelKey>.title`. */
  labelKey: string
  /** When true, exposed as a standalone domain in `DOMAIN_TRANSFERS`. */
  exposeAsDomain: boolean
  /** Optional state-level transform applied right before write. Useful for
   * dropping derived fields, masking secrets, etc. The default is the
   * identity. */
  prepareState?: (state: T) => T
  /** Optional max byte size for the serialized envelope. When the snapshot
   * exceeds this, `read()` calls `env.warn` but still emits the snapshot —
   * we never silently lose data. */
  maxBytesWarn?: number
  /** Optional cross-version normalizer. Default: identity. */
  migrate?: (snap: LocalStorageSnapshot<T>, currentStoreVersion: number) => LocalStorageSnapshot<T>
}

export function createGenericSnapshotModule<T = unknown>(
  opts: GenericSnapshotOptions<T>
): SnapshotModule<T> {
  const { key, labelKey, exposeAsDomain, prepareState, maxBytesWarn, migrate } = opts

  return {
    key,
    labelKey,
    exposeAsDomain,
    read(env) {
      let raw: string | null
      try {
        raw = env.storage.getItem(key)
      } catch {
        return null
      }
      if (!raw) return null
      const envelope = parsePersistEnvelope<T>(raw)
      if (!envelope) {
        env.warn?.(`snapshot.parse: ${key} corrupt envelope`, { length: raw.length })
        return null
      }
      const transformed = prepareState
        ? { state: prepareState(envelope.state), version: envelope.version }
        : envelope
      const snap = makeSnapshot(key, transformed)
      if (maxBytesWarn && raw.length > maxBytesWarn) {
        env.warn?.(`snapshot.size: ${key} exceeds ${maxBytesWarn}B`, {
          bytes: raw.length,
        })
      }
      return snap
    },
    write(snap, strategy, env) {
      if (!isLocalStorageSnapshot(snap) || snap.key !== key) {
        // Defensive: silently ignore mis-keyed payload entries rather than
        // crashing apply. Caller already filtered by key, so this is a no-op
        // in practice.
        return
      }
      let existing: string | null = null
      try {
        existing = env.storage.getItem(key)
      } catch {
        existing = null
      }
      const value = JSON.stringify(snap.raw)
      if (existing && strategy === "skip") return
      if (existing && strategy === "duplicate") {
        // For Zustand stores there is no "duplicate row" concept — the key
        // is the entire face. Treat duplicate as overwrite (matches
        // `applyKeyedCollection` behavior for natural-key Dexie tables).
        env.storage.setItem(key, value)
        return
      }
      env.storage.setItem(key, value)
    },
    migrate,
  }
}

/** Helper exported for advanced modules that want to keep `prepare/migrate`
 * but layer a custom `read` (e.g. inflate Date objects out of strings). */
export function applyMergeStrategy(
  existing: string | null,
  next: string,
  strategy: ImportMergeStrategy
): string | null {
  if (existing && strategy === "skip") return existing
  return next
}
