/**
 * Dynamic provider registry.
 *
 * Plugins can register an AI provider definition at runtime; the
 * settings UI and the projection layer subscribe to this registry to
 * surface plugin-contributed providers in the picker. Disabling the
 * plugin removes its providers via `unregisterProvider`.
 *
 * The registry is purely in-memory — provider definitions disappear on
 * reload. Plugins that want their providers to persist must call
 * register on every activation.
 */

import { setDynamicProviderRegistry } from "@cognia/provider-types"

import type {
  ProviderConfig,
  ModelConfig,
  ProviderType as CanonicalProviderType,
} from "@cognia/provider-types/provider"

export type ProviderType = "cloud" | "local" | "self-hosted"

export type ProviderProtocol = "openai" | "anthropic" | "google" | "mistral" | "cohere"

export interface ProviderModelDefinition {
  id: string
  name: string
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsStreaming: boolean
}

export interface ProviderDefinition {
  id: string
  name: string
  type: ProviderType
  protocol: ProviderProtocol
  apiKeyRequired: boolean
  baseURLRequired: boolean
  defaultModel: string
  defaultEnabled: boolean
  category: "core" | "specialized" | "experimental"
  description?: string
  models: ProviderModelDefinition[]
}

export type ProviderSource = "builtin" | "plugin"

interface RegistryEntry {
  definition: ProviderDefinition
  source: ProviderSource
}

const registry = new Map<string, RegistryEntry>()

export function registerProviderDefinition(
  definition: ProviderDefinition,
  source: ProviderSource = "builtin"
): { replaced: boolean } {
  if (!definition.id) {
    throw new Error("registerProviderDefinition: id is required")
  }
  const replaced = registry.has(definition.id)
  registry.set(definition.id, { definition, source })
  return { replaced }
}

export function unregisterProvider(providerId: string): boolean {
  return registry.delete(providerId)
}

export function unregisterProvidersBySource(source: ProviderSource): number {
  let removed = 0
  for (const [id, entry] of registry) {
    if (entry.source === source) {
      registry.delete(id)
      removed += 1
    }
  }
  return removed
}

export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return registry.get(providerId)?.definition
}

export function listProviderDefinitions(filter?: {
  source?: ProviderSource
}): ProviderDefinition[] {
  const out: ProviderDefinition[] = []
  for (const entry of registry.values()) {
    if (filter?.source && entry.source !== filter.source) continue
    out.push(entry.definition)
  }
  return out
}

/** Test-only escape hatch. */
export function __resetProviderRegistryForTesting(): void {
  registry.clear()
}

/**
 * Returns plugin-registered providers in the ProviderConfig shape so they
 * can be merged into getAllProviders(). Adapts ProviderDefinition →
 * ProviderConfig: maps protocol/category/type to the narrower canonical
 * unions used throughout the rest of the codebase.
 */
export function getDynamicProviders(): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = {}
  for (const def of listProviderDefinitions()) {
    out[def.id] = adaptDefinitionToConfig(def)
  }
  return out
}

// Wire this host-side dynamic-provider source into @cognia/provider-types so
// `getAllProviders()` (which now lives in the package and can't import the app)
// merges plugin-registered providers. Dynamic providers are only ever populated
// through `registerProviderDefinition` in THIS module, so importing it for that
// registration also guarantees this wiring runs first — before any dynamic
// provider could exist. Until then the package's default returns an empty map,
// matching the prior behaviour exactly.
setDynamicProviderRegistry(getDynamicProviders)

function adaptDefinitionToConfig(def: ProviderDefinition): ProviderConfig {
  return {
    id: def.id,
    name: def.name,
    type: adaptType(def.type),
    apiKeyRequired: def.apiKeyRequired,
    baseURLRequired: def.baseURLRequired,
    protocol: adaptProtocol(def.protocol),
    defaultEnabled: def.defaultEnabled,
    defaultModel: def.defaultModel,
    description: def.description,
    category: adaptCategory(def.category),
    models: def.models.map(adaptModel),
  }
}

function adaptType(t: ProviderType): CanonicalProviderType {
  return t === "cloud" ? "cloud" : "local"
}

function adaptProtocol(p: ProviderProtocol): ProviderConfig["protocol"] {
  if (p === "google") return "gemini"
  if (p === "anthropic") return "anthropic"
  return "openai"
}

function adaptCategory(c: ProviderDefinition["category"]): ProviderConfig["category"] {
  if (c === "core") return "flagship"
  return "specialized"
}

function adaptModel(m: ProviderModelDefinition): ModelConfig {
  return {
    id: m.id,
    name: m.name,
    contextLength: m.contextLength,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    supportsAudio: m.supportsAudio,
    supportsVideo: m.supportsVideo,
    supportsStreaming: m.supportsStreaming,
  }
}
