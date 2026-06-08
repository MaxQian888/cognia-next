/**
 * Renderer-side IPC handler for `plugin_tool_exec` events from the SDK
 * sidecar (M2 of the plugin-first Computer Use plan).
 *
 * Flow:
 *   1. The sidecar's synthetic `cognia-plugin-tools` MCP server proxies a
 *      tool call back to the renderer as a `plugin_tool_exec` event.
 *   2. The renderer listens on the `claude://message` channel and routes
 *      every `plugin_tool_exec` payload through {@link handlePluginToolExec}.
 *   3. This handler resolves the plugin tool through the live plugin
 *      registry (the same registry the AI-SDK bridge uses, so a plugin
 *      registered ONCE via `ctx.agent.registerTool()` lights up both
 *      runtimes), executes it, and returns a `plugin_tool_response`.
 *   4. The caller is responsible for writing the response back to the
 *      sidecar (a future `claude_plugin_tool_response` Tauri command will
 *      forward it onto the sidecar's stdin, where `claude-host.mjs`
 *      resolves the pending `pendingPluginToolCalls` entry).
 *
 * Errors are caught here and surfaced as a structured `error: string` on
 * the response — never thrown — so a faulty plugin can't blow up the
 * renderer-side event router.
 */

import type { PluginToolContext } from "@/types/plugin"
import { ASK_USER_TOOL_NAME } from "./ask-user-tool"

export interface PluginToolExecRequest {
  type: "plugin_tool_exec"
  sessionId: string
  toolUseId: string
  name: string
  args: Record<string, unknown>
}

export interface PluginToolExecResponse {
  type: "plugin_tool_response"
  sessionId: string
  toolUseId: string
  result?: unknown
  error?: string
}

/**
 * Resolver for the live plugin registry. Lifted to a module-level slot so
 * unit tests can swap a mock implementation in without touching the real
 * plugin manager singleton (which throws when uninitialised in jsdom).
 */
export interface PluginToolResolver {
  /**
   * Look up a plugin tool by its bare name. Returns `undefined` when the
   * tool is unknown or its owning plugin is disabled.
   */
  getTool(name: string):
    | {
        pluginId: string
        execute: (args: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>
      }
    | undefined
  /**
   * Per-plugin runtime config snapshot, surfaced inside the
   * {@link PluginToolContext} passed to `execute`. Returning `undefined`
   * is treated as "no config" and the context falls through to `{}`.
   */
  getPluginConfig?: (pluginId: string) => Record<string, unknown> | undefined
}

let resolverOverride: PluginToolResolver | null = null

/**
 * Inject a custom resolver. Intended for tests — when set, resolution AND
 * execution short-circuit through the injected object (the historical
 * contract). Production code routes through the unified
 * `invokePluginTool` seam instead. Pass `null` to restore the default.
 */
export function __setPluginToolResolverForTesting(resolver: PluginToolResolver | null): void {
  resolverOverride = resolver
}

/**
 * Dispatch a `plugin_tool_exec` event from the sidecar through the live
 * plugin registry and produce the matching `plugin_tool_response`.
 *
 * Never throws — every failure mode (tool not found, plugin disabled,
 * execute() rejection, manager not initialised) is collapsed onto the
 * `error` field of the response so the sidecar-side promise always
 * resolves and the MCP tool can return a clean error envelope.
 */
export async function handlePluginToolExec(
  request: PluginToolExecRequest
): Promise<PluginToolExecResponse> {
  const baseResponse = {
    type: "plugin_tool_response" as const,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
  }
  try {
    if (resolverOverride) {
      // Test seam — execute through the injected resolver directly so
      // suites that stub resolution + execution in one object keep their
      // historical contract. Production never takes this branch.
      const tool = resolverOverride.getTool(request.name)
      if (tool) {
        const context: PluginToolContext = {
          sessionId: request.sessionId,
          config: resolverOverride.getPluginConfig?.(tool.pluginId) ?? {},
        }
        const result = await tool.execute(request.args, context)
        return { ...baseResponse, result }
      }
    } else {
      // Production path — resolve the owning plugin by bare tool name,
      // then route through the unified invocation seam so lazy
      // `onTool:` activation, the permission consent gate, and error
      // normalization match every other plugin-tool call site (workflow
      // `action.plugin.invoke`, quick actions).
      const { resolvePluginToolByName, invokePluginTool } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      const resolved = await resolvePluginToolByName(request.name)
      if (resolved) {
        const { result } = await invokePluginTool(resolved.pluginId, request.name, request.args, {
          sessionId: request.sessionId,
          reason: `chat:plugin_tool_exec:${request.name}`,
        })
        return { ...baseResponse, result }
      }
    }
    // ── ADR-0026 — built-in skill fallback ────────────────────────────
    // Tool not in the plugin registry — try the built-in skill registry.
    // The sidecar surfaces built-in skill MCP tool names verbatim from
    // `BuiltInSkill.mcpToolName`; we resolve by that field.
    const builtIn = await resolveBuiltInSkillByMcpName(request.name)
    if (builtIn) {
      const { runBuiltInSkill } = await import("@/lib/skills/built-in/dispatcher")
      const result = await runBuiltInSkill(builtIn.id, request.args, {
        sessionId: request.sessionId,
      })
      // The dispatcher returns a discriminated union; on `denied` /
      // `pending_hitl` / `error` we surface the structured payload so the
      // model can see the reason. The SDK turns this into a tool result
      // string verbatim — opaque to the model is fine.
      return { ...baseResponse, result }
    }
    // ── Wave 1 — Terminal dock fallback ────────────────────────────────
    // The 4 synthetic `terminal_dock_*` tools are manifested by
    // `lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`
    // when `settings.terminal.exposeDockToAgents` is true. They proxy
    // through the same `plugin_tool_exec` wire as plugin tools; resolve
    // them here so the model's tool call lands in the user's visible
    // dock PTY rather than a sidecar `child_process` ghost.
    // ── Wave 1 — ask_user elicitation tool ─────────────────────────────
    // Surfaced by `buildAskUserManifestEntry()`; round-trips through the same
    // `plugin_tool_exec` wire. Resolve it to the renderer's ask-user dialog,
    // which blocks until the user answers and returns the formatted result.
    if (request.name === ASK_USER_TOOL_NAME) {
      const { runAskUser } = await import("@/stores/agent/ask-user-store")
      const result = await runAskUser(request.args, { sessionId: request.sessionId })
      return { ...baseResponse, result }
    }
    if (request.name.startsWith("terminal_dock_")) {
      const { runTerminalDockAction } = await import("@/lib/terminal/dock-tool-handler")
      const action = request.name.slice("terminal_dock_".length) as
        | "spawn"
        | "write"
        | "read_recent"
        | "wait_for_exit"
      const result = await runTerminalDockAction({
        action,
        args: request.args,
        chatSessionId: request.sessionId,
      })
      return { ...baseResponse, result }
    }
    return { ...baseResponse, error: `plugin tool not found: ${request.name}` }
  } catch (err) {
    return {
      ...baseResponse,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function resolveBuiltInSkillByMcpName(
  mcpToolName: string
): Promise<{ id: string } | undefined> {
  try {
    await import("@/lib/skills/built-in")
    const { getSharedBuiltInSkillRegistry } = await import("@/lib/skills/built-in/registry")
    const reg = getSharedBuiltInSkillRegistry()
    for (const skill of reg.list()) {
      if (skill.mcpToolName === mcpToolName) {
        return { id: skill.id }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
