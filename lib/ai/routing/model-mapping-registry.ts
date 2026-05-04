/**
 * Model Mapping Registry (in-memory)
 *
 * Wraps a persisted `ModelMapping[]` (typically read from
 * `AppSettings.modelMappings`) into the `ModelMappingRegistry` shape
 * consumed by `ProviderRoutingEngine` and `resolveModelAlias`.
 *
 * The registry is intentionally immutable: every mutating helper
 * returns a fresh `ModelMappingRegistry` value so callers can safely
 * use it inside React/Zustand state without worrying about reference
 * sharing. There is no Dexie persistence here — that lives in the
 * settings store.
 */

import type { ModelMapping, ModelMappingRegistry } from "@/types/provider/model-mapping"

/**
 * Build a fresh registry from a persisted mapping list.
 *
 * The registry starts globally enabled (`enabled: true`); call sites
 * that need a disabled state can spread the result and override.
 */
export function createMappingRegistry(mappings: ModelMapping[]): ModelMappingRegistry {
  return {
    mappings: [...mappings],
    enabled: true,
  }
}

/**
 * Find a mapping by alias (case-insensitive). Returns `undefined` when
 * no mapping matches — callers should treat that as a routing miss and
 * fall through to direct provider:model selection.
 */
export function findMappingByAlias(
  registry: ModelMappingRegistry,
  alias: string
): ModelMapping | undefined {
  const normalized = alias.toLowerCase()
  return registry.mappings.find((m) => m.alias.toLowerCase() === normalized)
}

/**
 * List all alias strings registered (in their original case).
 */
export function listAliases(registry: ModelMappingRegistry): string[] {
  return registry.mappings.map((m) => m.alias)
}

/**
 * Append a mapping. Returns a new registry instance — the input is not
 * mutated.
 */
export function addMapping(
  registry: ModelMappingRegistry,
  mapping: ModelMapping
): ModelMappingRegistry {
  return {
    ...registry,
    mappings: [...registry.mappings, mapping],
  }
}

/**
 * Remove a mapping by id. Returns a new registry instance even when the
 * id is not found (no-op clones are still safe to assign).
 */
export function removeMapping(registry: ModelMappingRegistry, id: string): ModelMappingRegistry {
  return {
    ...registry,
    mappings: registry.mappings.filter((m) => m.id !== id),
  }
}

/**
 * Replace a mapping with the same id. Mappings without a match are
 * left untouched. The replacement entry is taken verbatim — no merge.
 */
export function updateMapping(
  registry: ModelMappingRegistry,
  mapping: ModelMapping
): ModelMappingRegistry {
  return {
    ...registry,
    mappings: registry.mappings.map((m) => (m.id === mapping.id ? mapping : m)),
  }
}
