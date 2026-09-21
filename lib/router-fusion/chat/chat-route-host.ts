/**
 * The app side of a chat route (ADR-0188): every fact `route-chat-turn` needs,
 * read from where the app already keeps it — the routing engine the send
 * built, the pricing layers, the subscription registry, the provider catalog
 * and the live settings store.
 *
 * The same host routes Run API requests (`api/run-api-host.ts`). It carries
 * the opt-in LLM classifier (D18) while the user has it on, so both
 * entry points classify Auto requests the same way, and the routing surface
 * its creator names (chat's send path passes `chat`).
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { resolveModelPricing } from "@cognia/provider-core/providers/model-pricing"
import type { ProviderRoutingEngine, RoutingEngineDeps } from "@cognia/provider-routing"
import { getAllProviders } from "@cognia/provider-types/provider"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { createRouteClassifier, type RouteClassifierHostDeps } from "../routing/llm-classifier"
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
  /** The surface this host routes for; chat's send path passes `chat`. */
  surface?: RouterFusionSurface
  /** Test seam for the classifier's ledger, client and cache. */
  classifierDeps?: RouteClassifierHostDeps
}): ChatRouteHost {
  const { appSettings, engine, engineDeps } = input
  const classify = createRouteClassifier(appSettings, input.classifierDeps)
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
    ...(input.surface ? { surface: input.surface } : {}),
    ...(classify ? { classify } : {}),
  }
}
