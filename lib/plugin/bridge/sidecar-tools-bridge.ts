/**
 * Plugin tools manifest for the SDK sidecar runtime.
 *
 * Iterates the plugin store, surfaces every enabled plugin's tools as a
 * flat array of `{name, description, jsonSchema, pluginId}`. The `execute`
 * function is intentionally stripped — functions don't cross the parent
 * stdio IPC channel. The sidecar uses this manifest to build a
 * `cognia-plugin-tools` MCP server; when the model invokes one of the
 * tools, the sidecar emits a `plugin_tool_exec` event back over stdout
 * and the renderer dispatches it via `handlePluginToolExec`.
 *
 * Mirrors the in-process AI-SDK flow in `agent-integration.ts` so a
 * plugin tool registered ONCE via `ctx.agent.registerTool()` lights up
 * both runtimes without the plugin author wiring anything extra.
 *
 * Wave 1 (terminal dock unification): the manifest can also carry a
 * block of synthetic terminal-dock entries when the user has flipped
 * `settings.terminal.exposeDockToAgents` on. The sidecar treats them
 * exactly like any plugin tool — they round-trip through
 * `plugin_tool_exec` and resolve in the renderer's
 * `lib/terminal/dock-tool-handler.ts`, which writes into the live PTY
 * the user sees. The agent and the user share one shell.
 */
import { usePluginStore } from "@/stores/plugin-runtime"

import { buildAskUserManifestEntry } from "@/lib/claude/ask-user-tool"
import {
  buildDispatchAgentManifestEntry,
  type DispatchAgentAvailableSubagent,
} from "@/lib/claude/agents/dispatch-agent-tool"
import {
  TERMINAL_DOCK_PLUGIN_ID,
  TERMINAL_DOCK_READ_RECENT_SCHEMA,
  TERMINAL_DOCK_SPAWN_SCHEMA,
  TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
  TERMINAL_DOCK_WRITE_SCHEMA,
} from "./terminal-dock-schemas"

export interface PluginToolManifestEntry {
  name: string
  description: string
  jsonSchema: object
  pluginId: string
}

export interface BuildPluginToolsManifestOptions {
  /**
   * Mirrors `settings.terminal.exposeDockToAgents`. When `true`, the
   * 4 synthetic `terminal_dock_*` entries are appended so the agent's
   * terminal calls drive the user's visible PTY via
   * `handlePluginToolExec → runTerminalDockAction → runInDockTab`.
   * Default `false` keeps the agent out of the dock entirely.
   */
  exposeDockToAgents?: boolean
  /**
   * Nested-dispatch gate. When provided and `enabled`, the synthetic
   * `dispatch_agent` entry is appended ONLY while `depth < maxDepth` — at the
   * cap the entry is withheld so the running agent can no longer nest (the
   * depth-N generalization of Claude Code's "Agent tool removed from
   * subagents"). `available` seeds the `subagentId` enum + discovery list.
   */
  dispatchAgent?: {
    enabled: boolean
    depth: number
    maxDepth: number
    available: DispatchAgentAvailableSubagent[]
  }
}

/**
 * Build the synthetic `dispatch_agent` entry when nesting is enabled and the
 * caller is still below the depth cap. Exported so unit tests can assert the
 * gate in isolation.
 */
export function buildDispatchAgentManifestEntries(
  opts: BuildPluginToolsManifestOptions = {}
): PluginToolManifestEntry[] {
  const gate = opts.dispatchAgent
  if (!gate || !gate.enabled) return []
  if (gate.depth >= gate.maxDepth) return []
  return [buildDispatchAgentManifestEntry(gate.available)]
}

/**
 * Build the synthetic terminal-dock entries that drive the renderer's
 * dock PTY via the existing `plugin_tool_exec` wire. Returns an empty
 * array when the user setting is off so the entries simply don't exist
 * on the agent's side.
 *
 * Exported so unit tests can assert the gate independently of the rest
 * of the plugin-store machinery.
 */
export function buildTerminalDockManifestEntries(
  opts: BuildPluginToolsManifestOptions = {}
): PluginToolManifestEntry[] {
  if (!opts.exposeDockToAgents) return []
  return [
    {
      name: "terminal_dock_spawn",
      description:
        "Open a new tab in the user's terminal dock. Optionally type a command and wait for it to finish.",
      jsonSchema: TERMINAL_DOCK_SPAWN_SCHEMA,
      pluginId: TERMINAL_DOCK_PLUGIN_ID,
    },
    {
      name: "terminal_dock_write",
      description:
        "Type input into an existing dock tab (PTY stdin). Waits for the next command_end event before returning.",
      jsonSchema: TERMINAL_DOCK_WRITE_SCHEMA,
      pluginId: TERMINAL_DOCK_PLUGIN_ID,
    },
    {
      name: "terminal_dock_read_recent",
      description:
        "Return the last N command records (command + exit code + cwd) from a dock tab's OSC 633 ring buffer.",
      jsonSchema: TERMINAL_DOCK_READ_RECENT_SCHEMA,
      pluginId: TERMINAL_DOCK_PLUGIN_ID,
    },
    {
      name: "terminal_dock_wait_for_exit",
      description:
        "Block until the most-recent command in the named tab emits an OSC 633 D event, then return its exit code.",
      jsonSchema: TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
      pluginId: TERMINAL_DOCK_PLUGIN_ID,
    },
  ]
}

/**
 * Build the plugin-tools manifest from the live plugin store.
 *
 * Only `enabled` plugins contribute tools; plugins without a `tools` array
 * are skipped silently. Tools with no `parametersSchema` fall through to
 * an empty object so the sidecar can build a permissive zod object that
 * still passes the raw args through.
 *
 * When `opts.exposeDockToAgents` is true, the synthetic terminal-dock
 * entries (4 actions) are appended to the result.
 */
export function buildPluginToolsManifest(
  opts: BuildPluginToolsManifestOptions = {}
): PluginToolManifestEntry[] {
  const store = usePluginStore.getState()
  const result: PluginToolManifestEntry[] = []
  for (const plugin of Object.values(store.plugins)) {
    if (plugin.status !== "enabled") continue
    if (!plugin.tools?.length) continue
    for (const tool of plugin.tools) {
      result.push({
        name: tool.name,
        description: tool.definition.description,
        jsonSchema: tool.definition.parametersSchema ?? {},
        pluginId: plugin.manifest.id,
      })
    }
  }
  result.push(...buildTerminalDockManifestEntries(opts))
  // `ask_user` is a core, side-effect-free agent capability (pause and ask the
  // user) — always available on both dispatch paths via the same relay.
  result.push(buildAskUserManifestEntry())
  // `dispatch_agent` — only when nesting is enabled and below the depth cap.
  result.push(...buildDispatchAgentManifestEntries(opts))
  return result
}
