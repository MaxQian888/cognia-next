/**
 * Plugin Registry - Central registry for plugin contributions
 */

import type {
  PluginTool,
  PluginA2UIComponent,
  PluginCommand,
  A2UITemplateDef,
} from "@/types/plugin"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { loggers } from "./logger"

// =============================================================================
// Registry Types
// =============================================================================

interface RegistryEntry<T> {
  pluginId: string
  item: T
  registeredAt: Date
}

// =============================================================================
// Plugin Registry
// =============================================================================

export class PluginRegistry {
  // Tools registry
  private tools: Map<string, RegistryEntry<PluginTool>> = new Map()

  // A2UI components registry
  private components: Map<string, RegistryEntry<PluginA2UIComponent>> = new Map()

  // A2UI templates registry
  private templates: Map<string, RegistryEntry<A2UITemplateDef>> = new Map()

  // Agent modes registry
  private modes: Map<string, RegistryEntry<AgentModeConfig>> = new Map()

  // Commands registry
  private commands: Map<string, RegistryEntry<PluginCommand>> = new Map()

  // ===========================================================================
  // Tools
  // ===========================================================================

  registerTool(pluginId: string, tool: PluginTool): void {
    const key = tool.name
    if (this.tools.has(key)) {
      loggers.registry.warn(`Tool ${key} already registered, overwriting`)
    }
    this.tools.set(key, {
      pluginId,
      item: tool,
      registeredAt: new Date(),
    })
  }

  unregisterTool(toolName: string): boolean {
    return this.tools.delete(toolName)
  }

  unregisterPluginTools(pluginId: string): void {
    for (const [key, entry] of this.tools.entries()) {
      if (entry.pluginId === pluginId) {
        this.tools.delete(key)
      }
    }
  }

  getTool(toolName: string): PluginTool | undefined {
    return this.tools.get(toolName)?.item
  }

  getAllTools(): PluginTool[] {
    return Array.from(this.tools.values()).map((e) => e.item)
  }

  getToolsByPlugin(pluginId: string): PluginTool[] {
    return Array.from(this.tools.values())
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.item)
  }

  // ===========================================================================
  // A2UI Components
  // ===========================================================================

  registerComponent(pluginId: string, component: PluginA2UIComponent): void {
    const key = component.type
    if (this.components.has(key)) {
      loggers.registry.warn(`Component ${key} already registered, overwriting`)
    }
    this.components.set(key, {
      pluginId,
      item: component,
      registeredAt: new Date(),
    })
  }

  unregisterComponent(componentType: string): boolean {
    return this.components.delete(componentType)
  }

  unregisterPluginComponents(pluginId: string): void {
    for (const [key, entry] of this.components.entries()) {
      if (entry.pluginId === pluginId) {
        this.components.delete(key)
      }
    }
  }

  getComponent(componentType: string): PluginA2UIComponent | undefined {
    return this.components.get(componentType)?.item
  }

  getAllComponents(): PluginA2UIComponent[] {
    return Array.from(this.components.values()).map((e) => e.item)
  }

  getComponentsByPlugin(pluginId: string): PluginA2UIComponent[] {
    return Array.from(this.components.values())
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.item)
  }

  // ===========================================================================
  // A2UI Templates
  // ===========================================================================

  registerTemplate(pluginId: string, template: A2UITemplateDef): void {
    const key = `${pluginId}:${template.id}`
    if (this.templates.has(key)) {
      loggers.registry.warn(`Template ${key} already registered, overwriting`)
    }
    this.templates.set(key, {
      pluginId,
      item: template,
      registeredAt: new Date(),
    })
  }

  unregisterTemplate(templateId: string): boolean {
    return this.templates.delete(templateId)
  }

  unregisterPluginTemplates(pluginId: string): void {
    for (const [key, entry] of this.templates.entries()) {
      if (entry.pluginId === pluginId) {
        this.templates.delete(key)
      }
    }
  }

  getTemplate(templateId: string): A2UITemplateDef | undefined {
    return this.templates.get(templateId)?.item
  }

  getAllTemplates(): A2UITemplateDef[] {
    return Array.from(this.templates.values()).map((e) => e.item)
  }

  getTemplatesByPlugin(pluginId: string): A2UITemplateDef[] {
    return Array.from(this.templates.values())
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.item)
  }

  getTemplatesByCategory(category: string): A2UITemplateDef[] {
    return Array.from(this.templates.values())
      .filter((e) => e.item.category === category)
      .map((e) => e.item)
  }

  // ===========================================================================
  // Agent Modes
  // ===========================================================================

  registerMode(pluginId: string, mode: AgentModeConfig): void {
    const key = mode.id
    if (this.modes.has(key)) {
      loggers.registry.warn(`Mode ${key} already registered, overwriting`)
    }
    this.modes.set(key, {
      pluginId,
      item: mode,
      registeredAt: new Date(),
    })
  }

  unregisterMode(modeId: string): boolean {
    return this.modes.delete(modeId)
  }

  unregisterPluginModes(pluginId: string): void {
    for (const [key, entry] of this.modes.entries()) {
      if (entry.pluginId === pluginId) {
        this.modes.delete(key)
      }
    }
  }

  getMode(modeId: string): AgentModeConfig | undefined {
    return this.modes.get(modeId)?.item
  }

  getAllModes(): AgentModeConfig[] {
    return Array.from(this.modes.values()).map((e) => e.item)
  }

  getModesByPlugin(pluginId: string): AgentModeConfig[] {
    return Array.from(this.modes.values())
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.item)
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  registerCommand(pluginId: string, command: PluginCommand): void {
    const key = command.id
    if (this.commands.has(key)) {
      loggers.registry.warn(`Command ${key} already registered, overwriting`)
    }
    this.commands.set(key, {
      pluginId,
      item: command,
      registeredAt: new Date(),
    })
  }

  unregisterCommand(commandId: string): boolean {
    return this.commands.delete(commandId)
  }

  unregisterPluginCommands(pluginId: string): void {
    for (const [key, entry] of this.commands.entries()) {
      if (entry.pluginId === pluginId) {
        this.commands.delete(key)
      }
    }
  }

  getCommand(commandId: string): PluginCommand | undefined {
    return this.commands.get(commandId)?.item
  }

  getAllCommands(): PluginCommand[] {
    return Array.from(this.commands.values()).map((e) => e.item)
  }

  getCommandsByPlugin(pluginId: string): PluginCommand[] {
    return Array.from(this.commands.values())
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.item)
  }

  // ===========================================================================
  // Plugin Cleanup
  // ===========================================================================

  unregisterAll(pluginId: string): void {
    this.unregisterPluginTools(pluginId)
    this.unregisterPluginComponents(pluginId)
    this.unregisterPluginTemplates(pluginId)
    this.unregisterPluginModes(pluginId)
    this.unregisterPluginCommands(pluginId)
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getStats(): {
    tools: number
    components: number
    templates: number
    modes: number
    commands: number
    plugins: number
  } {
    const pluginIds = new Set<string>()

    for (const entry of this.tools.values()) pluginIds.add(entry.pluginId)
    for (const entry of this.components.values()) pluginIds.add(entry.pluginId)
    for (const entry of this.templates.values()) pluginIds.add(entry.pluginId)
    for (const entry of this.modes.values()) pluginIds.add(entry.pluginId)
    for (const entry of this.commands.values()) pluginIds.add(entry.pluginId)

    return {
      tools: this.tools.size,
      components: this.components.size,
      templates: this.templates.size,
      modes: this.modes.size,
      commands: this.commands.size,
      plugins: pluginIds.size,
    }
  }

  // ===========================================================================
  // Clear
  // ===========================================================================

  clear(): void {
    this.tools.clear()
    this.components.clear()
    this.templates.clear()
    this.modes.clear()
    this.commands.clear()
  }
}
