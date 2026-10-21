/**
 * The plugin contract's share of `lib/data/snapshots/types.ts`, which re-exports these.
 */
import type { SNAPSHOT_FORMAT_VERSION } from "@/lib/data/snapshots/types"

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
