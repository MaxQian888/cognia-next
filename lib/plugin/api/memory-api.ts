/**
 * Plugin Memory API (`ctx.memory`) — lets plugins read and write the user's
 * autonomous long-term memory store (`lib/memory`, ADR-0069).
 *
 * Design:
 *  - Reads go through the shared external-search helper
 *    (`lib/memory/api/search-memory.ts`) / the `@/lib/db/memories` Dexie layer,
 *    honoring the user's `MemoryConfig` (`enabled` / `temporary` gates —
 *    blocked reads degrade to empty, matching how chat recall degrades).
 *  - Writes go through the shared external-write helpers
 *    (`lib/memory/api/store-memory.ts` / `mutate-memory.ts`): provenance is
 *    always `external` with `sourceChannel: "plugin"` + the plugin id stamped
 *    for the memory console; the PII gate is block-only (a typed
 *    `PluginPiiError` for plugin DX); `procedural` can never be created —
 *    plugins may not rewrite the agent's working instructions.
 *  - `forget` soft-invalidates (history preserved); hard deletes stay
 *    user-panel-only.
 *  - Gated by `memory:read` (reads) / `memory:write` (mutations).
 */

import type { Memory, MemoryScope, MemoryStatus, MemoryType } from "@/types/memory/memory"
import {
  storeExternalMemory,
  type StoreExternalMemoryInput,
  type StoreMemoryCoreResult,
} from "@/lib/memory/api/store-memory"
import { searchMemoriesExternal, type ExternalMemoryHit } from "@/lib/memory/api/search-memory"
import {
  updateExternalMemory,
  forgetExternalMemory,
  type MutateExternalMemoryResult,
  type UpdateExternalMemoryPatch,
} from "@/lib/memory/api/mutate-memory"
import { listMemories, getMemory, countActive } from "@/lib/db/memories"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { assertNoLeakingPii } from "./plugin-pii-gate"

export interface PluginMemorySearchOptions {
  /** Defaults to the user's configured `retrievalTopK`. */
  topK?: number
  types?: MemoryType[]
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
  /** Default true; false = don't bump lastAccessedAt/accessCount. */
  touch?: boolean
}

export interface PluginMemoryListFilter {
  type?: MemoryType
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  /** Defaults to `"active"`; pass `"invalidated"` to inspect history. */
  status?: MemoryStatus
  /** Newest-first cap, default 100. */
  limit?: number
}

export type PluginMemoryStoreInput = Omit<StoreExternalMemoryInput, "source">

/** Long-term memory API exposed to plugins. */
export interface PluginMemoryAPI {
  // --------------------------------------------------------------- reads
  /**
   * Hybrid (BM25 + vector) relevance search over active memories. Degrades to
   * `[]` when memory is disabled, temporary mode is on, or no backend exists.
   */
  search(query: string, opts?: PluginMemorySearchOptions): Promise<ExternalMemoryHit[]>
  /** Newest-first listing (no relevance ranking). Empty when memory is off. */
  list(filter?: PluginMemoryListFilter): Promise<Memory[]>
  /** Fetch one memory by id (undefined when missing or memory is off). */
  get(id: string): Promise<Memory | undefined>
  /** Count of active memories in a scope (0 when memory is off). */
  count(scope?: MemoryScope, characterId?: string): Promise<number>

  // ----------------------------------------------------------- mutations
  /**
   * Store one durable fact (semantic/episodic only). Consolidates against
   * existing memories when a utility LLM is available. Throws `PluginPiiError`
   * when the text trips the PII gate.
   */
  store(input: PluginMemoryStoreInput): Promise<StoreMemoryCoreResult>
  /** Patch text / importance / tags / key. Text patches are PII-gated. */
  update(id: string, patch: UpdateExternalMemoryPatch): Promise<MutateExternalMemoryResult>
  /** Soft-invalidate (kept for history; never a hard delete). */
  forget(id: string): Promise<MutateExternalMemoryResult>
}

const DEFAULT_LIST_LIMIT = 100

/** Reads are policy-gated too: memory off / temporary → nothing to read. */
async function readsAllowed(): Promise<boolean> {
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  return config.enabled && !config.temporary
}

/**
 * Create the Memory API for a plugin. Reads need `memory:read`; every
 * mutation needs `memory:write` (enforced via the PermissionGuard proxy).
 */
export function createMemoryAPI(pluginId: string): PluginMemoryAPI {
  const api: PluginMemoryAPI = {
    // reads
    search: async (query, opts) => {
      const result = await searchMemoriesExternal({ query, ...opts })
      return result.ok ? result.hits : []
    },
    list: async (filter) => {
      if (!(await readsAllowed())) return []
      const rows = await listMemories({
        type: filter?.type,
        scope: filter?.scope,
        characterId: filter?.characterId,
        projectId: filter?.projectId,
        agentId: filter?.agentId,
        branch: filter?.branch,
        pathPattern: filter?.pathPattern,
        status: filter?.status ?? "active",
      })
      return rows.slice(0, Math.max(1, filter?.limit ?? DEFAULT_LIST_LIMIT))
    },
    get: async (id) => {
      if (!(await readsAllowed())) return undefined
      return getMemory(id)
    },
    count: async (scope, characterId) => {
      if (!(await readsAllowed())) return 0
      return countActive(scope ?? "global", characterId)
    },

    // mutations
    store: async (input) => {
      assertNoLeakingPii(pluginId, "ctx.memory.store", [input.text])
      return storeExternalMemory(input, { channel: "plugin", pluginId })
    },
    update: async (id, patch) => {
      assertNoLeakingPii(pluginId, "ctx.memory.update", [patch.text])
      return updateExternalMemory(id, patch)
    },
    forget: (id) => forgetExternalMemory(id),
  }

  return createGuardedAPI(pluginId, api, {
    search: "memory:read",
    list: "memory:read",
    get: "memory:read",
    count: "memory:read",
    store: "memory:write",
    update: "memory:write",
    forget: "memory:write",
  })
}
