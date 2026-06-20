/**
 * Plugin Agent Integration
 * Integrates plugin-provided modes, tools, and capabilities with the agent system
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { PluginTool, Plugin } from "@/types/plugin"
import { trackPluginEvent } from "../utils/analytics"
import { loggers } from "../core/logger"
import { getPluginManager } from "@/lib/plugin/core/manager"

// =============================================================================
// Types
// =============================================================================

export interface PluginAgentTool {
  name: string
  pluginId: string
  description: string
  parametersSchema: Record<string, unknown>
  execute: (params: Record<string, unknown>) => Promise<unknown>
  category?: string
  enabled: boolean
}

export interface PluginAgentMode extends AgentModeConfig {
  pluginId: string
  pluginName: string
  isPluginMode: true
}

export interface AgentIntegrationState {
  pluginTools: PluginAgentTool[]
  pluginModes: PluginAgentMode[]
  activePluginMode: string | null
}

// =============================================================================
// Plugin Agent Bridge
// =============================================================================

export class PluginAgentBridge {
  private toolExecutionTracking = new Map<string, { startTime: number; pluginId: string }>()

  /**
   * Get all tools from enabled plugins
   */
  getPluginTools(): PluginAgentTool[] {
    const store = usePluginStore.getState()
    const tools: PluginAgentTool[] = []

    for (const plugin of Object.values(store.plugins)) {
      if (plugin.status !== "enabled") continue
      if (!plugin.tools) continue

      for (const tool of plugin.tools) {
        tools.push({
          name: tool.name,
          pluginId: plugin.manifest.id,
          description: tool.definition.description,
          parametersSchema: tool.definition.parametersSchema,
          execute: this.wrapToolExecution(tool, plugin),
          category: this.inferToolCategory(tool),
          enabled: true,
        })
      }
    }

    return tools
  }

  /**
   * Get all modes from enabled plugins
   */
  getPluginModes(): PluginAgentMode[] {
    const store = usePluginStore.getState()
    const modes: PluginAgentMode[] = []

    for (const plugin of Object.values(store.plugins)) {
      if (plugin.status !== "enabled") continue
      if (!plugin.modes) continue

      for (const mode of plugin.modes) {
        modes.push({
          ...mode,
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          isPluginMode: true,
        })
      }
    }

    return modes
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: string): PluginAgentTool | undefined {
    return this.getPluginTools().find((t) => t.name === name)
  }

  /**
   * Get a specific mode by ID
   */
  getMode(id: string): PluginAgentMode | undefined {
    return this.getPluginModes().find((m) => m.id === id)
  }

  /**
   * Execute a plugin tool with tracking
   */
  async executeTool(
    name: string,
    params: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    let tool = this.getTool(name)

    if (!tool) {
      try {
        await getPluginManager().handleActivationEvent(`onTool:${name}`)
        tool = this.getTool(name)
      } catch {
        // Plugin manager may not be initialized yet.
      }
    }

    if (!tool) {
      return { success: false, error: `Tool not found: ${name}` }
    }

    if (!tool.enabled) {
      return { success: false, error: `Tool is disabled: ${name}` }
    }

    // Advance the idle-suspend clock on every tool dispatch so tool-heavy
    // plugins aren't suspended mid-session. The policy (lib/plugin/core/
    // idle-policy.ts) reads `plugin.lastUsedAt`, which is otherwise only set
    // once at enable time. trackPluginEvent below writes a separate analytics
    // `stats.lastUsed` field that the policy does not consult.
    usePluginStore.getState().updateLastUsedAt(tool.pluginId)

    const startTime = Date.now()
    this.toolExecutionTracking.set(name, { startTime, pluginId: tool.pluginId })

    try {
      const result = await tool.execute(params)
      const duration = Date.now() - startTime

      // Track successful execution
      await trackPluginEvent({
        pluginId: tool.pluginId,
        eventType: "tool_call",
        toolName: name,
        duration,
        success: true,
        metadata: { params },
      })

      return { success: true, result }
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Track failed execution
      await trackPluginEvent({
        pluginId: tool.pluginId,
        eventType: "tool_call",
        toolName: name,
        duration,
        success: false,
        errorMessage,
        metadata: { params },
      })

      return { success: false, error: errorMessage }
    } finally {
      this.toolExecutionTracking.delete(name)
    }
  }

  /**
   * Activate a plugin mode
   */
  async activateMode(modeId: string): Promise<boolean> {
    const mode = this.getMode(modeId)

    if (!mode) {
      loggers.manager.warn(`Plugin mode not found: ${modeId}`)
      return false
    }

    // Track mode activation
    await trackPluginEvent({
      pluginId: mode.pluginId,
      eventType: "mode_switch",
      modeId,
      success: true,
    })

    return true
  }

  /**
   * Get tools available for a specific mode
   */
  getToolsForMode(modeId: string): PluginAgentTool[] {
    const mode = this.getMode(modeId)
    if (!mode) return []

    const allTools = this.getPluginTools()

    // If mode specifies tools, filter to those
    if (mode.tools && mode.tools.length > 0) {
      return allTools.filter((t) => mode.tools?.includes(t.name))
    }

    // Otherwise, return all tools from the same plugin
    return allTools.filter((t) => t.pluginId === mode.pluginId)
  }

  /**
   * Convert plugin tools to agent tool format
   */
  toAgentTools(tools: PluginAgentTool[]): Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
    execute: (params: Record<string, unknown>) => Promise<unknown>
  }> {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersSchema,
      execute: tool.execute,
    }))
  }

  /**
   * Wrap tool execution with error handling and context
   */
  private wrapToolExecution(
    tool: PluginTool,
    plugin: Plugin
  ): (params: Record<string, unknown>) => Promise<unknown> {
    return async (params: Record<string, unknown>) => {
      const context = {
        config: plugin.config,
        pluginId: plugin.manifest.id,
      }

      return tool.execute(params, context)
    }
  }

  /**
   * Infer tool category from name or definition
   */
  private inferToolCategory(tool: PluginTool): string {
    const name = tool.name.toLowerCase()

    if (name.includes("search") || name.includes("query")) return "search"
    if (name.includes("analyze") || name.includes("process")) return "analysis"
    if (name.includes("generate") || name.includes("create")) return "generation"
    if (name.includes("fetch") || name.includes("get")) return "data"
    if (name.includes("write") || name.includes("save")) return "storage"

    return "general"
  }

  /**
   * Get currently executing tools
   */
  getExecutingTools(): Array<{ name: string; pluginId: string; duration: number }> {
    const now = Date.now()
    return Array.from(this.toolExecutionTracking.entries()).map(([name, data]) => ({
      name,
      pluginId: data.pluginId,
      duration: now - data.startTime,
    }))
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let bridgeInstance: PluginAgentBridge | null = null

export function getPluginAgentBridge(): PluginAgentBridge {
  if (!bridgeInstance) {
    bridgeInstance = new PluginAgentBridge()
  }
  return bridgeInstance
}

// =============================================================================
// React Hooks for Agent Integration
// =============================================================================

/**
 * Hook to get all plugin tools for use in agent
 */
export function usePluginAgentTools() {
  // Subscribe to store to trigger recompute when plugins change
  usePluginStore()
  const bridge = getPluginAgentBridge()

  const tools = bridge.getPluginTools()
  const enabledCount = tools.filter((t) => t.enabled).length

  return {
    tools,
    enabledCount,
    totalCount: tools.length,
    executeTool: bridge.executeTool.bind(bridge),
    getExecutingTools: bridge.getExecutingTools.bind(bridge),
  }
}

/**
 * Hook to get all plugin modes for use in agent
 */
export function usePluginAgentModes() {
  // Subscribe to store to trigger recompute when plugins change
  usePluginStore()
  const bridge = getPluginAgentBridge()

  const modes = bridge.getPluginModes()

  return {
    modes,
    count: modes.length,
    getMode: bridge.getMode.bind(bridge),
    activateMode: bridge.activateMode.bind(bridge),
    getToolsForMode: bridge.getToolsForMode.bind(bridge),
  }
}

/**
 * Merge plugin tools with built-in agent tools
 */
export function mergeWithBuiltinTools(
  builtinTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  pluginTools: PluginAgentTool[]
): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
  source: "builtin" | "plugin"
}> {
  const merged = [
    ...builtinTools.map((t) => ({ ...t, source: "builtin" as const })),
    ...pluginTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parametersSchema,
      source: "plugin" as const,
    })),
  ]

  // Remove duplicates, preferring plugin tools
  const seen = new Set<string>()
  return merged.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

/**
 * Merge plugin modes with built-in agent modes
 */
export function mergeWithBuiltinModes(
  builtinModes: AgentModeConfig[],
  pluginModes: PluginAgentMode[]
): Array<AgentModeConfig & { source: "builtin" | "plugin" }> {
  const merged = [
    ...builtinModes.map((m) => ({ ...m, source: "builtin" as const })),
    ...pluginModes.map((m) => ({ ...m, source: "plugin" as const })),
  ]

  // Remove duplicates, preferring plugin modes
  const seen = new Set<string>()
  return merged.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}
