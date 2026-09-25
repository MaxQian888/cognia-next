/**
 * In-memory example shared-memory adapter for the agent-team-examples plugin.
 *
 * Demonstrates the bidirectional `PluginSharedMemoryAdapterDef` contract end
 * to end (write / read / listChanges / delete / clear) without any external
 * service. Storage is per adapter instance, process-local and volatile — a
 * real adapter would back this with a remote store (GitHub Issue, Lark Wiki,
 * sqlite, …). The orchestrator's mirror writes and
 * `syncSharedMemoryFromAdapter` reverse-pull both exercise this adapter when a
 * team selects it.
 *
 * Built by a factory so every caller (the manifest, each test) owns its own
 * store: there is no module-level state for a test to reach in and reset.
 */

import {
  defineSharedMemoryAdapter,
  type PluginSharedMemoryAdapterDef,
  type SharedMemoryAdapterChangeSet,
  type SharedMemoryEntry,
} from "@cognia/plugin-sdk"

export const DEMO_SHARED_MEMORY_ADAPTER_ID = "cognia-agent-team-examples:in-memory"

export function createDemoSharedMemoryAdapter(): PluginSharedMemoryAdapterDef {
  // teamId → key → entry
  const store = new Map<string, Map<string, SharedMemoryEntry>>()

  const teamMap = (teamId: string): Map<string, SharedMemoryEntry> => {
    let entries = store.get(teamId)
    if (!entries) {
      entries = new Map()
      store.set(teamId, entries)
    }
    return entries
  }

  return defineSharedMemoryAdapter({
    id: DEMO_SHARED_MEMORY_ADAPTER_ID,
    name: "In-Memory (example)",
    description:
      "Example adapter: a volatile, process-local mirror that demonstrates the adapter contract. Entries are lost on reload.",
    icon: "Database",
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
  })
}

/** The instance the plugin manifest contributes. */
export const demoSharedMemoryAdapter = createDemoSharedMemoryAdapter()
