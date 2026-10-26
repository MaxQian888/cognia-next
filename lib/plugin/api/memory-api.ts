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

import { storeExternalMemory } from "@/lib/memory/api/store-memory"
import { searchMemoriesExternal } from "@/lib/memory/api/search-memory"
import {
  listMemoriesExternal,
  getMemoryExternal,
  countMemoriesExternal,
} from "@/lib/memory/api/read-memory"
import { pluginCaller } from "@/lib/memory/api/caller"
import { updateExternalMemory, forgetExternalMemory } from "@/lib/memory/api/mutate-memory"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { assertNoLeakingPii } from "./plugin-pii-gate"
import type { PluginMemoryAPI } from "@cognia/plugin-contract/lib/plugin/api/memory-api"
export type {
  PluginMemoryAPI,
  PluginMemoryListFilter,
  PluginMemorySearchOptions,
  PluginMemoryStoreInput,
} from "@cognia/plugin-contract/lib/plugin/api/memory-api"

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
