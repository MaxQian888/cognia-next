import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { listCharacters } from "@/lib/db/characters"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import { listSkills } from "@/lib/db/skills"
import { listTwins } from "@/lib/db/twins"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"

export interface PluginResourcesAPI {
  listCharacters: typeof listCharacters
  listTwins: typeof listTwins
  listSkills: typeof listSkills
  listAdapterInstances: typeof listAdapterInstances
  listMcpServers: typeof listMcpServers
  listPlugins: typeof listPlugins
}

/**
 * Index-level access to resources plugins may reference.
 *
 * These are verbatim Dexie readers — `listMcpServers()` returns whole rows,
 * endpoint and trust metadata included — so the inventory is the user's, not
 * the plugin's, and every method is gated on `database:read`. The contract
 * catalog carries the same requirement, but its `resources` namespace is
 * `enforcement: "shadow"` (audit-only), so the guard is what enforces it.
 */
export function createResourcesAPI(pluginId: string): PluginResourcesAPI {
  const api: PluginResourcesAPI = {
    listCharacters,
    listTwins,
    listSkills,
    listAdapterInstances,
    listMcpServers,
    listPlugins,
  }

  return createGuardedAPI(pluginId, api, {
    listCharacters: "database:read",
    listTwins: "database:read",
    listSkills: "database:read",
    listAdapterInstances: "database:read",
    listMcpServers: "database:read",
    listPlugins: "database:read",
  })
}
