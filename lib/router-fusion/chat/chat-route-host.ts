/**
 * The app side of a chat route (ADR-0188): every fact `route-chat-turn` needs,
 * read from where the app already keeps it — the routing engine the send
 * built, the pricing layers, the subscription registry, the provider catalog
 * and the live settings store.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { resolveModelPricing } from "@cognia/provider-core/providers/model-pricing"
import type { ProviderRoutingEngine, RoutingEngineDeps } from "@cognia/provider-routing"
import { getAllProviders } from "@cognia/provider-types/provider"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { useSettingsStore } from "@/stores/settings/settings-store"

import type { ChatRouteHost } from "./route-chat-turn"

/** Credential modes whose accounts can be a plan's quota rather than a metered key. */
const SUBSCRIPTION_AUTH_MODES: ReadonlySet<string> = new Set(["anthropic-oauth", "codex-oauth"])

export function runtimeEnvironment(): ChatRouteHost["environment"] {
  if (process.env.NODE_ENV === "test") return "test"
  return process.env.NODE_ENV === "production" ? "production" : "development"
}

export function createChatRouteHost(input: {
  appSettings: AppSettings
  engine: Pick<ProviderRoutingEngine, "planRoute">
  engineDeps: RoutingEngineDeps
}): ChatRouteHost {
  const { appSettings, engine, engineDeps } = input
  return {
    settings: normalizeRouterFusionSettings(appSettings.routerFusion),
    engineDeps,
    planRoute: (request) => engine.planRoute(request),
    pricingOf: (providerId, modelId) =>
      resolveModelPricing(providerId, modelId, {
        providerSettings: appSettings.providerSettings,
        customProviders: appSettings.customProviders,
      }),
    subscriptionCapable: (providerId) => {
      const definition = getSubscriptionProvider(providerId, appSettings.customProviders ?? [])
      return definition !== undefined && SUBSCRIPTION_AUTH_MODES.has(definition.authMode)
    },
    // A user-defined endpoint's destination cannot be proven any more than an
    // aggregator's: neither may receive restricted data without a grant.
    isAggregator: (providerId) =>
      getAllProviders()[providerId]?.category === "aggregator" ||
      (appSettings.customProviders ?? []).some((provider) => provider.id === providerId),
    currentSettings: () => useSettingsStore.getState().settings ?? undefined,
    environment: runtimeEnvironment(),
    now: () => Date.now(),
    newId: () => globalThis.crypto.randomUUID(),
  }
}
