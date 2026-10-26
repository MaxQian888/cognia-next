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
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { canRunPythonBackedContribution } from "@/lib/plugin/python/experimental-flag"
import type {
  PluginTerminalCompletionFactory,
  PluginTerminalCompletionProviderDef,
} from "@/types/plugin/plugin-terminal-completion"
import { loggers } from "@/lib/plugin/core/logger"
import {
  adaptPluginCompletionProvider,
  registerPluginCompletionProvider,
  unregisterTerminalCompletionProvidersForPlugin,
  type TerminalCompletionBridgeError,
  type TerminalCompletionBridgeOptions,
  type TerminalCompletionBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/terminal-completion-bridge"
export {
  adaptPluginCompletionProvider,
  registerPluginCompletionProvider,
  unregisterTerminalCompletionProvidersForPlugin,
} from "@cognia/plugin-contract/lib/plugin/bridge/terminal-completion-bridge"
export type {
  TerminalCompletionBridgeError,
  TerminalCompletionBridgeResult,
  TerminalCompletionBridgeOptions,
} from "@cognia/plugin-contract/lib/plugin/bridge/terminal-completion-bridge"

const DEFAULT_IMPORTER: NonNullable<TerminalCompletionBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

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
      let provider: Awaited<ReturnType<PluginTerminalCompletionFactory>>
      if (isPythonBackedContribution(def, manifest.type)) {
        if (!canRunPythonBackedContribution("terminalCompletionProviders")) {
          throw new Error(
            `python-backed completion provider "${def.id}" is experimental and the flag is off`
          )
        }
        // NOTE: inline terminal completion is latency-budgeted; a python-backed
        // provider pays an extra IPC round-trip per keystroke-batch, which is
        // why `pythonExecution` for this capability is "experimental".
        provider = createPythonBackedProxy<Awaited<ReturnType<PluginTerminalCompletionFactory>>>({
          pluginId,
          contributionId: def.id,
          methods: ["getCompletions"],
          label: "terminal completion provider",
        })
      } else {
        if (!def.entry || !def.export) {
          throw new Error(
            `JS-backed completion provider "${def.id}" must declare both "entry" and "export"` +
              ` (set backend: "python" to run it in the plugin's Python subprocess)`
          )
        }
        const resolved = resolvePluginPath(installRoot, def.entry)
        const mod = await importer(resolved)
        const exported = mod[def.export]
        if (typeof exported !== "function") {
          throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
        }
        const factory = exported as PluginTerminalCompletionFactory
        provider = await factory({
          pluginId,
          providerId: `${pluginId}:${def.id}`,
          getConfig: <T = unknown>(key: string) =>
            options.getConfig?.(pluginId, key) as T | undefined,
        })
      }
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
