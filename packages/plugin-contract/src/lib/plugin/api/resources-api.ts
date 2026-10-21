/**
 * The plugin contract's share of `lib/plugin/api/resources-api.ts`, which re-exports these.
 */
import type { listAdapterInstances } from "@/lib/db/adapter-instances"
import type { listCharacters } from "@/lib/db/characters"
import type { listMcpServers } from "@/lib/db/mcp-servers"
import type { listPlugins } from "@/lib/db/plugins"
import type { listSkills } from "@/lib/db/skills"
import type { listTeams } from "@/lib/db/teams"
import type { listTwins } from "@/lib/db/twins"

export interface PluginResourcesAPI {
  listCharacters: typeof listCharacters
  listTeams: typeof listTeams
  listTwins: typeof listTwins
  listSkills: typeof listSkills
  listAdapterInstances: typeof listAdapterInstances
  listMcpServers: typeof listMcpServers
  listPlugins: typeof listPlugins
}
