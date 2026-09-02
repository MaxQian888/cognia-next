/**
 * Plugin cells for the capability matrix (ADR-0163).
 *
 * Four plugin contribution points serve provider operations. Three predate
 * the contract and already execute through their own registries, so this
 * projection adds no code path: it only makes them VISIBLE as `plugin` cells.
 *
 *   - `subscription.balance-adapter`: `balance.read` already asks
 *     `findBalanceAdapter`, which lists the plugin overlay first.
 *   - `subscription.limits-source`: `quota.read` and `rate-limits.read` already
 *     run `resolveLimitsSources`, which lists the plugin overlay first.
 *   - `provider.protocol-adapter`: a provider whose protocol is a plugin
 *     adapter id already dispatches `language.generate` and `language.stream`
 *     through that adapter.
 *   - `provider.operation-adapter`: the contract-native point. Its handlers
 *     are bound into the operation registry on enable, so they are projected
 *     from the same registry the executor resolves against.
 *
 * The matrix lets plugin cells win over static answers, so a provider that
 * gains a plugin balance adapter flips `balance.read` from `unsupported` to
 * `plugin` without any change to the vendor facts.
 */

import type {
  ProviderOperationId,
  ProviderOperationPluginCell,
  ResolverProtocol,
} from "@cognia/provider-types"
import { listProtocolAdapters } from "@cognia/provider-core/providers/protocol-adapter-registry"

import { listBalanceAdapterEntries } from "@/lib/plugin/registries/balance-adapter-registry"
import { listLimitsSourceEntries } from "@/lib/plugin/registries/limits-source-registry"
import { listProviderOperationAdapterEntries } from "@/lib/plugin/registries/provider-operation-adapter-registry"

import { registryProviderKey } from "./account"

export interface PluginProjectionInput {
  providerId: string
  protocol: ResolverProtocol
  baseURL?: string
}

export interface PluginProjectionDeps {
  balanceAdapters?: typeof listBalanceAdapterEntries
  limitsSources?: typeof listLimitsSourceEntries
  protocolAdapters?: typeof listProtocolAdapters
  operationAdapters?: typeof listProviderOperationAdapterEntries
}

function via(id: string, pluginId?: string): string {
  if (!pluginId || id.startsWith(`${pluginId}:`)) return id
  return `${pluginId}:${id}`
}

function cell(
  operationId: ProviderOperationId,
  by: string,
  note: string
): ProviderOperationPluginCell {
  return { operationId, support: "plugin", availability: "ready", via: by, note }
}

/**
 * Every operation a plugin serves for this provider, one cell per operation.
 * The first contributor to name an operation keeps it: an explicit operation
 * adapter first, then the three legacy points in their execution order.
 */
export function projectPluginCells(
  input: PluginProjectionInput,
  deps: PluginProjectionDeps = {}
): ProviderOperationPluginCell[] {
  const cells = new Map<ProviderOperationId, ProviderOperationPluginCell>()
  const claim = (candidate: ProviderOperationPluginCell) => {
    if (!cells.has(candidate.operationId)) cells.set(candidate.operationId, candidate)
  }

  for (const { id, entry, pluginId } of (
    deps.operationAdapters ?? listProviderOperationAdapterEntries
  )()) {
    const match = entry.providerMatch
    const matches =
      match.kind === "any" ||
      (match.kind === "provider" && match.providerId === input.providerId) ||
      (match.kind === "protocol" && match.protocol === input.protocol)
    if (!matches) continue
    claim(cell(entry.operationId, via(id, pluginId), `served by ${entry.name ?? id}`))
  }

  const providerKey = registryProviderKey(input.providerId)
  const query = { providerKey, baseUrl: input.baseURL }

  for (const { id, entry, pluginId } of (deps.balanceAdapters ?? listBalanceAdapterEntries)()) {
    if (!entry.matches(query)) continue
    claim(cell("balance.read", via(id, pluginId), `balance adapter ${entry.name ?? entry.key}`))
  }

  for (const { id, entry, pluginId } of (deps.limitsSources ?? listLimitsSourceEntries)()) {
    if (!entry.matches({ provider: input.providerId, ...query })) continue
    const by = via(id, pluginId)
    claim(cell("quota.read", by, `limits source ${entry.name ?? entry.key}`))
    claim(cell("rate-limits.read", by, `limits source ${entry.name ?? entry.key}`))
  }

  for (const adapter of (deps.protocolAdapters ?? listProtocolAdapters)()) {
    if (adapter.id !== input.protocol) continue
    const by = via(adapter.id, adapter.pluginId)
    claim(cell("language.generate", by, `protocol adapter ${adapter.label}`))
    claim(cell("language.stream", by, `protocol adapter ${adapter.label}`))
  }

  return [...cells.values()]
}
