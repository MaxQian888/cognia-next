/**
 * Plugin Registry - Central registry for plugin contributions.
 *
 * Thin facade over five `createOverlayRegistry` instances (one per
 * contribution kind). The public method surface is unchanged so the ~13
 * call sites (tools-bridge, plugin-tool-ipc, manager, stores) keep working;
 * internally the hand-rolled Maps are gone and every registration flows
 * through the single shared factory.
 *
 * Conflict policy: `first-wins-cross-plugin`. When two *different* plugins
 * contribute the same key (tool name, component type, …) the first registrant
 * wins and the later one is rejected + reported as a `plugin.conflict.rejected`
 * diagnostic — no more silent last-wins overwrite. A plugin re-registering its
 * OWN key still refreshes (so hot-reload / snapshot-restore keep working).
 * Modes / commands / templates are namespaced by the manager before they reach
 * here, so cross-plugin collisions only realistically happen for tools and
 * components.
 */

import type {
  PluginTool,
  PluginA2UIComponent,
  PluginCommand,
  A2UITemplateDef,
} from "@/types/plugin"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import {
  createOverlayRegistry,
  type OverlayConflictInfo,
} from "@/lib/plugin/registries/createOverlayRegistry"
import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"
import { loggers } from "./logger"

// Build a first-wins-cross-plugin conflict handler that both logs (dev
// console) and records a diagnostic (plugins panel) for a given registry label.
function makeConflictHandler(label: string): (info: OverlayConflictInfo) => void {
  return (info) => {
    loggers.registry.warn(
      `${label} "${info.key}" already provided by "${info.existingPluginId ?? "?"}"; rejected "${info.incomingPluginId ?? "?"}"`
    )
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: label,
      winnerPluginId: info.existingPluginId,
    })
  }
}

// =============================================================================
// Plugin Registry
// =============================================================================

export class PluginRegistry {
  private tools = createOverlayRegistry<PluginTool>({
    name: "tools",
    conflictPolicy: "first-wins-cross-plugin",
    onConflict: makeConflictHandler("tool"),
  })
  private components = createOverlayRegistry<PluginA2UIComponent>({
    name: "components",
    conflictPolicy: "first-wins-cross-plugin",
    onConflict: makeConflictHandler("component"),
  })
  private templates = createOverlayRegistry<A2UITemplateDef>({
    name: "templates",
    conflictPolicy: "first-wins-cross-plugin",
    onConflict: makeConflictHandler("template"),
  })
  private modes = createOverlayRegistry<AgentModeConfig>({
    name: "modes",
    conflictPolicy: "first-wins-cross-plugin",
    onConflict: makeConflictHandler("mode"),
  })
  private commands = createOverlayRegistry<PluginCommand>({
    name: "commands",
    conflictPolicy: "first-wins-cross-plugin",
    onConflict: makeConflictHandler("command"),
  })

  // ===========================================================================
  // Tools
  // ===========================================================================

  registerTool(pluginId: string, tool: PluginTool): void {
    this.tools.register(tool.name, tool, { pluginId })
  }

  unregisterTool(toolName: string): boolean {
    return this.tools.unregisterById(toolName)
  }

  unregisterPluginTools(pluginId: string): void {
    this.tools.unregisterByPlugin(pluginId)
  }

  getTool(toolName: string): PluginTool | undefined {
    return this.tools.get(toolName)
  }

  getAllTools(): PluginTool[] {
    return this.tools.entries().map((e) => e.entry)
  }

  getToolsByPlugin(pluginId: string): PluginTool[] {
    return this.tools
      .entries()
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.entry)
  }

  // ===========================================================================
  // A2UI Components
  // ===========================================================================

  registerComponent(pluginId: string, component: PluginA2UIComponent): void {
    this.components.register(component.type, component, { pluginId })
  }

  unregisterComponent(componentType: string): boolean {
    return this.components.unregisterById(componentType)
  }

  unregisterPluginComponents(pluginId: string): void {
    this.components.unregisterByPlugin(pluginId)
  }

  getComponent(componentType: string): PluginA2UIComponent | undefined {
    return this.components.get(componentType)
  }

  getAllComponents(): PluginA2UIComponent[] {
    return this.components.entries().map((e) => e.entry)
  }

  getComponentsByPlugin(pluginId: string): PluginA2UIComponent[] {
    return this.components
      .entries()
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.entry)
  }

  // ===========================================================================
  // A2UI Templates
  // ===========================================================================

  registerTemplate(pluginId: string, template: A2UITemplateDef): void {
    // Templates are keyed `<pluginId>:<templateId>` (preserves the original
    // composite key, so cross-plugin collisions can't occur).
    this.templates.register(`${pluginId}:${template.id}`, template, { pluginId })
  }

  unregisterTemplate(templateId: string): boolean {
    return this.templates.unregisterById(templateId)
  }

  unregisterPluginTemplates(pluginId: string): void {
    this.templates.unregisterByPlugin(pluginId)
  }

  getTemplate(templateId: string): A2UITemplateDef | undefined {
    return this.templates.get(templateId)
  }

  getAllTemplates(): A2UITemplateDef[] {
    return this.templates.entries().map((e) => e.entry)
  }

  getTemplatesByPlugin(pluginId: string): A2UITemplateDef[] {
    return this.templates
      .entries()
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.entry)
  }

  getTemplatesByCategory(category: string): A2UITemplateDef[] {
    return this.templates
      .entries()
      .map((e) => e.entry)
      .filter((item) => item.category === category)
  }

  // ===========================================================================
  // Agent Modes
  // ===========================================================================

  registerMode(pluginId: string, mode: AgentModeConfig): void {
    this.modes.register(mode.id, mode, { pluginId })
  }

  unregisterMode(modeId: string): boolean {
    return this.modes.unregisterById(modeId)
  }

  unregisterPluginModes(pluginId: string): void {
    this.modes.unregisterByPlugin(pluginId)
  }

  getMode(modeId: string): AgentModeConfig | undefined {
    return this.modes.get(modeId)
  }

  getAllModes(): AgentModeConfig[] {
    return this.modes.entries().map((e) => e.entry)
  }

  getModesByPlugin(pluginId: string): AgentModeConfig[] {
    return this.modes
      .entries()
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.entry)
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  registerCommand(pluginId: string, command: PluginCommand): void {
    this.commands.register(command.id, command, { pluginId })
  }

  unregisterCommand(commandId: string): boolean {
    return this.commands.unregisterById(commandId)
  }

  unregisterPluginCommands(pluginId: string): void {
    this.commands.unregisterByPlugin(pluginId)
  }

  getCommand(commandId: string): PluginCommand | undefined {
    return this.commands.get(commandId)
  }

  getAllCommands(): PluginCommand[] {
    return this.commands.entries().map((e) => e.entry)
  }

  getCommandsByPlugin(pluginId: string): PluginCommand[] {
    return this.commands
      .entries()
      .filter((e) => e.pluginId === pluginId)
      .map((e) => e.entry)
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
    for (const reg of [this.tools, this.components, this.templates, this.modes, this.commands]) {
      for (const entry of reg.entries()) {
        if (entry.pluginId) pluginIds.add(entry.pluginId)
      }
    }

    return {
      tools: this.tools.list().length,
      components: this.components.list().length,
      templates: this.templates.list().length,
      modes: this.modes.list().length,
      commands: this.commands.list().length,
      plugins: pluginIds.size,
    }
  }

  // ===========================================================================
  // Clear
  // ===========================================================================

  clear(): void {
    this.tools.__resetForTesting()
    this.components.__resetForTesting()
    this.templates.__resetForTesting()
    this.modes.__resetForTesting()
    this.commands.__resetForTesting()
  }
}
