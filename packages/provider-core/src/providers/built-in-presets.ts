import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import type { BuiltInPresetId, RoutingPreset } from "@cognia/provider-types/routing-presets"

import type { CatalogRepository } from "./catalog-repository"
import { listRoutingCandidates, type CatalogRoutingRole } from "./routing-candidates"

const PRESET_ROLES: CatalogRoutingRole[] = ["fast", "balanced", "powerful", "reasoning", "coding"]

let presetCatalogRepository: CatalogRepository | undefined

export function setPresetCatalogRepository(repository: CatalogRepository): void {
  presetCatalogRepository = repository
}

function mappingTemplate(
  alias: CatalogRoutingRole
): Omit<ModelMapping, "id" | "createdAt" | "updatedAt"> {
  return {
    alias,
    providers: [],
    distribution: "priority",
    enabled: true,
    isDefault: true,
    ...(alias === "coding" ? { parameterDefaults: { temperature: 0.1 } } : {}),
  }
}

function preset(
  id: string,
  builtInId: BuiltInPresetId,
  name: string,
  description: string,
  strategy: RoutingPreset["strategy"],
  icon: string,
  requestTimeoutMs: number,
  maxFallbackAttempts: number
): RoutingPreset {
  return {
    id,
    builtInId,
    name,
    description,
    strategy,
    icon,
    isBuiltIn: true,
    mappings: PRESET_ROLES.map(mappingTemplate),
    routingConfig: {
      strategy,
      allowPerRequestOverride: true,
      providerConstraints: [],
      requestTimeoutMs,
      maxFallbackAttempts,
    },
  }
}

export const BUDGET_PRESET = preset(
  "preset-budget",
  "budget",
  "Budget Mode",
  "Minimize cost while preserving required capabilities.",
  "cost",
  "piggy-bank",
  30_000,
  3
)

export const PERFORMANCE_PRESET = preset(
  "preset-performance",
  "performance",
  "Performance Mode",
  "Prefer the strongest active models that satisfy each capability policy.",
  "quality",
  "zap",
  60_000,
  2
)

export const RELIABILITY_PRESET = preset(
  "preset-reliability",
  "reliability",
  "Reliability Mode",
  "Keep a wider certified fallback chain for each capability policy.",
  "balanced",
  "shield",
  30_000,
  5
)

export const BUILT_IN_PRESETS: RoutingPreset[] = [
  BUDGET_PRESET,
  PERFORMANCE_PRESET,
  RELIABILITY_PRESET,
]

export function getBuiltInPreset(id: BuiltInPresetId): RoutingPreset | undefined {
  return BUILT_IN_PRESETS.find((item) => item.builtInId === id)
}

export function adaptPresetToEnabledProviders(
  presetValue: RoutingPreset,
  enabledProviderIds: Set<string>,
  repository: CatalogRepository | undefined = presetCatalogRepository
): RoutingPreset {
  if (!repository) return { ...presetValue, mappings: [] }
  const limit =
    presetValue.builtInId === "reliability"
      ? Number.POSITIVE_INFINITY
      : presetValue.builtInId === "performance"
        ? 3
        : 4
  return {
    ...presetValue,
    mappings: presetValue.mappings
      .map((template) => ({
        ...template,
        providers: listRoutingCandidates(
          repository,
          template.alias as CatalogRoutingRole,
          enabledProviderIds
        ).slice(0, limit),
      }))
      .filter((item) => item.providers.length > 0),
  }
}
