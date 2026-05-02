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
