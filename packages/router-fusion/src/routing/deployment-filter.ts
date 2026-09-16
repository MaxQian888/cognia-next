/**
 * Deployment-level hard filter (DESIGN §6.1) and alias resolution.
 *
 * Every constraint here is evaluated BEFORE cost: a cheaper deployment that
 * cannot see the image, cannot take restricted data or has no audited price
 * under a strict budget is excluded, never traded off (ROUTE-02). The host can
 * inject its own selector (the app's ProviderRoutingEngine, which knows live
 * health, breakers and session affinity) — whatever it picks is re-checked
 * here, so no selector can smuggle an ineligible deployment past the filter.
 */

import type { DataClass } from "../contracts/schemas"
import type {
  CompiledFusionConfig,
  DeploymentHealth,
  FusionDeployment,
  InputModality,
} from "../config/types"

export type DeploymentExclusion =
  | "DEPLOYMENT_DISABLED"
  | "DEPLOYMENT_UNAVAILABLE"
  | "DATA_CLASS_NOT_ALLOWED"
  | "RESTRICTED_NOT_GRANTED"
  | "MODALITY_UNSUPPORTED"
  | "TOOLS_UNSUPPORTED"
  | "JSON_SCHEMA_UNSUPPORTED"
  | "CONTEXT_TOO_SMALL"
  | "PROVIDER_EXCLUDED"
  | "PROVIDER_NOT_ALLOWED"
  | "PRICE_NOT_AUDITED"
  | "BILLING_NOT_BOUNDED"
  | "HIDDEN_RETRIES"
  | "CREDENTIAL_REVOKED"

export interface RoleRequirements {
  /** The role reads the user's input modalities. */
  inputModalities: InputModality[]
  needsTools: boolean
  needsJsonSchema: boolean
  /** Tokens the role's prompt will carry, conservatively. */
  inputTokens: number
  /** Output tokens reserved for the role. */
  outputTokens: number
}

export interface DataPolicyView {
  dataClass: DataClass
  allowedProviderIds?: string[]
  excludedProviderIds?: string[]
  /** Providers the user explicitly granted restricted data (D30). */
  restrictedGrantProviderIds: string[]
  /** Deployment ids whose credential or data permission was revoked right now (AUTH-07). */
  revokedDeploymentIds: string[]
}

export interface DeploymentFilterContext {
  config: CompiledFusionConfig
  budgetMode: "strict" | "tracked"
  health: Record<string, DeploymentHealth>
  policy: DataPolicyView
}

export function deploymentExclusions(
  deployment: FusionDeployment,
  requirements: RoleRequirements,
  context: DeploymentFilterContext
): DeploymentExclusion[] {
  const reasons: DeploymentExclusion[] = []
  const { policy } = context
  if (!deployment.enabled) reasons.push("DEPLOYMENT_DISABLED")
  if (policy.revokedDeploymentIds.includes(deployment.id)) reasons.push("CREDENTIAL_REVOKED")
  if ((context.health[deployment.id] ?? "healthy") === "unavailable")
    reasons.push("DEPLOYMENT_UNAVAILABLE")

  if (!deployment.dataClasses.includes(policy.dataClass)) reasons.push("DATA_CLASS_NOT_ALLOWED")
  if (policy.dataClass === "restricted" && deployment.providerId !== "fake") {
    const local =
      deployment.dataClasses.includes("restricted") && deployment.cacheMode !== "automatic"
    if (!local && !policy.restrictedGrantProviderIds.includes(deployment.providerId)) {
      reasons.push("RESTRICTED_NOT_GRANTED")
    }
  }
  if (policy.excludedProviderIds?.includes(deployment.providerId)) reasons.push("PROVIDER_EXCLUDED")
  if (
    policy.allowedProviderIds &&
    policy.allowedProviderIds.length > 0 &&
    !policy.allowedProviderIds.includes(deployment.providerId)
  ) {
    reasons.push("PROVIDER_NOT_ALLOWED")
  }

  for (const modality of requirements.inputModalities) {
    if (!deployment.inputModalities.includes(modality)) {
      reasons.push("MODALITY_UNSUPPORTED")
      break
    }
  }
  if (requirements.needsTools && !deployment.supportsTools) reasons.push("TOOLS_UNSUPPORTED")
  if (requirements.needsJsonSchema && !deployment.supportsJsonSchema)
    reasons.push("JSON_SCHEMA_UNSUPPORTED")
  const outputTokens = Math.min(requirements.outputTokens, deployment.maxOutputTokens)
  if (requirements.inputTokens + outputTokens > deployment.contextLimit)
    reasons.push("CONTEXT_TOO_SMALL")

  const card = deployment.rateCardId
    ? context.config.rateCardsById[deployment.rateCardId]
    : undefined
  if (context.budgetMode === "strict") {
    const audited =
      card !== undefined && !(card.example_only && context.config.environment === "production")
    if (!audited) reasons.push("PRICE_NOT_AUDITED")
    if (deployment.billingTransparency !== "bounded") reasons.push("BILLING_NOT_BOUNDED")
    if (deployment.internalRetry === "hidden") reasons.push("HIDDEN_RETRIES")
  }
  return reasons
}

export interface DeploymentSelection {
  deployment: FusionDeployment | null
  rejected: Array<{ deploymentId: string; reasons: DeploymentExclusion[] }>
  /** The session's previous deployment was kept because a switch would not save enough. */
  affinityKept: boolean
}

export interface DeploymentSelectorInput {
  alias: string
  role: string
  requirements: RoleRequirements
  context: DeploymentFilterContext
  /** Deployment the session used last for this alias, if any. */
  affinityDeploymentId?: string
  /** Minimum relative saving before leaving a still-eligible affinity deployment. */
  switchMargin: number
  /** Expected per-call cost (microusd) for a deployment; null when unpriced. */
  expectedCost: (deployment: FusionDeployment) => number | null
}

export type DeploymentSelector = (input: DeploymentSelectorInput) => DeploymentSelection

/**
 * Default selector: alias order is the host's preference order. The affinity
 * deployment is kept while it stays eligible unless another eligible
 * deployment is cheaper by more than `switchMargin` (ROUTE-07). An affinity
 * deployment that lost eligibility (revoked, unavailable) is always left.
 */
export const selectDeploymentInAliasOrder: DeploymentSelector = (input) => {
  const ids = input.context.config.registry.aliases[input.alias] ?? []
  const rejected: DeploymentSelection["rejected"] = []
  const eligible: FusionDeployment[] = []
  for (const id of ids) {
    const deployment = input.context.config.deploymentsById[id]
    if (!deployment) continue
    const reasons = deploymentExclusions(deployment, input.requirements, input.context)
    if (reasons.length > 0) rejected.push({ deploymentId: id, reasons })
    else eligible.push(deployment)
  }
  if (eligible.length === 0) return { deployment: null, rejected, affinityKept: false }

  const preferred = eligible[0]
  const current = input.affinityDeploymentId
    ? eligible.find((d) => d.id === input.affinityDeploymentId)
    : undefined
  if (!current) return { deployment: preferred, rejected, affinityKept: false }

  const currentCost = input.expectedCost(current)
  let cheapest: FusionDeployment = current
  let cheapestCost = currentCost
  for (const candidate of eligible) {
    const cost = input.expectedCost(candidate)
    if (cost !== null && (cheapestCost === null || cost < cheapestCost)) {
      cheapest = candidate
      cheapestCost = cost
    }
  }
  if (cheapest !== current && currentCost !== null && cheapestCost !== null && currentCost > 0) {
    const saving = (currentCost - cheapestCost) / currentCost
    if (saving > input.switchMargin) return { deployment: cheapest, rejected, affinityKept: false }
  }
  return { deployment: current, rejected, affinityKept: true }
}
