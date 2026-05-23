/**
 * Canvas Plugin Manager - Canvas-specific plugin extensions
 * Integrates with the main plugin system at lib/plugin
 */

import { loggers } from "@/lib/logging"
import { getPluginManager } from "@/lib/plugin/core/manager"

const log = loggers.plugin

export interface CanvasPlugin {
  id: string
  name: string
  version: string
  description: string
  author?: string
  enabled: boolean

  onMount?: (context: PluginContext) => void | Promise<void>
  onUnmount?: () => void | Promise<void>
  onContentChange?: (content: string, language: string) => void
  onSelectionChange?: (selection: string, range: SelectionRange) => void
  onSave?: (content: string) => void

  provideCompletionItems?: (
    context: CompletionContext
  ) => PluginCompletionItem[] | Promise<PluginCompletionItem[]>

  provideDiagnostics?: (
    content: string,
    language: string
  ) => PluginDiagnostic[] | Promise<PluginDiagnostic[]>

  provideActions?: (content: string, selection: string) => PluginAction[]

  provideHover?: (word: string, position: Position) => PluginHoverInfo | null
}

export interface PluginContext {
  documentId: string
  language: string
  getContent: () => string
  setContent: (content: string) => void
  getSelection: () => string
  insertText: (text: string, position?: Position) => void
  replaceSelection: (text: string) => void
  showNotification: (message: string, type: "info" | "warning" | "error") => void
  registerCommand: (command: PluginCommand) => void
}

export interface PluginCommand {
  id: string
  label: string
  keybinding?: string
  handler: () => void | Promise<void>
}

export interface CompletionContext {
  word: string
  position: Position
  lineContent: string
  language: string
}

export interface PluginCompletionItem {
  label: string
  kind: "function" | "variable" | "class" | "keyword" | "snippet" | "text"
  insertText: string
  detail?: string
  documentation?: string
  sortText?: string
}

export interface PluginDiagnostic {
  message: string
  severity: "error" | "warning" | "info" | "hint"
  range: SelectionRange
  source?: string
  code?: string | number
}

export interface PluginAction {
  id: string
  label: string
  icon?: string
  handler: (content: string, selection: string) => string | Promise<string>
}

export interface PluginHoverInfo {
  contents: string | string[]
  range?: SelectionRange
}

export interface Position {
  line: number
  column: number
}

export interface SelectionRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface PluginState {
  plugins: Map<string, CanvasPlugin>
  enabledPlugins: Set<string>
  context: PluginContext | null
}

export class CanvasPluginManager {
  private plugins: Map<string, CanvasPlugin> = new Map()
  private enabledPlugins: Set<string> = new Set()
  private context: PluginContext | null = null
  private commands: Map<string, PluginCommand> = new Map()

  registerPlugin(plugin: CanvasPlugin): boolean {
    if (this.plugins.has(plugin.id)) {
      return false
    }

    this.plugins.set(plugin.id, plugin)
    this.syncWithMainManager(plugin.id, "register")

    if (plugin.enabled) {
      this.enablePlugin(plugin.id)
    }

    return true
  }

  unregisterPlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return false

    if (this.enabledPlugins.has(pluginId)) {
      this.disablePlugin(pluginId)
    }
    this.syncWithMainManager(pluginId, "unregister")

    return this.plugins.delete(pluginId)
  }

  enablePlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return false

    plugin.enabled = true
    this.enabledPlugins.add(pluginId)
    this.syncWithMainManager(pluginId, "enable")

    if (this.context && plugin.onMount) {
      try {
        plugin.onMount(this.context)
      } catch (error) {
        log.error(`Failed to mount plugin ${pluginId}`, error as Error)
      }
    }

    return true
  }

  disablePlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return false

    plugin.enabled = false
    this.enabledPlugins.delete(pluginId)
    this.syncWithMainManager(pluginId, "disable")

    if (plugin.onUnmount) {
      try {
        plugin.onUnmount()
      } catch (error) {
        log.error(`Failed to unmount plugin ${pluginId}`, error as Error)
      }
    }

    return true
  }

  private syncWithMainManager(
    pluginId: string,
    action: "register" | "unregister" | "enable" | "disable"
  ): void {
    let manager: ReturnType<typeof getPluginManager> | null = null
    try {
      manager = getPluginManager()
    } catch {
      return
    }

    if (!manager) {
      return
    }

    if (action === "enable") {
      void manager.enablePlugin(pluginId).catch((error) => {
        log.warn(`Failed to sync enable for ${pluginId}`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return
    }
    if (action === "disable") {
      void manager.disablePlugin(pluginId).catch((error) => {
        log.warn(`Failed to sync disable for ${pluginId}`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return
    }
    if (action === "unregister") {
      void manager.unloadPlugin(pluginId).catch((error) => {
        log.warn(`Failed to sync unregister for ${pluginId}`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return
    }
  }

  getPlugin(pluginId: string): CanvasPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  getAllPlugins(): CanvasPlugin[] {
    return Array.from(this.plugins.values())
  }

  getEnabledPlugins(): CanvasPlugin[] {
    return this.getAllPlugins().filter((p) => p.enabled)
  }

  setContext(context: PluginContext): void {
    this.context = {
      ...context,
      registerCommand: (command: PluginCommand) => {
        this.commands.set(command.id, command)
      },
    }

    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      if (plugin?.onMount) {
        try {
          plugin.onMount(this.context)
        } catch (error) {
          log.error(`Failed to mount plugin ${pluginId}`, error as Error)
        }
      }
    }
  }

  clearContext(): void {
    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      if (plugin?.onUnmount) {
        try {
          plugin.onUnmount()
        } catch (error) {
          log.error(`Failed to unmount plugin ${pluginId}`, error as Error)
        }
      }
    }
    this.context = null
    this.commands.clear()
  }

  executeHook<K extends keyof CanvasPlugin>(
    hookName: K,
    ...args: Parameters<
      NonNullable<CanvasPlugin[K]> extends (...args: infer P) => unknown
        ? (...args: P) => unknown
        : never
    >
  ): void {
    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      const hook = plugin?.[hookName]
      if (typeof hook === "function") {
        try {
          ;(hook as (...args: unknown[]) => void).apply(plugin, args)
        } catch (error) {
          log.error(
            `Error executing hook ${String(hookName)} in plugin ${pluginId}`,
            error as Error
          )
        }
      }
    }
  }

  async collectCompletions(context: CompletionContext): Promise<PluginCompletionItem[]> {
    const items: PluginCompletionItem[] = []

    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      if (plugin?.provideCompletionItems) {
        try {
          const pluginItems = await plugin.provideCompletionItems(context)
          items.push(...pluginItems)
        } catch (error) {
          log.error(`Error getting completions from plugin ${pluginId}`, error as Error)
        }
      }
    }

    return items
  }

  async collectDiagnostics(content: string, language: string): Promise<PluginDiagnostic[]> {
    const diagnostics: PluginDiagnostic[] = []

    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      if (plugin?.provideDiagnostics) {
        try {
          const pluginDiagnostics = await plugin.provideDiagnostics(content, language)
          diagnostics.push(...pluginDiagnostics)
        } catch (error) {
          log.error(`Error getting diagnostics from plugin ${pluginId}`, error as Error)
        }
      }
    }

    return diagnostics
  }

  collectActions(content: string, selection: string): PluginAction[] {
    const actions: PluginAction[] = []

    for (const pluginId of this.enabledPlugins) {
      const plugin = this.plugins.get(pluginId)
      if (plugin?.provideActions) {
        try {
          const pluginActions = plugin.provideActions(content, selection)
          actions.push(...pluginActions)
        } catch (error) {
          log.error(`Error getting actions from plugin ${pluginId}`, error as Error)
        }
      }
    }

    return actions
  }

  getCommands(): PluginCommand[] {
    return Array.from(this.commands.values())
  }

  executeCommand(commandId: string): void {
    const command = this.commands.get(commandId)
    if (command) {
      try {
        command.handler()
      } catch (error) {
        log.error(`Error executing command ${commandId}`, error as Error)
      }
    }
  }

  exportPluginList(): string {
    const list = this.getAllPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      enabled: p.enabled,
    }))
    return JSON.stringify(list, null, 2)
  }
}

export const pluginManager = new CanvasPluginManager()

export default CanvasPluginManager
