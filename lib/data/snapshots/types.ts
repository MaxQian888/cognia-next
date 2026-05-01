// Local-storage snapshot types.
//
// Cognia persists ~12 user-facing stores via Zustand `persist` into
// `localStorage` (external agents, custom modes, custom themes, agent teams,
// canvas keybindings, etc.). The Dexie-only backup pipeline misses all of
// them. The snapshot abstraction wraps each persist key in a uniform module
// so `lib/data/build-package.ts` and `lib/data/apply-package.ts` can carry
// them through the v3 envelope without touching `localStorage` directly.
//
// The on-disk shape preserves Zustand's native `{state, version}` envelope
// verbatim so that on import we can `setItem` it back unchanged and let
// Zustand's own `migrate` handle any cross-version drift — no second
// migration matrix to maintain here.

import type { ImportMergeStrategy } from "./../types"

/** Snapshot format version emitted by these modules. Independent of any
 * single store's `persist.version`; bump only when this wrapper shape
 * changes (almost never). */
export const SNAPSHOT_FORMAT_VERSION = 1 as const

export interface LocalStorageSnapshot<T = unknown> {
  /** The Zustand persist `name` (e.g. "cognia-external-agents"). */
  key: string
  /** The Zustand persist `version` we read from this store. */
  storeVersion: number
  /** Wrapper schema version — see {@link SNAPSHOT_FORMAT_VERSION}. */
  snapshotFormatVersion: typeof SNAPSHOT_FORMAT_VERSION
  /** Raw envelope from `localStorage.getItem(key)` parsed as JSON. We keep
   * `state` + `version` together so re-emitting the JSON round-trips with
   * Zustand's expectations. */
  raw: { state: T; version: number }
  /** ISO-8601 timestamp of when the snapshot was captured. Debugging only —
   * not load-bearing for replay. */
  capturedAt: string
}

/** Tiny abstraction over `localStorage` so we can mock it in unit tests and
 * tolerate non-browser execution (Node-only build hosts, SSR, etc.). */
export interface SnapshotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Environment passed to read/write so the modules don't reach into
 * `globalThis.localStorage` directly. */
export interface SnapshotEnv {
  storage: SnapshotStorage
  /** Optional rehydrate hook (for Zustand). When the store is bound to a
   * running app instance we call this after a write so the in-memory state
   * follows the disk. Tests typically pass a no-op. */
  rehydrate?: () => Promise<void> | void
  /** Optional logger sink for size/parse warnings. Defaults to a no-op so
   * tests don't have to silence console noise. */
  warn?: (message: string, context?: Record<string, unknown>) => void
}

export interface SnapshotModule<T = unknown> {
  /** The persist `name` this module owns (must be unique across registry). */
  readonly key: string
  /** A short label key used by the UI under
   * `settings.data.snapshots.<labelKey>.title`. */
  readonly labelKey: string
  /** Whether this snapshot is exposed as a standalone domain in
   * `DOMAIN_TRANSFERS`. UI-only stores (window/scratchpad layout) opt out. */
  readonly exposeAsDomain: boolean
  /** Read the current state from `env.storage`. Returns `null` when the key
   * is absent or unreadable — never throws. */
  read(env: SnapshotEnv): LocalStorageSnapshot<T> | null
  /** Write the snapshot back into `env.storage` under the chosen merge
   * strategy. Idempotent: same input twice yields the same on-disk state. */
  write(snap: LocalStorageSnapshot<T>, strategy: ImportMergeStrategy, env: SnapshotEnv): void
  /** Optional cross-version normalizer. Called *only* when the incoming
   * `snap.storeVersion` doesn't match the store's current persist version.
   * Default: identity (let Zustand's own `migrate` handle it). */
  migrate?(snap: LocalStorageSnapshot<T>, currentStoreVersion: number): LocalStorageSnapshot<T>
}

// ---- Helpers --------------------------------------------------------------

/** Soft-parse a Zustand persist envelope. Returns null on any structural
 * problem. We never throw out of `read()` so a single corrupt key can't
 * brick the whole backup. */
export function parsePersistEnvelope<T = unknown>(
  raw: string
): { state: T; version: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as { state?: unknown; version?: unknown }
    if (!("state" in obj) || typeof obj.version !== "number") return null
    return { state: obj.state as T, version: obj.version }
  } catch {
    return null
  }
}

/** Build a fresh snapshot from a parsed envelope. */
export function makeSnapshot<T>(
  key: string,
  envelope: { state: T; version: number }
): LocalStorageSnapshot<T> {
  return {
    key,
    storeVersion: envelope.version,
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    raw: envelope,
    capturedAt: new Date().toISOString(),
  }
}

/** Detect a `LocalStorageSnapshot` shape at runtime — used by the importer to
 * filter rogue payload entries before re-applying. */
export function isLocalStorageSnapshot(input: unknown): input is LocalStorageSnapshot {
  if (!input || typeof input !== "object") return false
  const obj = input as Partial<LocalStorageSnapshot>
  return (
    typeof obj.key === "string" &&
    typeof obj.storeVersion === "number" &&
    obj.snapshotFormatVersion === SNAPSHOT_FORMAT_VERSION &&
    !!obj.raw &&
    typeof obj.raw === "object" &&
    "state" in obj.raw &&
    typeof (obj.raw as { version?: unknown }).version === "number" &&
    typeof obj.capturedAt === "string"
  )
}
