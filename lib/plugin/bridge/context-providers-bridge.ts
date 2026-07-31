/**
 * Context Providers Bridge.
 *
 * Resolves `manifest.contextProviders` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same posture
 * as `routing-strategy`). Each entry is an ADR-0026 lazy factory
 * `{ id, label, entry, export }`: the bridge dynamic-imports the entry, calls
 * the factory, and registers the returned {@link PluginContextProvider} into
 * the context-provider registry under the namespaced id `${pluginId}:${def.id}`
 * (parity with every other lazy bridge — the imperative
 * `ctx.agent.context.registerProvider` path uses bare ids).
 *
 * Consumed downstream by `resolveContextContributions`
 * (`lib/plugin/agent-sdk/context-providers.ts`), which appends each provider's
 * `provide()` output to the system prompt of the plugin's agent runs.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginContextProviderDef,
  PluginContextProviderFactory,
} from "@/types/plugin/plugin-context-provider"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  registerContextProvider,
  unregisterContextProvidersByPlugin,
} from "@/lib/plugin/registries/context-provider-registry"

export interface ContextProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface ContextProvidersBridgeResult {
  registered: number
  errors: ContextProvidersBridgeError[]
}

export interface ContextProvidersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<ContextProvidersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerContextProvidersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ContextProvidersBridgeOptions = {}
): Promise<ContextProvidersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.contextProviders ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterContextProvidersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ContextProvidersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      await registerOne(def, pluginId, manifest.type, installRoot, importer)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, providerId: def.id, message })
      loggers.manager.error(
        `[context-providers-bridge] failed to register ${pluginId}:${def.id}`,
        err
      )
    }
  }

  return { registered, errors }
}

async function registerOne(
  def: PluginContextProviderDef,
  pluginId: string,
  pluginType: string | undefined,
  installRoot: string,
  importer: NonNullable<ContextProvidersBridgeOptions["importer"]>
): Promise<void> {
  const providerId = `${pluginId}:${def.id}`
  const provider = isPythonBackedContribution(def, pluginType)
    ? createPythonBackedProxy<Awaited<ReturnType<PluginContextProviderFactory>>>({
        pluginId,
        contributionId: def.id,
        methods: ["provide"],
        label: "context provider",
      })
    : await resolveJsProvider(def, pluginId, providerId, installRoot, importer)

  registerContextProvider(
    providerId,
    {
      id: providerId,
      name: def.label ?? provider.name ?? providerId,
      provide: (input) => provider.provide(input),
    },
    { pluginId }
  )
}

async function resolveJsProvider(
  def: PluginContextProviderDef,
  pluginId: string,
  providerId: string,
  installRoot: string,
  importer: NonNullable<ContextProvidersBridgeOptions["importer"]>
): Promise<Awaited<ReturnType<PluginContextProviderFactory>>> {
  if (!def.entry || !def.export) {
    throw new Error(
      `JS-backed context provider "${def.id}" must declare both "entry" and "export"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
  }
  const factory = exported as PluginContextProviderFactory
  const provider = await factory({ providerId, pluginId })
  if (!provider || typeof provider.provide !== "function") {
    throw new Error(`factory "${def.export}" did not return a { provide } context provider`)
  }
  return provider
}

export function unregisterContextProvidersForPlugin(pluginId: string): void {
  unregisterContextProvidersByPlugin(pluginId)
}
