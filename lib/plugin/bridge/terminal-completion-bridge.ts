/**
 * Terminal Completion Bridge (ADR-0039).
 *
 * Resolves `manifest.terminalCompletionProviders` on plugin enable. Each
 * entry is a lazy factory `{ id, label, entry, export, priority? }`; the
 * bridge dynamic-imports the module, calls the named factory to produce a
 * `PluginTerminalCompletionProvider`, adapts it to the host
 * `TerminalCompletionProvider` shape, and registers it into the shared
 * completion registry (`lib/terminal/completion/registry.ts`).
 *
 * The same adapter + registration helper backs the imperative path
 * (`ctx.terminal.registerCompletionProvider`), so both declarative and
 * runtime providers behave identically and are cleaned up together by
 * `unregisterTerminalCompletionProvidersForPlugin`.
 *
 * Modeled on `ai-providers-bridge.ts` (ADR-0026 §F).
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import type {
  PluginTerminalCompletionFactory,
  PluginTerminalCompletionProvider,
  PluginTerminalCompletionProviderDef,
} from "@/types/plugin/plugin-terminal-completion"
import type {
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "@/lib/terminal/completion/types"
import { registerCompletionProvider } from "@/lib/terminal/completion/registry"
import { loggers } from "@/lib/plugin/core/logger"

const unregistrarsByPlugin = new Map<string, Array<() => void>>()

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

const DEFAULT_IMPORTER: NonNullable<TerminalCompletionBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

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
            shell: context.shell,
            shellPath: context.shellPath,
            cwd: context.cwd,
            input: context.input,
            recentCommands: context.recentCommands,
            platform: context.platform,
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
            score: it.score,
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

export async function registerTerminalCompletionProvidersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: TerminalCompletionBridgeOptions = {}
): Promise<TerminalCompletionBridgeResult> {
  const pluginId = manifest.id
  const defs = (manifest.terminalCompletionProviders ?? []) as PluginTerminalCompletionProviderDef[]
  if (defs.length === 0) return { registered: 0, errors: [] }

  // Clear prior registrations on re-enable.
  unregisterTerminalCompletionProvidersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: TerminalCompletionBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const resolved = resolvePluginPath(installRoot, def.entry)
      const mod = await importer(resolved)
      const exported = mod[def.export]
      if (typeof exported !== "function") {
        throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
      }
      const factory = exported as PluginTerminalCompletionFactory
      const provider = await factory({
        pluginId,
        providerId: `${pluginId}:${def.id}`,
        getConfig: <T = unknown>(key: string) =>
          options.getConfig?.(pluginId, key) as T | undefined,
      })
      if (!provider || typeof provider.getCompletions !== "function") {
        throw new Error(`factory "${def.export}" did not return a completion provider`)
      }
      const host = adaptPluginCompletionProvider(
        pluginId,
        { id: def.id, label: def.label, priority: def.priority },
        provider
      )
      registerPluginCompletionProvider(pluginId, host)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, providerId: def.id, message })
      loggers.manager.error(
        `[terminal-completion-bridge] failed to register ${pluginId}:${def.id}`,
        err
      )
    }
  }

  return { registered, errors }
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
