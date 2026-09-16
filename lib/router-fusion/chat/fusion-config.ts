/**
 * Router + Fusion configuration built from the user's own settings (ADR-0188).
 *
 * The package's contracts know nothing about Cognia providers. This module turns
 * the app's model catalog, pricing layers and routing tiers into a
 * `FusionRegistry`, and the Router + Fusion settings (run caps, action
 * overrides, custom actions) into a policy with per-action extensions — then
 * compiles and freezes the snapshot a run pins for its lifetime.
 *
 * Every fact is taken from where the app already keeps it; nothing is guessed:
 * - capabilities come from the routing catalog snapshot (unknown = unsupported,
 *   except for a deployment the user pinned by picking it explicitly);
 * - a rate card exists only when the pricing layers know BOTH input and output
 *   rates; otherwise the deployment is unpriced (tracked budgets hold a
 *   conservative placeholder, strict budgets exclude it);
 * - local models get an audited zero card; subscription lanes get a zero card
 *   but are `billingTransparency: "estimated"` (quota, not a bill);
 * - the Claude Agent SDK lane loops internally, so it is `estimated` too and its
 *   retries are `observable` (`api_retry` frames), never hidden.
 */

import {
  actionExtensionFor,
  builtinPolicy,
  compileFusionConfig,
  listFusionActions,
  type CompiledFusionConfig,
  type DataClass,
  type FusionDeployment,
  type FusionRegistry,
  type RateCard,
  type RuntimeEnvironment,
} from "@cognia/router-fusion"
import type { RouterFusionSettings } from "@cognia/router-fusion/settings/settings"

export type ChatLane = "ai-sdk" | "claude-agent-sdk"

export interface DeploymentRef {
  providerId: string
  modelId: string
}

/** The engine's deployment key shape (`providerId::modelId`), reused as the fusion id. */
export function deploymentIdOf(ref: DeploymentRef): string {
  return `${ref.providerId}::${ref.modelId}`
}

export interface DeploymentFacts {
  capabilities?: {
    tools?: boolean
    vision?: boolean
    structuredOutput?: boolean
    contextTokens?: number
  }
  /** Usable context window from the routing engine deps, when known. */
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: {
    promptPer1M?: number
    completionPer1M?: number
    cachedInputPer1M?: number
    cacheCreationPer1M?: number
  } | null
  local: boolean
  subscription: boolean
  lane: ChatLane
  /** Aggregators cannot prove where restricted data ends up (D30). */
  aggregator: boolean
}

export interface BuildRegistryInput {
  deployments: DeploymentRef[]
  aliases: Record<string, DeploymentRef[]>
  /** A deployment the user picked explicitly: an unknown capability is taken as supported. */
  pinned?: DeploymentRef
  factsOf: (ref: DeploymentRef) => DeploymentFacts
}

const DEFAULT_CONTEXT_TOKENS = 32_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8192
const ZERO_CARD_ID = "rc:audited-zero"

/** USD per million as the contract's decimal string, rounded UP to 6 decimals. */
export function usdPerMillionDecimal(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value >= 1_000_000) return null
  const micro = Math.ceil(Math.round(value * 1e9) / 1e3)
  const whole = Math.floor(micro / 1e6)
  const fraction = String(micro % 1e6)
    .padStart(6, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function rateCardFor(id: string, pricing: DeploymentFacts["pricing"]): RateCard | null {
  if (!pricing || pricing.promptPer1M === undefined || pricing.completionPer1M === undefined) {
    return null
  }
  const input = usdPerMillionDecimal(pricing.promptPer1M)
  const output = usdPerMillionDecimal(pricing.completionPer1M)
  // Unknown cache tiers are priced conservatively: a read costs a full input
  // token, a write costs what Anthropic charges for the 5 minute / 1 hour tiers.
  const cacheRead = usdPerMillionDecimal(pricing.cachedInputPer1M ?? pricing.promptPer1M)
  const write5m = usdPerMillionDecimal(pricing.cacheCreationPer1M ?? pricing.promptPer1M * 1.25)
  const write1h = usdPerMillionDecimal(pricing.promptPer1M * 2)
  if (!input || !output || !cacheRead || !write5m || !write1h) return null
  return {
    id,
    example_only: false,
    currency: "USD",
    ordinary_input_per_million: input,
    output_per_million: output,
    cache_read_per_million: cacheRead,
    cache_write_5m_per_million: write5m,
    cache_write_1h_per_million: write1h,
  }
}

const ZERO_CARD: RateCard = {
  id: ZERO_CARD_ID,
  example_only: false,
  currency: "USD",
  ordinary_input_per_million: "0",
  output_per_million: "0",
  cache_read_per_million: "0",
  cache_write_5m_per_million: "0",
  cache_write_1h_per_million: "0",
}

export function buildFusionRegistry(input: BuildRegistryInput): FusionRegistry {
  const byId = new Map<string, DeploymentRef>()
  for (const ref of [
    ...input.deployments,
    ...Object.values(input.aliases).flat(),
    ...(input.pinned ? [input.pinned] : []),
  ]) {
    byId.set(deploymentIdOf(ref), ref)
  }
  const pinnedId = input.pinned ? deploymentIdOf(input.pinned) : null
  const rateCards: RateCard[] = []
  const deployments: FusionDeployment[] = []
  let usesZeroCard = false

  for (const [id, ref] of byId) {
    const facts = input.factsOf(ref)
    const pinned = id === pinnedId
    const capability = (value: boolean | undefined) => (pinned ? value !== false : value === true)
    let rateCardId: string | null = null
    if (facts.local || facts.subscription) {
      rateCardId = ZERO_CARD_ID
      usesZeroCard = true
    } else {
      const card = rateCardFor(`rc:${id}`, facts.pricing)
      if (card) {
        rateCards.push(card)
        rateCardId = card.id
      }
    }
    const dataClasses: DataClass[] = facts.local
      ? ["public", "internal", "restricted"]
      : ["public", "internal", ...(facts.aggregator ? [] : (["restricted"] as DataClass[]))]
    const contextLimit = Math.max(
      1,
      Math.floor(facts.contextWindow ?? facts.capabilities?.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
    )
    deployments.push({
      id,
      providerId: ref.providerId,
      modelRevision: ref.modelId,
      dataClasses,
      inputModalities: capability(facts.capabilities?.vision) ? ["text", "image"] : ["text"],
      contextLimit,
      maxOutputTokens: Math.max(1, Math.floor(facts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)),
      supportsTools: capability(facts.capabilities?.tools),
      supportsJsonSchema: capability(facts.capabilities?.structuredOutput),
      usageLookup: false,
      providerIdempotency: false,
      cacheMode: facts.local
        ? "none"
        : ref.providerId === "anthropic" || facts.lane === "claude-agent-sdk"
          ? "explicit"
          : "automatic",
      rateCardId,
      internalRetry: facts.lane === "claude-agent-sdk" ? "observable" : "none",
      billingTransparency:
        facts.subscription || facts.lane === "claude-agent-sdk" ? "estimated" : "bounded",
      enabled: true,
      exampleOnly: false,
      p95LatencyMs: facts.local ? 30_000 : 20_000,
    })
  }
  if (usesZeroCard) rateCards.push(ZERO_CARD)

  const aliases: Record<string, string[]> = {}
  for (const [alias, refs] of Object.entries(input.aliases)) {
    const ids = [...new Set(refs.map(deploymentIdOf))]
    if (ids.length > 0) aliases[alias] = ids
  }
  return {
    registry_version: "cognia-settings-1",
    example_only: false,
    deployments,
    aliases,
    rate_cards: rateCards,
  }
}

export interface FusionPolicyBuild {
  config: CompiledFusionConfig
  /** Actions left out of this snapshot and why (e.g. a role tier the user has not configured). */
  omittedActions: Array<{ actionId: string; reason: string }>
}

/** The built-in catalog with the user's overrides applied, followed by the user's own actions. */
export { listFusionActions }

/**
 * Compile the snapshot a run pins. Actions whose role tiers do not exist in this
 * registry cannot be assessed and are omitted with a reason the decision records.
 */
export function buildFusionConfig(
  settings: RouterFusionSettings,
  registry: FusionRegistry,
  environment: RuntimeEnvironment
): FusionPolicyBuild {
  const all = listFusionActions(settings)
  const omittedActions: FusionPolicyBuild["omittedActions"] = []
  const actions = all.filter((action) => {
    const missing = Object.values(action.roles).find((alias) => !registry.aliases[alias])
    if (missing) omittedActions.push({ actionId: action.id, reason: `alias_missing:${missing}` })
    return !missing
  })
  const extensions = Object.fromEntries(actions.map((a) => [a.id, actionExtensionFor(a, settings)]))
  const config = compileFusionConfig({
    policy: builtinPolicy(actions),
    registry,
    extensions,
    environment,
  })
  return { config, omittedActions }
}
