/**
 * Plugin `ctx.decisions` API (ADR-0194).
 *
 * Two halves:
 *
 * - **Consumers** (`decide`) ask the provider the user selected in Settings →
 *   Conversation typed questions. Everything goes through `runDecision`, so a
 *   plugin gets the same redaction + PII gate, validation, deadline and typed
 *   errors as the host's own features. Gated by `decisions:run`.
 * - **Providers** (`registerProvider`) add a backend to the host registry as
 *   `<pluginId>:<id>`. Registration makes the provider pickable; nothing is
 *   sent to it until the user selects it. Gated by `decisions:provide`.
 *   Declarative `manifest.decisionProviders[]` goes through the same path
 *   (`lib/plugin/bridge/decision-providers-bridge.ts`).
 *
 * The contract catalog marks the namespace `enforcement: "shadow"`; the
 * `createGuardedAPI` wrapper below is what actually enforces the permissions.
 */

import { getDecisionRegistry } from "@/lib/decisions/host-registry"
import { loadDecisionSettings } from "@/lib/decisions/config"
import { toDecisionProviderInfo, type DecisionRegistry } from "@/lib/decisions/registry"
import { runDecision, type RunDecisionOptions } from "@/lib/decisions/run-decision"
import { createPluginSystemLogger } from "@/lib/plugin/core/logger"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { DecisionProviderInfo, DecisionRequest, DecisionResult } from "@/types/decisions"
import type {
  PluginDecisionProviderInput,
  PluginDecisionRegistration,
} from "@/types/plugin/plugin-decisions"

export interface PluginDecisionsAPI {
  /**
   * Answer typed questions through the user's selected provider (or an
   * explicit installed one). Never throws for provider problems — the result
   * carries a typed error instead. Requires `decisions:run`.
   */
  decide(
    request: DecisionRequest,
    options?: { providerId?: string; signal?: AbortSignal }
  ): Promise<DecisionResult>
  /** Every installed provider, as plain data. */
  listProviders(): DecisionProviderInfo[]
  /** The provider selected in settings, or `null` when none is. */
  getSelectedProviderId(): Promise<string | null>
  /** Add a provider as `<pluginId>:<id>`. Requires `decisions:provide`. */
  registerProvider(provider: PluginDecisionProviderInput): PluginDecisionRegistration
  /** Prefixed ids of the providers this plugin registered. */
  listRegistered(): string[]
}

export interface PluginDecisionsRuntime {
  registry: () => DecisionRegistry
  run: (request: unknown, options: RunDecisionOptions) => Promise<DecisionResult>
  selectedProviderId: () => Promise<string | null>
}

const defaultRuntime: PluginDecisionsRuntime = {
  registry: getDecisionRegistry,
  run: (request, options) => runDecision(request, options),
  selectedProviderId: async () => (await loadDecisionSettings()).providerId ?? null,
}

/**
 * Register a plugin-owned provider under its prefixed id. Shared by
 * `ctx.decisions.registerProvider` and the manifest bridge so both enforce
 * the same shape checks and ownership.
 */
export function registerPluginDecisionProvider(
  pluginId: string,
  provider: PluginDecisionProviderInput,
  registry: DecisionRegistry = getDecisionRegistry()
): PluginDecisionRegistration {
  if (!provider || typeof provider.id !== "string" || !provider.id) {
    throw new Error(`[decisions-api] plugin ${pluginId} registered a provider without an id`)
  }
  if (typeof provider.decide !== "function") {
    throw new Error(`[decisions-api] provider "${provider.id}" has no decide() method`)
  }
  if (typeof provider.label !== "string" || !provider.label) {
    throw new Error(`[decisions-api] provider "${provider.id}" has no label`)
  }
  if (provider.locality !== "local" && provider.locality !== "remote") {
    throw new Error(`[decisions-api] provider "${provider.id}" must declare locality local|remote`)
  }
  const providerId = `${pluginId}:${provider.id}`
  registry.register({
    ...provider,
    id: providerId,
    pluginId,
    calibrated: provider.calibrated === true,
  })
  let active = true
  return {
    providerId,
    unregister: () => {
      if (!active) return
      active = false
      registry.unregister(providerId)
    },
  }
}

export function createDecisionsAPI(
  pluginId: string,
  runtime: PluginDecisionsRuntime = defaultRuntime
): PluginDecisionsAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginDecisionsAPI = {
    decide: (request, options = {}) =>
      runtime.run(request, {
        ...(options.providerId ? { providerId: options.providerId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        callerPluginId: pluginId,
      }),
    listProviders: () => runtime.registry().list().map(toDecisionProviderInfo),
    getSelectedProviderId: () => runtime.selectedProviderId(),
    registerProvider(provider) {
      const registration = registerPluginDecisionProvider(pluginId, provider, runtime.registry())
      logger.info(`[decisions] registered provider "${registration.providerId}"`)
      return registration
    },
    listRegistered: () =>
      runtime
        .registry()
        .list()
        .filter((provider) => provider.pluginId === pluginId)
        .map((provider) => provider.id),
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      decide: ["decisions:run"],
      registerProvider: ["decisions:provide"],
    },
    { unguarded: ["listProviders", "getSelectedProviderId", "listRegistered"] }
  )
}

/** Plugin-disable hook — drop every provider the plugin registered. */
export function clearDecisionProvidersForPlugin(
  pluginId: string,
  registry: DecisionRegistry = getDecisionRegistry()
): void {
  registry.clearForPlugin(pluginId)
}
