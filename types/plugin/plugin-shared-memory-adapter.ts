/**
 * Plugin Shared-Memory Adapter contract (`shared-memory-adapter` capability).
 *
 * A team opts into a single adapter via `team.config.sharedMemoryAdapterId`.
 * The Zustand store stays the primary source of truth; the adapter is a
 * bidirectional *mirror*:
 *   - `write` / `delete` are fired (fire-and-forget) after a local store
 *     mutation so the external store stays in sync.
 *   - `listChanges` is pulled on demand (workspace open / "Sync now") to
 *     backfill entries the local store is missing or has an older version of.
 *     Conflict resolution is local-version-wins.
 *
 * Adapter methods are async and may fail; callers isolate failures (a failed
 * mirror write logs but never blocks the local write).
 */

import type { SharedMemoryEntry } from "@/types/agent/agent-team"
import type { PluginIconName } from "./plugin-icon"

export interface SharedMemoryAdapterChangeSet {
  /** Remote entries changed since the requested cursor. */
  entries: SharedMemoryEntry[]
  /** Opaque monotonic cursor the caller persists for the next pull. */
  cursor: number
}

export interface PluginSharedMemoryAdapterDef {
  /** Stable id (e.g. `<pluginId>:<adapter>`). */
  id: string
  /** Human-readable name surfaced in the Memory adapter picker. */
  name: string
  description?: string
  /** Optional lucide icon name for the picker. */
  icon?: PluginIconName
  /** Mirror a single entry write to the external store. */
  write(teamId: string, entry: SharedMemoryEntry): Promise<void>
  /** Read a single entry back from the external store. */
  read(teamId: string, key: string): Promise<SharedMemoryEntry | undefined>
  /**
   * Return entries changed since `sinceVersion` (undefined = full snapshot)
   * plus a cursor for the next incremental pull.
   */
  listChanges(teamId: string, sinceVersion?: number): Promise<SharedMemoryAdapterChangeSet>
  /** Mirror a single entry deletion to the external store. */
  delete(teamId: string, key: string): Promise<void>
  /** Optional: clear the whole team namespace in the external store. */
  clear?(teamId: string): Promise<void>
}
