/**
 * Route one utility call as a Router + Fusion direct run (ADR-0188 D27, B2).
 *
 * A utility call — a conversation title, a timeline label, the `/goal` judge, a
 * workflow prompt node, a room member's turn — has already chosen its provider
 * and model: the feature resolved them from the user's own settings before it
 * asked for a client, and it holds the key it will call them with. So there is
 * nothing to select, and no engine to ask.
 *
 * What the ledger still needs is the deployment's price, an action whose caps
 * and limits bound the run, and a RouteDecision the run's trace can show. The
 * hard filters run all the same, so a restricted-data workspace does not reach
 * an aggregator just because a title needed writing, and a strict budget does
 * not spend against a deployment with no audited price.
 */

import { buildFusionRegistry, deploymentIdOf, type DeploymentRef } from "../chat/fusion-config"
import { buildFusionConfig } from "../chat/fusion-config"
import {
  chatFeatures,
  dataClassFor,
  exclusionsOf,
  factsFor,
  laneOfProvider,
  liveRefusalFor,
  routeRequestFor,
  type RouteFactsHost,
} from "../chat/route-chat-turn"
import {
  ROLE_CLASS_ALIASES,
  routeAction,
  usdToMicrousd,
  type CompiledFusionConfig,
  type DataClass,
  type RouteDecision,
  type RoutingFeatures,
} from "@cognia/router-fusion"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

/** The action a utility call runs under: one cheap call, its own cap and limits. */
export const UTILITY_ACTION_ID = "direct_economy"

/**
 * Trusted features for a utility call. A utility prompt is machine-built from
 * the user's own content, not a request the router should re-read for
 * difficulty: it asks for one short answer, with no tools and nothing to
 * verify. Classifying its text would only let the content being summarized
 * move the call to a more expensive action.
 */
export function utilityFeatures(): RoutingFeatures {
  return { ...chatFeatures("", {}), tool_need: "none", ambiguity: "low", scope: "single_item" }
}

export interface UtilityRouteInput {
  /** The surface asking — its switch is what `liveRefusal` re-checks (AUTH-07). */
  surface: RouterFusionSurface
  providerId: string
  modelId: string
  workspaceId: string | null
  /** How long the prompt is, for the reservation. Measured, never guessed. */
  estimatedInputTokens: number
  /** The caller's own output bound, when it set one. */
  maxOutputTokens?: number | undefined
}

export interface PreparedUtilityCall {
  decision: RouteDecision
  config: CompiledFusionConfig
  actionId: string
  deploymentId: string
  roleDeployments: Record<string, string>
  dataClass: DataClass
  capMicrousd: number
  reserveMicrousd: number
  maxModelCalls: number
  deadlineMs: number
  budgetMode: "tracked" | "strict"
  unknownPriceCallReserveMicrousd: number
  /** The output bound the reservation was priced for. */
  maxOutputTokens: number
  priceKnown: boolean
  liveRefusal: (deploymentId: string) => string | null
}

export type UtilityRoute =
  | { kind: "routed"; prepared: PreparedUtilityCall }
  | {
      kind: "refused"
      code: "ROUTE_NO_SOLUTION"
      reasons: string[]
      decision: RouteDecision | null
    }

/**
 * Compile the one-deployment snapshot this call runs against and decide whether
 * it may be made at all. Writes nothing: the run is created by `runUtilityCall`.
 */
export function routeUtilityCall(host: RouteFactsHost, input: UtilityRouteInput): UtilityRoute {
  const ref: DeploymentRef = { providerId: input.providerId, modelId: input.modelId }
  const deploymentId = deploymentIdOf(ref)
  const dataClass = dataClassFor(host.settings, input.workspaceId)
  const lane = laneOfProvider(ref.providerId)
  // A utility call never runs on the Claude Agent SDK's internal loop: it is one
  // renderer-side AI SDK request, billed per call whatever the provider is.
  const facts = () =>
    factsFor(host, ref, { subscription: host.subscriptionCapable(ref.providerId), lane })
  const registry = buildFusionRegistry({
    deployments: [ref],
    // Every tier alias resolves to the one deployment the feature chose: there
    // is nothing else in this snapshot for an action to prefer.
    aliases: Object.fromEntries(Object.values(ROLE_CLASS_ALIASES).map((alias) => [alias, [ref]])),
    // The feature resolved this model itself, so an undeclared capability is
    // taken as present — exactly as for a model the user picked by name.
    pinned: ref,
    factsOf: facts,
  })
  const { config, omittedActions } = buildFusionConfig(host.settings, registry, host.environment)
  const result = routeAction(
    config,
    routeRequestFor(host, {
      runId: host.newId(),
      decisionId: host.newId(),
      features: utilityFeatures(),
      estimatedInputTokens: input.estimatedInputTokens,
      hasImages: false,
      dataClass,
      refs: [ref],
      requestedActionId: UTILITY_ACTION_ID,
      solverOverride: deploymentId,
    })
  )
  const compiled = config.actions[UTILITY_ACTION_ID]
  if (!result.selected || !compiled || result.selected.estimate === null) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [
        ...omittedActions
          .filter((omitted) => omitted.actionId === UTILITY_ACTION_ID)
          .map((omitted) => `${omitted.actionId}:${omitted.reason}`),
        ...exclusionsOf(result, UTILITY_ACTION_ID),
      ],
      decision: result.decision,
    }
  }
  const deployment = config.deploymentsById[deploymentId]
  const extension = compiled.extension
  const estimate = result.selected.estimate
  const decision: RouteDecision = {
    ...result.decision,
    reason_codes: [
      ...result.decision.reason_codes,
      "selection:utility",
      `surface:${input.surface}`,
    ],
  }
  return {
    kind: "routed",
    prepared: {
      decision,
      config,
      actionId: UTILITY_ACTION_ID,
      deploymentId,
      roleDeployments: { solver: deploymentId },
      dataClass,
      capMicrousd: extension.run_cap_microusd,
      reserveMicrousd: estimate.reserveMicrousd,
      maxModelCalls: extension.limits.max_model_calls,
      deadlineMs: extension.limits.deadline_ms,
      budgetMode: host.settings.budgetMode,
      unknownPriceCallReserveMicrousd: usdToMicrousd(host.settings.unknownPriceCallReserveUsd),
      maxOutputTokens:
        input.maxOutputTokens ?? Math.min(extension.role_output_tokens, deployment.maxOutputTokens),
      priceKnown: estimate.priceKnown,
      liveRefusal: (called) => liveRefusalFor(host, called, dataClass, input.surface),
    },
  }
}
