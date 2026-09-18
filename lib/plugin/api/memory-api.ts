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
  listMemoriesExternal,
  getMemoryExternal,
  countMemoriesExternal,
} from "@/lib/memory/api/read-memory"
import { pluginCaller } from "@/lib/memory/api/caller"
import {
  updateExternalMemory,
  forgetExternalMemory,
  type MutateExternalMemoryResult,
  type UpdateExternalMemoryPatch,
} from "@/lib/memory/api/mutate-memory"
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
   * when the text trips the PII gate. `input.operationId` makes the write
   * idempotent — a retried identical request replays its first result.
   */
  store(input: PluginMemoryStoreInput): Promise<StoreMemoryCoreResult>
  /**
   * Patch text / importance / tags / key. Text patches are PII-gated.
   * `opts.expectedVersion` is a compare-and-swap guard on the row's version;
   * `opts.operationId` makes a retried identical patch replay its first result.
   */
  update(
    id: string,
    patch: UpdateExternalMemoryPatch,
    opts?: { expectedVersion?: number; operationId?: string }
  ): Promise<MutateExternalMemoryResult>
  /**
   * Soft-invalidate (kept for history; never a hard delete). Same CAS and
   * idempotency options as `update`.
   */
  forget(
    id: string,
    opts?: { expectedVersion?: number; operationId?: string }
  ): Promise<MutateExternalMemoryResult>
}

const DEFAULT_LIST_LIMIT = 100

/**
 * Create the Memory API for a plugin. Reads need `memory:read`; every
 * mutation needs `memory:write` (enforced via the PermissionGuard proxy).
 *
 * `pluginId` is bound by the plugin manager at factory time — it becomes the
 * caller's `principalId`, so a plugin's idempotency keys, audit rows and (as
 * the grant store lands) namespace grants are its own and cannot be asserted
 * by another plugin.
 */
export function createMemoryAPI(pluginId: string): PluginMemoryAPI {
  const caller = pluginCaller(pluginId)
  const api: PluginMemoryAPI = {
    // reads
    search: async (query, opts) => {
      const result = await searchMemoriesExternal({ query, ...opts }, caller)
      return result.ok ? result.hits : []
    },
    list: async (filter) => {
      const result = await listMemoriesExternal(
        { ...filter, limit: Math.max(1, filter?.limit ?? DEFAULT_LIST_LIMIT) },
        caller
      )
      return result.ok ? result.memories : []
    },
    get: (id) => getMemoryExternal(id, caller),
    count: (scope, characterId) => countMemoriesExternal(scope ?? "global", caller, characterId),

    // mutations
    store: async (input) => {
      assertNoLeakingPii(pluginId, "ctx.memory.store", [input.text])
      return storeExternalMemory(input, { channel: "plugin", pluginId }, caller)
    },
    update: async (id, patch, opts) => {
      assertNoLeakingPii(pluginId, "ctx.memory.update", [patch.text])
      return updateExternalMemory(id, patch, {
        caller,
        expectedVersion: opts?.expectedVersion,
        operationId: opts?.operationId,
      })
    },
    forget: (id, opts) =>
      forgetExternalMemory(id, {
        caller,
        expectedVersion: opts?.expectedVersion,
        operationId: opts?.operationId,
      }),
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
