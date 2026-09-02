/**
 * The local leg of `cognia-agent provider …`: this process runs the provider
 * operation executor (ADR-0163) over the CLI's own `~/.cognia/config.json`
 * providers. The desktop derives its snapshot from the settings store. The
 * CLI derives the SAME snapshot shape from its config, so every handler,
 * every schema and every failure code is shared rather than re-implemented.
 */

import type { ProviderOperationId, ProviderOperationResult } from "@cognia/provider-types"
import { isBuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"

import {
  createProviderOperationExecutor,
  getProviderOperationDescriptor,
  providerOperationHandlerRegistry,
  registerBuiltInProviderOperationHandlers,
  type ProviderOperationExecutor,
} from "@/lib/ai/operations"
import type {
  CustomProviderDefinition,
  ProviderSettingsEntry,
  ProviderSettingsSnapshot,
} from "@/lib/ai/provider-consumption"

import type { ProviderConfig, ResolvedConfig } from "../config/schema"

/** `google` is the execution-layer name. The settings entry speaks `gemini`. */
function apiProtocolOf(protocol: ProviderConfig["protocol"]): string | undefined {
  if (!protocol) return undefined
  return protocol === "google" ? "gemini" : protocol
}

/**
 * Map the CLI config onto the resolver's snapshot. Built-in ids land in
 * `providers` (the catalog supplies protocol and default base URL). An id the
 * catalog does not know is a self-hosted deployment and becomes a custom
 * provider, where `protocol` is required for the resolver to dispatch it.
 */
export function cliProviderSettingsSnapshot(config: ResolvedConfig): ProviderSettingsSnapshot {
  const providers: Record<string, ProviderSettingsEntry> = {}
  const customProviders: CustomProviderDefinition[] = []
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (!entry) continue
    const apiKey = entry.apiKey ?? entry.authToken
    // An entry with neither a credential nor an address configures nothing.
    if (!apiKey && !entry.baseURL) continue
    if (isBuiltInProviderId(id)) {
      providers[id] = {
        enabled: true,
        ...(apiKey ? { apiKey } : {}),
        ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
        ...(entry.model ? { defaultModel: entry.model } : {}),
        ...(entry.protocol ? { apiProtocol: apiProtocolOf(entry.protocol) } : {}),
      }
      continue
    }
    customProviders.push({
      id,
      name: id,
      enabled: true,
      ...(entry.protocol ? { protocol: entry.protocol } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
      ...(entry.model ? { defaultModel: entry.model } : {}),
    })
  }
  return { defaultProvider: config.provider, providers, customProviders }
}

/**
 * Provider ids the CLI can address, active provider first. A provider is
 * listed when it carries a credential or a base URL (keyless local engines).
 */
export function configuredProviderIds(config: ResolvedConfig): string[] {
  const ids = Object.entries(config.providers ?? {})
    .filter(([, entry]) => Boolean(entry?.apiKey || entry?.authToken || entry?.baseURL))
    .map(([id]) => id)
  const active = config.provider
  if (active && !ids.includes(active)) ids.unshift(active)
  return ids.sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b)))
}

export interface CliProviderExecutor {
  execute<TOutput = unknown>(
    operationId: ProviderOperationId,
    providerId: string,
    input: unknown,
    options?: { signal?: AbortSignal; deploymentRef?: string }
  ): Promise<ProviderOperationResult<TOutput>>
}

/**
 * An executor over the CLI config. The CLI is the local operator, so it holds
 * every scope a descriptor declares. The executor still refuses operations
 * whose surfaces exclude `sidecar` and runs the PII gate centrally.
 */
export function createCliProviderExecutor(
  config: ResolvedConfig,
  deps: { executor?: ProviderOperationExecutor } = {}
): CliProviderExecutor {
  let executor = deps.executor
  if (!executor) {
    registerBuiltInProviderOperationHandlers(providerOperationHandlerRegistry)
    const snapshot = cliProviderSettingsSnapshot(config)
    executor = createProviderOperationExecutor({
      registry: providerOperationHandlerRegistry,
      hostSurfaces: ["sidecar"],
      getSettingsSnapshot: () => snapshot,
    })
  }
  const run = executor
  return {
    execute(operationId, providerId, input, options = {}) {
      const scopes = getProviderOperationDescriptor(operationId)?.scopes ?? []
      return run.execute(
        {
          operationId,
          providerId,
          scopes,
          surface: "sidecar",
          input,
          ...(options.deploymentRef ? { deploymentRef: options.deploymentRef } : {}),
        },
        options.signal ? { signal: options.signal } : {}
      )
    },
  }
}
