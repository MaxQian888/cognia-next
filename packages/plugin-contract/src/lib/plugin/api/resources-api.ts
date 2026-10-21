/**
 * The plugin contract's share of `lib/plugin/api/resources-api.ts`, which re-exports these.
 */
import type { Character, McpServer, Skill, Team } from "@cognia/agent-config-types"
import type { Twin } from "../../../types/twin"
import type { AdapterInstanceRow } from "../../db/connector-types"
import type { PluginRow } from "../../db/plugin-types"

export interface PluginResourcesAPI {
  listCharacters: () => Promise<Character[]>
  listTeams: () => Promise<Team[]>
  listTwins: (opts?: { includeArchived?: boolean }) => Promise<Twin[]>
  listSkills: () => Promise<Skill[]>
  listAdapterInstances: () => Promise<AdapterInstanceRow[]>
  listMcpServers: () => Promise<McpServer[]>
  listPlugins: () => Promise<PluginRow[]>
}
