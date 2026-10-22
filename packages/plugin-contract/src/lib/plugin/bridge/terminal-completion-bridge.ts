/**
 * The plugin contract's share of `lib/plugin/bridge/terminal-completion-bridge.ts`, which re-exports these.
 */

import type { PluginTerminalCompletionProvider } from "../../../types/plugin/plugin-terminal-completion"
import type {
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "../../terminal/completion/types"
import { registerCompletionProvider } from "../../terminal/completion/registry"
import { loggers } from "../core/logger"

export interface TerminalCompletionBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface TerminalCompletionBridgeResult {
  registered: number
  errors: TerminalCompletionBridgeError[]
}

export interface TerminalCompletionBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
}

const unregistrarsByPlugin = new Map<string, Array<() => void>>()

/**
 * Adapt a plugin completion provider into the host shape: namespace the
 * id, map the read-only context across, tag every suggestion as
 * `plugin`-sourced, and isolate errors / malformed items.
 */
export function adaptPluginCompletionProvider(
  pluginId: string,
  def: { id: string; label: string; priority?: number },
  provider: Pick<PluginTerminalCompletionProvider, "getCompletions">
): TerminalCompletionProvider {
  const providerId = `${pluginId}:${def.id}`
  return {
    id: providerId,
    label: def.label,
    priority: def.priority,
    getCompletions: async (
      context: TerminalCompletionContext,
      signal: AbortSignal
    ): Promise<TerminalCompletionSuggestion[]> => {
      try {
        const items = await provider.getCompletions(
          {
            sessionId: context.sessionId,
            shell: context.shell,
            shellPath: context.shellPath,
            cwd: context.cwd,
            input: context.input,
            cursor: context.cursor,
            recentCommands: context.recentCommands,
            platform: context.platform,
            projectId: context.projectId,
          },
          signal
        )
        if (!Array.isArray(items)) return []
        return items
          .filter((it) => it && typeof it.text === "string" && it.text.length > 0)
          .map((it) => ({
            text: it.text,
            source: "plugin" as const,
            providerId,
            detail: it.detail,
            description: it.description,
            score: it.score,
            replace:
              it.replace &&
              Number.isInteger(it.replace.from) &&
              it.replace.from >= 0 &&
              typeof it.replace.insert === "string"
                ? { from: it.replace.from, insert: it.replace.insert }
                : undefined,
          }))
      } catch {
        return []
      }
    },
  }
}

/**
 * Register a host completion provider on behalf of a plugin and track its
 * disposer so `unregisterTerminalCompletionProvidersForPlugin` (plugin
 * teardown) can clean it up. The returned disposer also detaches the
 * tracking entry.
 */
export function registerPluginCompletionProvider(
  pluginId: string,
  hostProvider: TerminalCompletionProvider
): () => void {
  const off = registerCompletionProvider(hostProvider)
  let list = unregistrarsByPlugin.get(pluginId)
  if (!list) {
    list = []
    unregistrarsByPlugin.set(pluginId, list)
  }
  const disposer = () => {
    off()
    const arr = unregistrarsByPlugin.get(pluginId)
    if (arr) {
      const idx = arr.indexOf(disposer)
      if (idx !== -1) arr.splice(idx, 1)
      if (arr.length === 0) unregistrarsByPlugin.delete(pluginId)
    }
  }
  list.push(disposer)
  return disposer
}

export function unregisterTerminalCompletionProvidersForPlugin(pluginId: string): void {
  const unregs = unregistrarsByPlugin.get(pluginId)
  if (!unregs) return
  // Copy — each disposer mutates the underlying array.
  for (const fn of [...unregs]) {
    try {
      fn()
    } catch (err) {
      loggers.manager.warn(`[terminal-completion-bridge] unregister threw for ${pluginId}`, err)
    }
  }
  unregistrarsByPlugin.delete(pluginId)
}
