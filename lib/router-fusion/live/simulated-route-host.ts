/**
 * The route host a simulated smoke routes against (ADR-0188 D4, EVAL-04).
 *
 * `routeRunRequest` needs a `ChatRouteHost`: something that resolves each
 * role alias to deployments and describes them — capabilities, prices,
 * health. A live smoke gets that from the user's settings through the app's
 * routing engine. A simulated one gets it from here: one Fake Provider
 * deployment per routing tier, priced by the spec's mock rate cards
 * (`simulatedTiers`), always healthy. Everything above it — the registry
 * build, the config compile, the ActionRouter, its exclusions — is the same
 * code a live run goes through, so a simulated run proves the harness's
 * wiring end to end without a provider.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import {
  SIMULATED_PROVIDER_ID,
  simulatedTiers,
  type SimulatedTier,
} from "@cognia/router-fusion/live/simulated"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { DEFAULTS } from "@/lib/db/settings"

import type { ChatRouteHost } from "../chat/route-chat-turn"
import { withHarnessSwitches } from "./live-smoke-settings"

/** The app's defaults with Router + Fusion on for the smoke's surface; no provider configured. */
export function simulatedAppSettings(): AppSettings {
  return withHarnessSwitches(structuredClone(DEFAULTS))
}

function planFor(tier: SimulatedTier, request: RoutingRequest, now: number): RoutingPlan {
  const candidate = {
    providerId: SIMULATED_PROVIDER_ID,
    modelId: tier.modelId,
    deploymentId: `${SIMULATED_PROVIDER_ID}::${tier.modelId}`,
    reasonCodes: [],
  }
  return {
    decisionId: `simulated:${tier.alias}`,
    surface: request.surface,
    requested: request.selection,
    strategy: "simulated",
    selected: candidate,
    orderedCandidates: [candidate],
    reasonCodes: [],
    rejected: [],
    replayPolicy: "pre-commit-only",
    createdAt: now,
  }
}

export function createSimulatedRouteHost(
  appSettings: AppSettings,
  deps: { now: () => number; newId: () => string }
): ChatRouteHost {
  const tiers = simulatedTiers()
  const byAlias = new Map(tiers.map((tier) => [tier.alias, tier]))
  const byModel = new Map(tiers.map((tier) => [tier.modelId, tier]))
  const known = (providerId: string, modelId: string) =>
    providerId === SIMULATED_PROVIDER_ID ? byModel.get(modelId) : undefined
  return {
    settings: normalizeRouterFusionSettings(appSettings.routerFusion),
    engineDeps: {
      getCapabilities: (providerId, modelId) => {
        const tier = known(providerId, modelId)
        return tier
          ? {
              tools: true,
              vision: false,
              structuredOutput: true,
              contextTokens: tier.contextTokens,
            }
          : undefined
      },
      // Only simulated deployments are ever planned; anything else has no window.
      getContextWindow: (providerId, modelId) => known(providerId, modelId)?.contextTokens ?? 0,
      isLocalProvider: () => false,
      getCircuitBreakerState: () => "closed",
      getDeploymentCircuitBreakerState: () => "closed",
      isProviderAvailable: (providerId) => providerId === SIMULATED_PROVIDER_ID,
    },
    planRoute: async (request) => {
      const alias = request.selection.kind === "alias" ? request.selection.alias : null
      const tier = alias ? byAlias.get(alias) : undefined
      if (!alias || !tier) throw new RoutingNoCandidatesError(alias ?? request.selection.kind)
      return planFor(tier, request, deps.now())
    },
    pricingOf: (providerId, modelId) => {
      const tier = known(providerId, modelId)
      return tier ? { promptPer1M: tier.promptPer1M, completionPer1M: tier.completionPer1M } : null
    },
    subscriptionCapable: () => false,
    isAggregator: () => false,
    currentSettings: () => appSettings,
    // Not "production": the compiler refuses example-only material there, and
    // a simulated smoke is never a production run.
    environment: "development",
    now: deps.now,
    newId: deps.newId,
  }
}
