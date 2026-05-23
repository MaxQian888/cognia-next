/**
 * Plugin Tools Bridge - Connects plugin tools with the agent system
 */

import { z } from "zod"
import type { PluginTool, PluginToolDef, PluginToolContext } from "@/types/plugin"
import type { AgentTool } from "@/lib/ai/agent/agent-executor"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginRegistry } from "../core/registry"

// =============================================================================
// Types
// =============================================================================

interface ToolsBridgeConfig {
  registry: PluginRegistry
}

interface ToolSandboxExecutionResult {
  success: boolean
  result?: unknown
  error?: string
  duration: number
}

// =============================================================================
// Plugin Tools Bridge
// =============================================================================

export class PluginToolsBridge {
  private config: ToolsBridgeConfig
  private executionHistory: Map<string, ToolSandboxExecutionResult[]> = new Map()

  constructor(config: ToolsBridgeConfig) {
    this.config = config
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  /**
   * Register a plugin tool
   */
  registerTool(pluginId: string, tool: PluginTool): void {
    // Validate tool definition
    this.validateToolDefinition(tool.definition)

    // Register with registry
    this.config.registry.registerTool(pluginId, tool)

    // Register with plugin store
    usePluginStore.getState().registerPluginTool(pluginId, tool)
  }

  /**
   * Unregister a plugin tool
   */
  unregisterTool(toolName: string): void {
    const tool = this.config.registry.getTool(toolName)
    if (tool) {
      this.config.registry.unregisterTool(toolName)
      usePluginStore.getState().unregisterPluginTool(tool.pluginId, toolName)
    }
  }

  /**
   * Unregister all tools from a plugin
   */
  unregisterPluginTools(pluginId: string): void {
    const tools = this.config.registry.getToolsByPlugin(pluginId)
    for (const tool of tools) {
      this.unregisterTool(tool.name)
    }
  }

  /**
   * Validate a tool definition
   */
  private validateToolDefinition(definition: PluginToolDef): void {
    if (!definition.name || typeof definition.name !== "string") {
      throw new Error("Tool must have a valid name")
    }

    if (!definition.description || typeof definition.description !== "string") {
      throw new Error("Tool must have a valid description")
    }

    if (!definition.parametersSchema || typeof definition.parametersSchema !== "object") {
      throw new Error("Tool must have a valid parametersSchema")
    }

    // Validate name format (lowercase, alphanumeric, underscores)
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new Error(
        `Invalid tool name "${definition.name}". Must start with lowercase letter and contain only lowercase letters, numbers, and underscores.`
      )
    }
  }

  // ===========================================================================
  // Tool Conversion
  // ===========================================================================

  /**
   * Convert a plugin tool to an AgentTool
   */
  convertToAgentTool(pluginTool: PluginTool): AgentTool {
    const { name, definition, execute, pluginId } = pluginTool

    // Convert JSON Schema to Zod schema
    const zodSchema = this.jsonSchemaToZod(definition.parametersSchema)

    return {
      name,
      description: definition.description,
      parameters: zodSchema,
      execute: async (args: Record<string, unknown>) => {
        const startTime = Date.now()

        try {
          // Create execution context
          const context: PluginToolContext = {
            config: usePluginStore.getState().plugins[pluginId]?.config || {},
          }

          // Execute the tool
          const result = await execute(args, context)

          // Record success
          this.recordExecution(name, {
            success: true,
            result,
            duration: Date.now() - startTime,
          })

          return result
        } catch (error) {
          // Record failure
          const errorMessage = error instanceof Error ? error.message : String(error)
          this.recordExecution(name, {
            success: false,
            error: errorMessage,
            duration: Date.now() - startTime,
          })

          throw error
        }
      },
      requiresApproval: definition.requiresApproval ?? false,
    }
  }

  /**
   * Convert all plugin tools to AgentTools
   */
  convertAllToAgentTools(): AgentTool[] {
    const pluginTools = this.config.registry.getAllTools()
    return pluginTools.map((tool) => this.convertToAgentTool(tool))
  }

  /**
   * Get plugin tools as AgentTools for a specific plugin
   */
  getPluginAgentTools(pluginId: string): AgentTool[] {
    const pluginTools = this.config.registry.getToolsByPlugin(pluginId)
    return pluginTools.map((tool) => this.convertToAgentTool(tool))
  }

  // ===========================================================================
  // Schema Conversion
  // ===========================================================================

  /**
   * Convert JSON Schema to Zod schema
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
    const type = schema.type as string
    const properties = schema.properties as Record<string, unknown> | undefined
    const required = schema.required as string[] | undefined

    switch (type) {
      case "object": {
        if (!properties) {
          return z.record(z.string(), z.unknown())
        }

        const shape: Record<string, z.ZodType> = {}
        for (const [key, propSchema] of Object.entries(properties)) {
          let propType = this.jsonSchemaToZod(propSchema as Record<string, unknown>)

          // Make optional if not in required array
          if (!required?.includes(key)) {
            propType = propType.optional()
          }

          // Add description if available
          const description = (propSchema as Record<string, unknown>).description as
            | string
            | undefined
          if (description) {
            propType = propType.describe(description)
          }

          shape[key] = propType
        }

        return z.object(shape)
      }

      case "array": {
        const items = schema.items as Record<string, unknown> | undefined
        if (items) {
          return z.array(this.jsonSchemaToZod(items))
        }
        return z.array(z.unknown())
      }

      case "string": {
        let stringSchema = z.string()

        if (schema.enum) {
          return z.enum(schema.enum as [string, ...string[]])
        }
        if (schema.minLength !== undefined) {
          stringSchema = stringSchema.min(schema.minLength as number)
        }
        if (schema.maxLength !== undefined) {
          stringSchema = stringSchema.max(schema.maxLength as number)
        }
        if (schema.pattern) {
          stringSchema = stringSchema.regex(new RegExp(schema.pattern as string))
        }

        return stringSchema
      }

      case "number":
      case "integer": {
        let numberSchema = type === "integer" ? z.number().int() : z.number()

        if (schema.minimum !== undefined) {
          numberSchema = numberSchema.min(schema.minimum as number)
        }
        if (schema.maximum !== undefined) {
          numberSchema = numberSchema.max(schema.maximum as number)
        }

        return numberSchema
      }

      case "boolean":
        return z.boolean()

      case "null":
        return z.null()

      default:
        return z.unknown()
    }
  }

  // ===========================================================================
  // Execution Tracking
  // ===========================================================================

  private recordExecution(toolName: string, result: ToolSandboxExecutionResult): void {
    if (!this.executionHistory.has(toolName)) {
      this.executionHistory.set(toolName, [])
    }

    const history = this.executionHistory.get(toolName)!
    history.push(result)

    // Keep only last 100 executions per tool
    if (history.length > 100) {
      history.shift()
    }
  }

  /**
   * Get execution statistics for a tool
   */
  getToolStats(toolName: string): {
    totalExecutions: number
    successRate: number
    averageDuration: number
  } {
    const history = this.executionHistory.get(toolName) || []

    if (history.length === 0) {
      return { totalExecutions: 0, successRate: 0, averageDuration: 0 }
    }

    const successCount = history.filter((r) => r.success).length
    const totalDuration = history.reduce((sum, r) => sum + r.duration, 0)

    return {
      totalExecutions: history.length,
      successRate: successCount / history.length,
      averageDuration: totalDuration / history.length,
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Get all registered tool names
   */
  getRegisteredToolNames(): string[] {
    return this.config.registry.getAllTools().map((t) => t.name)
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): PluginTool | undefined {
    return this.config.registry.getTool(name)
  }

  /**
   * Check if a tool requires approval
   */
  toolRequiresApproval(name: string): boolean {
    const tool = this.config.registry.getTool(name)
    return tool?.definition.requiresApproval ?? false
  }

  /**
   * Clear execution history
   */
  clearExecutionHistory(): void {
    this.executionHistory.clear()
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginToolsBridge(config: ToolsBridgeConfig): PluginToolsBridge {
  return new PluginToolsBridge(config)
}
