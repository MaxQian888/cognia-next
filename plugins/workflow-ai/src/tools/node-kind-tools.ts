/**
 * Workflow-AI plugin — node kind catalog tools.
 *
 * Thin wrappers over `lib/workflow/nodes/catalog.ts` so the workflow
 * copilot can:
 *   • enumerate available node kinds (with category + summary) before
 *     proposing an add_node op, and
 *   • inspect a kind's full metadata (label, description, paramsSchema)
 *     before configuring it.
 *
 * Both are read-only, never require approval.
 */

import type { PluginTool } from "@/types/plugin"
import { formatToolError } from "../store-bridge"
import {
  NODE_CATALOG,
  getPluginCatalogSnapshot,
  nodeCatalogEntry,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

const PLUGIN_ID = "cognia-workflow-ai"

interface ListedEntry {
  kind: string
  category: NodeCatalogEntry["category"]
  label: string
  description: string
  pluginId?: string
  desktopOnly?: boolean
}

function summarize(entry: NodeCatalogEntry): ListedEntry {
  return {
    kind: entry.kind,
    category: entry.category,
    label: entry.label,
    description: entry.description,
    pluginId: entry.pluginId,
    desktopOnly: entry.desktopOnly,
  }
}

export function buildNodeKindTools(): PluginTool[] {
  return [
    {
      name: "wf_list_node_kinds",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_node_kinds",
        description:
          "Enumerate every available workflow node kind: built-in + plugin-contributed. Returns { kind, category, label, description, pluginId?, desktopOnly? }. Hidden (legacy) entries are excluded. Use BEFORE proposing an add_node op so the kind string is grounded in what actually exists.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "Optional filter — return only entries in this category (e.g., 'trigger', 'action', 'flow', 'plugin').",
            },
            includeDesktopOnly: {
              type: "boolean",
              description:
                "Include kinds marked desktopOnly. Defaults to true (the copilot decides per environment).",
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const includeDesktopOnly = args.includeDesktopOnly !== false
          const categoryFilter = typeof args.category === "string" ? args.category : undefined
          const all = [...NODE_CATALOG, ...getPluginCatalogSnapshot()]
          const filtered = all.filter((e) => {
            if (e.hidden) return false
            if (!includeDesktopOnly && e.desktopOnly) return false
            if (categoryFilter && e.category !== categoryFilter) return false
            return true
          })
          return {
            ok: true,
            total: filtered.length,
            kinds: filtered.map(summarize),
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_describe_node_kind",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_describe_node_kind",
        description:
          "Describe one node kind: returns { kind, category, label, description, iconName, keywords, pluginId?, desktopOnly?, paramsSchema? }. Call BEFORE configuring a node so the params shape is grounded in the actual schema.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              description:
                "The node kind string, e.g., 'trigger.cron', 'action.character.send', or a plugin-prefixed kind like 'my-plugin.action.custom'.",
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const kind = String(args.kind ?? "").trim()
          if (!kind) {
            return {
              ok: false,
              error: { code: "missing-kind", message: "Argument 'kind' is required." },
            }
          }
          // Try built-in catalog first; fall back to plugin snapshot.
          const builtIn = NODE_CATALOG.find((e) => e.kind === kind)
          const pluginEntry = builtIn
            ? undefined
            : getPluginCatalogSnapshot().find((e) => e.kind === kind)
          const entry = builtIn ?? pluginEntry
          if (!entry) {
            // Use `nodeCatalogEntry` to surface the synthesized fallback for
            // truly unknown kinds — gives the agent a clear "no such kind" cue.
            return {
              ok: false,
              error: {
                code: "unknown-kind",
                message: `No node kind "${kind}" in catalog (built-in or plugin).`,
                detail: nodeCatalogEntry(kind as WorkflowNodeKind),
              },
            }
          }
          return {
            ok: true,
            entry: {
              kind: entry.kind,
              category: entry.category,
              label: entry.label,
              description: entry.description,
              iconName: entry.iconName,
              keywords: entry.keywords,
              pluginId: entry.pluginId,
              desktopOnly: entry.desktopOnly,
              paramsSchema: entry.paramsSchema,
            },
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
