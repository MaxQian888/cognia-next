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
 * Inject a custom resolver. Intended for tests — production code reads
 * the singleton plugin manager via {@link defaultResolver}. Pass `null`
 * to restore the default.
 */
export function __setPluginToolResolverForTesting(resolver: PluginToolResolver | null): void {
  resolverOverride = resolver
}

/**
 * Default resolver — pulls the live plugin manager + plugin store. Wrapped
 * in lazy dynamic imports so the module graph doesn't drag the plugin
 * manager into bundles that only need the type declarations.
 */
async function defaultResolver(): Promise<PluginToolResolver> {
  const [{ getPluginManager }, { usePluginStore }] = await Promise.all([
    import("@/lib/plugin/core/manager"),
    import("@/stores/plugin"),
  ])
  return {
    getTool: (name) => {
      let registry
      try {
        registry = getPluginManager().getRegistry()
      } catch {
        // Manager not yet initialised (e.g. very early renderer boot).
        return undefined
      }
      const tool = registry.getTool(name)
      if (!tool) return undefined
      const plugin = usePluginStore.getState().plugins[tool.pluginId]
      // Disabled plugins must not respond — the model can still emit a
      // stale tool_use, but we refuse to execute. The sidecar surfaces this
      // as an MCP tool error so the model sees a clean failure.
      if (!plugin || plugin.status !== "enabled") return undefined
      return {
        pluginId: tool.pluginId,
        execute: (args, context) => tool.execute(args, context),
      }
    },
    getPluginConfig: (pluginId) => usePluginStore.getState().plugins[pluginId]?.config ?? {},
  }
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
    const resolver = resolverOverride ?? (await defaultResolver())
    const tool = resolver.getTool(request.name)
    if (!tool) {
      return { ...baseResponse, error: `plugin tool not found: ${request.name}` }
    }
    const context: PluginToolContext = {
      sessionId: request.sessionId,
      config: resolver.getPluginConfig?.(tool.pluginId) ?? {},
    }
    const result = await tool.execute(request.args, context)
    return { ...baseResponse, result }
  } catch (err) {
    return {
      ...baseResponse,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
