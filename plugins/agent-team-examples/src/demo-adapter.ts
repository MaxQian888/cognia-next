/**
 * In-memory demo shared-memory adapter for the agent-team-examples plugin.
 *
 * Demonstrates the bidirectional `PluginSharedMemoryAdapterDef` contract end
 * to end (write / read / listChanges / delete) without any external service.
 * Storage is process-local and volatile — a real adapter would back this with
 * a remote store (GitHub Issue, Lark Wiki, sqlite, …). The orchestrator's
 * mirror writes and `syncSharedMemoryFromAdapter` reverse-pull both exercise
 * this adapter when a team selects it.
 */

import type {
  PluginSharedMemoryAdapterDef,
  SharedMemoryAdapterChangeSet,
} from "@/types/plugin/plugin-shared-memory-adapter"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

const ADAPTER_ID = "cognia-agent-team-examples:in-memory"

// teamId → key → entry
const store = new Map<string, Map<string, SharedMemoryEntry>>()

function teamMap(teamId: string): Map<string, SharedMemoryEntry> {
  let m = store.get(teamId)
  if (!m) {
    m = new Map()
    store.set(teamId, m)
  }
  return m
}

export const demoSharedMemoryAdapter: PluginSharedMemoryAdapterDef = {
  id: ADAPTER_ID,
  name: "In-Memory (demo)",
  description: "Volatile, process-local mirror demonstrating the adapter contract.",
  icon: "database",
  async write(teamId, entry) {
    teamMap(teamId).set(entry.key, entry)
  },
  async read(teamId, key) {
    return teamMap(teamId).get(key)
  },
  async listChanges(teamId, sinceVersion): Promise<SharedMemoryAdapterChangeSet> {
    const entries = Array.from(teamMap(teamId).values()).filter((e) =>
      sinceVersion === undefined ? true : e.version > sinceVersion
    )
    const cursor = entries.reduce((max, e) => Math.max(max, e.version), sinceVersion ?? 0)
    return { entries, cursor }
  },
  async delete(teamId, key) {
    teamMap(teamId).delete(key)
  },
  async clear(teamId) {
    store.delete(teamId)
  },
}

/** Test-only: wipe the demo store. */
export function __resetDemoAdapterForTesting(): void {
  store.clear()
}
