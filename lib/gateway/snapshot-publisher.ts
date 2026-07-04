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
  GatewayRotationStrategy,
  GatewayRoutingSnapshot,
} from "@/types/gateway"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"

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

/**
 * Clean a provider's multi-key pool (`UserProviderSettings.apiKeys[]`): trim,
 * drop blanks, dedupe — matching the app-side rotation resolver's `cleanPool`
 * so the gateway rotates over exactly the same accounts.
 */
function cleanKeyPool(keys: unknown): string[] {
  if (!Array.isArray(keys)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of keys) {
    const trimmed = typeof k === "string" ? k.trim() : ""
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/**
 * The upstream multi-account rotation config for a provider id, read from the
 * raw settings row (built-in or custom). Returns `null` when no usable pool /
 * rotation is configured so the single-key path is used.
 */
function extractRotationPool(
  slice: SnapshotSettingsSlice,
  id: string
): {
  apiKeys: string[]
  rotationEnabled: boolean
  rotationStrategy?: GatewayRotationStrategy
} | null {
  const raw = (slice.providerSettings?.[id] ?? slice.customProviders?.find((p) => p.id === id)) as
    | { apiKeys?: unknown; apiKeyRotationEnabled?: unknown; apiKeyRotationStrategy?: unknown }
    | undefined
  if (!raw?.apiKeyRotationEnabled) return null
  const pool = cleanKeyPool(raw.apiKeys)
  if (pool.length === 0) return null
  const strategy =
    typeof raw.apiKeyRotationStrategy === "string"
      ? (raw.apiKeyRotationStrategy as GatewayRotationStrategy)
      : undefined
  return { apiKeys: pool, rotationEnabled: true, rotationStrategy: strategy }
}

/**
 * Default a provider row's single `apiKey` to the first pooled key when the
 * primary is blank — mirrors the app resolver's `single ?? pool[0]` so a
 * provider configured with only a rotation pool still resolves protocol / base
 * URL (and thus becomes executable through the gateway).
 */
function withPoolFallbackKey<T extends { apiKey?: string; apiKeys?: unknown }>(row: T): T {
  if (row.apiKey && row.apiKey.trim()) return row
  const pool = cleanKeyPool(row.apiKeys)
  return pool.length > 0 ? { ...row, apiKey: pool[0] } : row
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
  // Normalize so a provider configured with only a rotation pool (blank primary
  // key) still resolves protocol / base URL — its pool[0] stands in as the
  // single key the resolver reads.
  const normalizedProviderSettings = slice.providerSettings
    ? (Object.fromEntries(
        Object.entries(slice.providerSettings).map(([id, row]) => [
          id,
          withPoolFallbackKey(row as { apiKey?: string; apiKeys?: unknown }),
        ])
      ) as ProviderSettingsSnapshotInput["providerSettings"])
    : slice.providerSettings
  const normalizedCustomProviders = slice.customProviders?.map((p) =>
    withPoolFallbackKey(p as { apiKey?: string; apiKeys?: unknown } & typeof p)
  ) as ProviderSettingsSnapshotInput["customProviders"]

  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: slice.defaultProvider,
    providerSettings: normalizedProviderSettings,
    customProviders: normalizedCustomProviders,
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
    // Attach the upstream multi-account pool so the gateway rotates / fails over
    // across the same accounts the chat pipeline does.
    const pool = extractRotationPool(slice, id)
    out.push({
      id,
      // The gateway speaks "openai"/"anthropic"; "google"/"mistral"/"cohere"
      // are listed but not yet executable (skipped by the fallback walk).
      protocol: resolution.protocol,
      baseUrl: resolution.baseURL ?? "",
      ...(resolution.apiKey ? { apiKey: resolution.apiKey } : {}),
      ...(pool
        ? {
            apiKeys: pool.apiKeys,
            rotationEnabled: true,
            ...(pool.rotationStrategy ? { rotationStrategy: pool.rotationStrategy } : {}),
          }
        : {}),
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

/** Resolves a subscription-vault credential for a provider id, or null. */
export type VaultCredentialResolver = (
  providerId: string
) => Promise<{ apiKey: string; baseURL: string } | null>

/**
 * Fill in subscription-vault credentials the plain provider-settings path
 * can't supply — e.g. opencode Zen/Go, whose key lives in the encrypted
 * subscription vault rather than `providerSettings[id].apiKey`. Probes
 * `subscriptionProviderIds` (plus any already-present-but-keyless provider)
 * via the injected resolver; resolved providers become executable, and a
 * probed-but-absent provider is appended so a `provider:model` literal
 * resolves even without a settings row.
 *
 * Pure-with-injected-IO: the resolver is the only async dependency, keeping
 * `buildGatewaySnapshot` synchronous and unit-testable.
 */
export async function enrichSnapshotWithSubscriptionCreds(
  snapshot: GatewayRoutingSnapshot,
  subscriptionProviderIds: readonly string[],
  resolveVaultCred: VaultCredentialResolver
): Promise<GatewayRoutingSnapshot> {
  const providers = [...snapshot.providers]
  const indexById = new Map(providers.map((p, i) => [p.id, i]))

  // Which ids to probe: the configured subscription ids plus any provider we
  // emitted as keyless (unresolved) — a vault cred may rescue it.
  const toProbe = new Set<string>(subscriptionProviderIds)
  for (const p of providers) if (!p.apiKey) toProbe.add(p.id)

  for (const id of toProbe) {
    const cred = await resolveVaultCred(id).catch(() => null)
    if (!cred) continue
    const existing = indexById.get(id)
    if (existing !== undefined) {
      const prev = providers[existing]
      // Only fill a missing key — never clobber an explicitly configured one.
      if (prev.apiKey) continue
      providers[existing] = {
        ...prev,
        apiKey: cred.apiKey,
        baseUrl: cred.baseURL || prev.baseUrl,
        enabled: true,
      }
    } else {
      // opencode chat providers speak the OpenAI protocol.
      providers.push({
        id,
        protocol: "openai",
        baseUrl: cred.baseURL,
        apiKey: cred.apiKey,
        enabled: true,
        models: [],
      })
      indexById.set(id, providers.length - 1)
    }
  }

  return { ...snapshot, providers }
}
