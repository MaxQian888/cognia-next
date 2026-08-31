/**
 * Workflow-AI plugin — index-level resource list tools.
 *
 * Six read-only `wf_list_*` tools that let the workflow copilot ground
 * its proposals in the user's actual project resources (characters,
 * twins, skills, connectors, MCP servers, plugins) before referencing
 * any id. Returns are deliberately at the **index level**: id + label +
 * a few capability tags. Credentials, raw system prompts, free-form
 * keyring refs, and webhook URLs are NOT exposed.
 *
 * Approval: never. Reads only.
 */

import type { PluginContext, PluginTool } from "@cognia/plugin-sdk"
import { formatToolError } from "../store-bridge"
const PLUGIN_ID = "cognia-workflow-ai"

const EMPTY_PARAMS = {
  type: "object" as const,
  properties: {},
}

export function buildResourceTools(resources: PluginContext["resources"]): PluginTool[] {
  return [
    {
      name: "wf_list_characters",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_characters",
        description:
          "List every character configured in this project as { id, name, description?, model?, twinId?, hasSkills }. Call BEFORE configuring any node that references a character id (e.g., action.character.send).",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: EMPTY_PARAMS,
      },
      execute: async () => {
        try {
          const rows = await resources.listCharacters()
          return {
            ok: true,
            characters: rows.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
              model: c.model,
              twinId: c.twinId,
              hasSkills: (c.skillIds?.length ?? 0) > 0,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_list_twins",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_twins",
        description:
          "List every twin (digital twin / persona container) as { id, name, description?, archived }. Archived twins are excluded by default. Use BEFORE referencing a twinId in a node config or character binding.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            includeArchived: {
              type: "boolean",
              description: "Include archived twins. Defaults to false.",
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const includeArchived = Boolean(args.includeArchived)
          const rows = await resources.listTwins({ includeArchived })
          return {
            ok: true,
            twins: rows.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              archived: t.archived ?? false,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_list_skills",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_skills",
        description:
          "List every skill as { id, name, description?, tags? }. Use BEFORE referencing a skillId in a character config or node param. Skill content (markdown body) is NOT returned — call wf_describe_node_kind or wf_read_node for full configurations.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: EMPTY_PARAMS,
      },
      execute: async () => {
        try {
          const rows = await resources.listSkills()
          return {
            ok: true,
            skills: rows.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              tags: s.tags,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_list_connectors",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_connectors",
        description:
          "List every configured connector adapter (Telegram / Discord / Slack / Lark / OneBot / …) as { id, type, displayName, enabled, transportMode }. Use BEFORE configuring any node that references a connector adapter id (trigger.connector.inbound, action.connector.send, …). Credentials are NEVER returned.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: EMPTY_PARAMS,
      },
      execute: async () => {
        try {
          const rows = await resources.listAdapterInstances()
          return {
            ok: true,
            connectors: rows.map((r) => ({
              id: r.id,
              type: r.type,
              displayName: r.displayName,
              enabled: r.enabled,
              transportMode: r.transportMode,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_list_mcp_servers",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_mcp_servers",
        description:
          "List every configured MCP server as { id, name, transport, enabled }. Use BEFORE referencing an mcp server id in a tool/whitelist param. Server `config` (URLs, headers, env) is NOT returned.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: EMPTY_PARAMS,
      },
      execute: async () => {
        try {
          const rows = await resources.listMcpServers()
          return {
            ok: true,
            mcpServers: rows.map((m) => ({
              id: m.id,
              name: m.name,
              transport: m.transport,
              enabled: m.enabled,
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_list_plugins",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_plugins",
        description:
          "List every installed plugin as { id, name, version, status, source, enabled, capabilities }. Use BEFORE referencing a plugin-contributed node kind, tool, or skill so the agent can verify the plugin is enabled.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: EMPTY_PARAMS,
      },
      execute: async () => {
        try {
          const rows = await resources.listPlugins()
          return {
            ok: true,
            plugins: rows.map((p) => ({
              id: p.id,
              name: p.name,
              version: p.version,
              status: p.status,
              source: p.source,
              enabled: p.enabled,
              capabilities: p.capabilities ?? [],
            })),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
