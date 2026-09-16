/**
 * What a ledgered utility call does before the request leaves (ADR-0188 D27, B2).
 *
 * The client wrapper itself lives in `gate/utility-ledger.ts`, where the off
 * path can reach it without loading anything. This is the half behind the gate:
 * read the user's own settings, compile the one-deployment snapshot the call
 * runs against, take the tenant's remaining allowance, and open the run.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { resolveModelPricing } from "@cognia/provider-core/providers/model-pricing"
import { buildRoutingEngineDeps } from "@cognia/provider-routing/build-preview-engine"
import { getAllProviders } from "@cognia/provider-types/provider"
import { estimateTokens } from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"

import { runtimeEnvironment } from "../chat/chat-route-host"
import { windowLeaseOwner } from "../chat/chat-run-deps"
import type { RouteFactsHost } from "../chat/route-chat-turn"
import { currentFusionStore } from "../chat/store-provider"
import { tenantLimitFor } from "../chat/tenant-budget"
import { currentRouterFusionGateSettings } from "../gate/current-settings"
import type { BeginLedgeredUtilityCallInput, UtilityGrant } from "../gate/utility-ledger"
import { liveSettingsReader } from "./live-settings"
import { routeUtilityCall } from "./utility-route"
import { beginUtilityCall } from "./utility-run"

/** Credential modes whose accounts can be a plan's quota rather than a metered key. */
const SUBSCRIPTION_AUTH_MODES: ReadonlySet<string> = new Set(["anthropic-oauth", "codex-oauth"])

/** Separates the parts of a request digest so no two different requests can spell the same string. */
const DIGEST_SEPARATOR = "\u0000"

/**
 * The route facts a utility call needs. There is no engine here: the feature
 * already resolved its deployment, so nothing has to be planned.
 */
export function utilityRouteHost(appSettings: AppSettings): RouteFactsHost {
  return {
    settings: normalizeRouterFusionSettings(appSettings.routerFusion),
    engineDeps: buildRoutingEngineDeps(appSettings),
    pricingOf: (providerId, modelId) =>
      resolveModelPricing(providerId, modelId, {
        providerSettings: appSettings.providerSettings,
        customProviders: appSettings.customProviders,
      }),
    subscriptionCapable: (providerId) => {
      const definition = getSubscriptionProvider(providerId, appSettings.customProviders ?? [])
      return definition !== undefined && SUBSCRIPTION_AUTH_MODES.has(definition.authMode)
    },
    isAggregator: (providerId) =>
      getAllProviders()[providerId]?.category === "aggregator" ||
      (appSettings.customProviders ?? []).some((provider) => provider.id === providerId),
    currentSettings: liveSettingsReader(appSettings),
    environment: runtimeEnvironment(),
    now: () => Date.now(),
    newId: () => globalThis.crypto.randomUUID(),
  }
}

/**
 * Route and reserve one utility call. Every failure that is not a refusal is an
 * infrastructure fault and propagates, so the gate's ordinary-traffic guard can
 * send the call on the original, unledgered path with the notice (D38).
 */
export async function beginLedgeredUtilityCall(
  input: BeginLedgeredUtilityCallInput & { appSettings?: AppSettings }
): Promise<UtilityGrant> {
  const appSettings = input.appSettings ?? (await currentRouterFusionGateSettings())
  if (!appSettings) return { kind: "refused", code: "ROUTER_FUSION_DISABLED" }
  const host = utilityRouteHost(appSettings)
  const route = routeUtilityCall(host, {
    surface: input.surface,
    providerId: input.providerId,
    modelId: input.modelId,
    workspaceId: input.workspaceId,
    estimatedInputTokens: estimateTokens(`${input.system ?? ""}\n${input.prompt}`),
    maxOutputTokens: input.maxOutputTokens,
  })
  if (route.kind === "refused") {
    return { kind: "refused", code: route.code, reasons: route.reasons }
  }
  const tenant = await tenantLimitFor(appSettings.costBudget, input.providerId)
  const started = await beginUtilityCall(
    {
      store: () => currentFusionStore(),
      leaseOwner: windowLeaseOwner(),
      tenantLimitRemainingMicrousd: tenant.remainingMicrousd,
    },
    route.prepared,
    {
      surface: input.surface,
      origin: input.origin,
      featureId: input.featureId,
      requestDigestInput: [
        input.featureId,
        `${input.providerId}::${input.modelId}`,
        input.system ?? "",
        input.prompt,
      ].join(DIGEST_SEPARATOR),
    }
  )
  return started.kind === "granted" ? started : { kind: "refused", code: started.code }
}
