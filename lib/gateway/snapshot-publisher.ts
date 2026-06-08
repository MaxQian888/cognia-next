/**
 * Build the routing + credential snapshot the Rust gateway executes against.
 *
 * The gateway runs upstream calls in Rust from a renderer-pushed snapshot, so
 * this collects exactly what it needs: every enabled provider's protocol /
 * base URL / API key / model list, plus each enabled alias's pre-ordered
 * deployment chain (the model-mapping order the routing engine would walk).
 *
 * Pure + synchronous: pass the settings slice in, get a snapshot out. The
 * `gateway-provider` component supplies live settings and stamps
 * `generatedAtMs` (this module can't call Date.now under the workflow/test
 * constraints, and keeping it injected keeps the builder deterministic).
 */

import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsSnapshotInput,
} from "@/lib/ai/provider-consumption"
import type {
  GatewayAliasSnapshot,
  GatewayProviderSnapshot,
  GatewayRoutingSnapshot,
} from "@/types/gateway"
import type { ModelMapping } from "@/types/provider/model-mapping"

export interface SnapshotSettingsSlice {
  defaultProvider?: string
  providerSettings?: ProviderSettingsSnapshotInput["providerSettings"]
  customProviders?: ProviderSettingsSnapshotInput["customProviders"]
  modelMappings?: ModelMapping[]
}

/**
 * Pull model ids off a custom-provider entry. The lean resolver type
 * (`RichCustomProviderEntry`) doesn't expose them, but the rich
 * `CustomProviderSettings` rows the settings store holds carry
 * `customModels` / `models` — read them defensively.
 */
function extractCustomModels(custom: unknown): string[] {
  const c = custom as { customModels?: unknown[]; models?: unknown[] }
  const raw = c.customModels ?? c.models ?? []
  return raw
    .map((m) => (typeof m === "string" ? m : ((m as { id?: string }).id ?? "")))
    .filter(Boolean)
}

/** Provider ids referenced by any enabled alias, plus every configured one. */
function providerIdsToPublish(slice: SnapshotSettingsSlice): string[] {
  const ids = new Set<string>()
  for (const id of Object.keys(slice.providerSettings ?? {})) ids.add(id)
  for (const custom of slice.customProviders ?? []) ids.add(custom.id)
  for (const mapping of slice.modelMappings ?? []) {
    if (!mapping.enabled) continue
    for (const entry of mapping.providers) ids.add(entry.providerId)
  }
  return [...ids]
}

/**
 * Resolve each provider to its executable shape. Providers that don't resolve
 * (missing key AND base URL) are emitted with `enabled: false` so the gateway
 * skips them but the settings UI can still show they exist.
 */
function buildProviders(slice: SnapshotSettingsSlice): GatewayProviderSnapshot[] {
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: slice.defaultProvider,
    providerSettings: slice.providerSettings,
    customProviders: slice.customProviders,
  })
  const out: GatewayProviderSnapshot[] = []
  for (const id of providerIdsToPublish(slice)) {
    const resolution = resolveFeatureProvider(
      {
        featureId: "gateway",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: id,
        fallbackMode: "none",
      },
      snapshot
    )
    if (resolution.kind !== "resolved") {
      out.push({ id, protocol: "openai", baseUrl: "", enabled: false, models: [] })
      continue
    }
    const custom = slice.customProviders?.find((p) => p.id === id)
    const models = custom ? extractCustomModels(custom) : resolution.model ? [resolution.model] : []
    out.push({
      id,
      // The gateway speaks "openai"/"anthropic"; "google"/"mistral"/"cohere"
      // are listed but not yet executable (skipped by the fallback walk).
      protocol: resolution.protocol,
      baseUrl: resolution.baseURL ?? "",
      ...(resolution.apiKey ? { apiKey: resolution.apiKey } : {}),
      enabled: true,
      models,
    })
  }
  return out
}

function buildAliases(slice: SnapshotSettingsSlice): GatewayAliasSnapshot[] {
  return (slice.modelMappings ?? [])
    .filter((m) => m.enabled && m.providers.length > 0)
    .map((m) => ({
      alias: m.alias,
      // Mapping entries are already in priority order; weighted mappings still
      // expose the same set (the gateway walks them top-down as a chain).
      entries: m.providers.map((e) => ({ providerId: e.providerId, modelId: e.modelId })),
    }))
}

/** Assemble the full snapshot. `generatedAtMs` is injected by the caller. */
export function buildGatewaySnapshot(
  slice: SnapshotSettingsSlice,
  generatedAtMs: number
): GatewayRoutingSnapshot {
  return {
    providers: buildProviders(slice),
    aliases: buildAliases(slice),
    generatedAtMs,
  }
}
