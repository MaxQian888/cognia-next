/**
 * AI Providers Bridge.
 *
 * Resolves `manifest.aiProviders` contributions on plugin enable. Each
 * entry is a lazy factory: `{ kind, id, label, entry, export, ... }`.
 *
 * The bridge dynamic-imports the entry, calls the named factory to produce
 * a `PluginLlmProvider` or `PluginEmbeddingProvider`, then adapts it to
 * the existing host `AIProviderDefinition` shape and registers via
 * `createAIProviderAPI(pluginId).registerProvider(...)`.
 *
 * The host `AIProviderDefinition` expects:
 *   - `chat`: AsyncIterable<AIChatChunk> generator.
 *   - `embed`: (texts) => Promise<number[][]>.
 *
 * Plugin authors using the new API can supply the simpler buffered
 * `complete(req)` / `embed(req)` shapes — this bridge wraps them.
 *
 * See ADR-0026 §2 §F.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginAiProviderDef,
  PluginAiProviderFactory,
  PluginLlmProvider,
  PluginEmbeddingProvider,
  AiMessage,
} from "@/types/plugin/plugin-ai-provider"
import type { CatalogContribution } from "@cognia/provider-types/model-catalog"
import type { CatalogRepository } from "@cognia/provider-core/providers/catalog-repository"
import type {
  AIProviderDefinition,
  AIChatMessage,
  AIChatChunk,
  AIChatOptions,
} from "@/types/plugin/plugin"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { createAIProviderAPI } from "@/lib/plugin/api/ai-provider-api"
import { providerCatalogRepository } from "@/lib/db/provider-catalog"

const unregistrarsByPlugin = new Map<string, Array<() => void>>()

export interface AiProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface AiProvidersBridgeResult {
  registered: number
  errors: AiProvidersBridgeError[]
}

export interface AiProvidersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
  getSecret?: (pluginId: string, key: string) => Promise<string | undefined>
  catalogRepository?: CatalogRepository
}

const DEFAULT_IMPORTER: NonNullable<AiProvidersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerAiProvidersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: AiProvidersBridgeOptions = {}
): Promise<AiProvidersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.aiProviders ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterAiProvidersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const api = createAIProviderAPI(pluginId)
  const errors: AiProvidersBridgeError[] = []
  const unregistrars: Array<() => void> = []
  let registered = 0

  for (const def of defs) {
    const entryUnregistrars: Array<() => void> = []
    try {
      if (def.catalog) {
        const repository = options.catalogRepository ?? providerCatalogRepository
        entryUnregistrars.push(
          repository.registerContribution(pluginId, catalogContribution(pluginId, def))
        )
      }
      const hasExecutableAdapter =
        Boolean(def.entry || def.export || def.backend) || manifest.type === "python"
      if (hasExecutableAdapter || !def.catalog) {
        const adapted = await adaptProvider(
          def,
          pluginId,
          manifest.type,
          installRoot,
          importer,
          options
        )
        entryUnregistrars.push(api.registerProvider(adapted))
      }
      unregistrars.push(...entryUnregistrars)
      registered++
    } catch (err) {
      for (const unregister of entryUnregistrars.reverse()) unregister()
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, providerId: def.id, message })
      loggers.manager.error(`[ai-providers-bridge] failed to register ${pluginId}:${def.id}`, err)
    }
  }

  if (unregistrars.length > 0) {
    unregistrarsByPlugin.set(pluginId, unregistrars)
  }
  return { registered, errors }
}

function catalogContribution(pluginId: string, def: PluginAiProviderDef): CatalogContribution {
  if (!def.catalog) throw new Error("catalog contribution is missing")
  const providerId = `${pluginId}:${def.id}`
  const localModelIds = new Set((def.catalog.models ?? []).map((model) => model.id))
  const modelRef = (ref: string) => (localModelIds.has(ref) ? `${pluginId}:${ref}` : ref)
  return {
    providers: [
      {
        id: providerId,
        name: def.label,
        tier: def.catalog.tier ?? "experimental",
        source: { kind: "plugin", id: pluginId },
        modalities: def.catalog.modalities,
        adapterFamilies: [def.catalog.adapterFamily],
        connectionSchema: { fields: [] },
      },
    ],
    models: (def.catalog.models ?? []).map((model) => ({
      id: `${pluginId}:${model.id}`,
      name: model.name,
      creator: model.creator ?? pluginId,
      family: model.family,
      modalities: model.modalities,
      capabilities: model.capabilities ?? {},
      limits: model.limits,
      lifecycle: model.lifecycle ?? "active",
      provenance: { definition: { kind: "plugin", id: pluginId } },
    })),
    offerings: def.catalog.offerings.map((offering) => ({
      id: `${pluginId}:${def.id}:${offering.id}`,
      providerRef: providerId,
      modelRef: modelRef(offering.modelRef),
      upstreamId: offering.upstreamId,
      endpointType: offering.endpointType,
      lifecycle: offering.lifecycle ?? "active",
      available: true,
      capabilities: offering.capabilities,
      limits: offering.limits,
      source: { kind: "plugin", id: pluginId },
    })),
  }
}

async function adaptProvider(
  def: PluginAiProviderDef,
  pluginId: string,
  pluginType: string | undefined,
  installRoot: string,
  importer: NonNullable<AiProvidersBridgeOptions["importer"]>,
  options: AiProvidersBridgeOptions
): Promise<AIProviderDefinition> {
  // Every host-facing field (label, models, description) comes from the
  // manifest def, so a python-backed provider only has to supply behaviour.
  const provider = isPythonBackedContribution(def, pluginType)
    ? createPythonBackedProxy<PluginLlmProvider & PluginEmbeddingProvider>({
        pluginId,
        contributionId: def.id,
        methods: [def.kind === "llm" ? "complete" : "embed"],
        label: "AI provider",
      })
    : await resolveJsProvider(def, pluginId, installRoot, importer, options)

  if (def.kind === "llm") {
    const llm = provider as PluginLlmProvider
    if (typeof llm.complete !== "function") {
      throw new Error(`factory "${def.export}" did not return a PluginLlmProvider`)
    }
    return adaptLlmToHost(def, llm)
  }

  const embed = provider as PluginEmbeddingProvider
  if (typeof embed.embed !== "function") {
    throw new Error(`factory "${def.export}" did not return a PluginEmbeddingProvider`)
  }
  return adaptEmbeddingToHost(def, embed)
}

async function resolveJsProvider(
  def: PluginAiProviderDef,
  pluginId: string,
  installRoot: string,
  importer: NonNullable<AiProvidersBridgeOptions["importer"]>,
  options: AiProvidersBridgeOptions
): Promise<PluginLlmProvider | PluginEmbeddingProvider> {
  if (!def.entry || !def.export) {
    throw new Error(
      `JS-backed AI provider "${def.id}" must declare both "entry" and "export"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
  }
  const factory = exported as PluginAiProviderFactory
  const ctx = {
    providerId: `${pluginId}:${def.id}`,
    pluginId,
    kind: def.kind,
    getConfig: <T = unknown>(key: string) => options.getConfig?.(pluginId, key) as T | undefined,
    getSecret: (key: string) => Promise.resolve(options.getSecret?.(pluginId, key) ?? undefined),
  }
  return factory(ctx)
}

function adaptLlmToHost(def: PluginAiProviderDef, llm: PluginLlmProvider): AIProviderDefinition {
  if (def.kind !== "llm") throw new Error("adaptLlmToHost requires kind=llm def")
  return {
    id: def.id,
    name: def.label,
    description: def.description ?? "",
    models: (def.models ?? []).map((modelId) => ({
      id: modelId,
      name: modelId,
      provider: def.id,
      contextLength: 0,
      capabilities: ["chat"],
    })),
    // The host's AIProviderDefinition.chat returns an AsyncIterable. We
    // adapt the simpler buffered `complete()` shape into a single-chunk
    // async generator — plugins that want true streaming can supply a
    // richer host implementation in a follow-up (ADR-0026 §F keeps the
    // minimal surface unambiguous).
    chat: (messages: AIChatMessage[], options?: AIChatOptions): AsyncIterable<AIChatChunk> => {
      const ai: AiMessage[] = messages.map((m) => ({
        role: m.role === "system" ? "system" : m.role === "user" ? "user" : "assistant",
        content: m.content,
      }))
      async function* gen(): AsyncIterable<AIChatChunk> {
        const res = await llm.complete({
          messages: ai,
          model: options?.model,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
        })
        yield { content: res.text }
      }
      return gen()
    },
    embed: undefined,
  }
}

function adaptEmbeddingToHost(
  def: PluginAiProviderDef,
  embed: PluginEmbeddingProvider
): AIProviderDefinition {
  if (def.kind !== "embedding") throw new Error("adaptEmbeddingToHost requires kind=embedding def")
  return {
    id: def.id,
    name: def.label,
    description: def.description ?? "",
    models: [
      {
        id: def.id,
        name: def.label,
        provider: def.id,
        contextLength: 0,
        capabilities: ["embedding"],
      },
    ],
    chat: (_messages: AIChatMessage[], _options?: AIChatOptions): AsyncIterable<AIChatChunk> => {
      async function* gen(): AsyncIterable<AIChatChunk> {
        throw new Error(`provider ${def.id} is embedding-only and cannot serve chat`)
      }
      return gen()
    },
    embed: async (texts: string[]) => {
      const res = await embed.embed({ texts })
      return res.vectors
    },
  }
}

export function unregisterAiProvidersForPlugin(pluginId: string): void {
  const unregs = unregistrarsByPlugin.get(pluginId)
  if (!unregs) return
  for (const fn of unregs) {
    try {
      fn()
    } catch (err) {
      loggers.manager.warn(`[ai-providers-bridge] unregister threw for ${pluginId}`, err)
    }
  }
  unregistrarsByPlugin.delete(pluginId)
}
