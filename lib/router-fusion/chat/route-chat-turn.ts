/**
 * Route a chat turn as a Router + Fusion direct run (ADR-0188 B1, D5/D10/D11/D31/D34).
 *
 * Two steps, because the facts a route needs arrive at two points of the send
 * pipeline:
 *
 * 1. `selectChatDeployment` — at the routing block, where the legacy planner
 *    ran. The requested selection is resolved by the app's own
 *    `ProviderRoutingEngine` (health, breakers, capabilities, data policy), with
 *    none of the silent fallbacks: no candidate is an explicit refusal, never a
 *    quiet switch to another tier or provider. Auto no longer climbs the
 *    difficulty ladder; the action router picks a direct action from the rule
 *    rows the user approved (none approved → `direct_baseline`), and the engine
 *    resolves that action's tier alias to a deployment.
 *
 * 2. `sealChatRoute` — at the end of the pipeline, once the provider, model,
 *    runtime lane and account environment are final (a plugin can still change
 *    the model late). Billing becomes definitive here: an OAuth subscription
 *    token means quota, not a bill. The RouteDecision is recomputed for the
 *    deployment that will actually be called, the run cap and per-call output
 *    bound are fixed, and the turn is stamped for the sidecar and the renderer.
 *
 * Neither step writes anything: the run is created by `beginChatRun` right
 * before dispatch.
 */

import {
  buildClassifierInput,
  classifyWithRules,
  extractFeatures,
  resolveDataClass,
  RULES_CLASSIFIER_VERSION,
  routeAction,
  usdToMicrousd,
  type ActionRouteResult,
  type DataClass,
  type DeploymentHealth,
  type RouteDecision,
  type RouteRequest,
  type RoutingFeatures,
  type RuleId,
  type RulesClassifierHints,
  type RuntimeEnvironment,
} from "@cognia/router-fusion"
import type { RouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import type {
  AppSettings,
  RouterFusionLedgerStamp,
  RouterFusionTurnStamp,
} from "@cognia/agent-config-types"
import { RoutingNoCandidatesError, type RoutingEngineDeps } from "@cognia/provider-routing"
import type {
  ModelRoutingSelection,
  RoutingPlan,
  RoutingRequest,
} from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"

import type { PreparedChatRoute } from "./chat-runs"
import {
  buildFusionConfig,
  buildFusionRegistry,
  deploymentIdOf,
  listFusionActions,
  type ChatLane,
  type DeploymentFacts,
  type DeploymentRef,
} from "./fusion-config"

export const CHAT_CLASSIFIER_TOKEN_CAP = 4096
/** The action a pinned model (manual or alias pick) runs under: its caps and limits apply. */
export const PINNED_CHAT_ACTION_ID = "direct_baseline"
/** Environment variables that carry a subscription (quota) credential rather than a billed key. */
export const SUBSCRIPTION_TOKEN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"] as const

export interface ChatRouteHost {
  settings: RouterFusionSettings
  engineDeps: Pick<
    RoutingEngineDeps,
    | "getCapabilities"
    | "getContextWindow"
    | "isLocalProvider"
    | "getCircuitBreakerState"
    | "getDeploymentCircuitBreakerState"
    | "isProviderAvailable"
  >
  planRoute: (request: RoutingRequest) => Promise<RoutingPlan>
  pricingOf: (providerId: string, modelId: string) => Partial<ModelPricing> | null
  /** The provider's credentials can be a subscription (OAuth) rather than a billed key. */
  subscriptionCapable: (providerId: string) => boolean
  /** Aggregators cannot prove where restricted data ends up (D30). */
  isAggregator: (providerId: string) => boolean
  /** Settings as they are NOW, for the live check at every reservation (AUTH-07). */
  currentSettings: () => AppSettings | undefined
  environment: RuntimeEnvironment
  now: () => number
  newId: () => string
}

/**
 * The facts a route needs that do not involve the engine's own planning. A
 * utility call has already chosen its deployment, so it builds one of these
 * and reuses the helpers below without an engine
 * (`lib/router-fusion/calls/utility-route.ts`).
 */
export type RouteFactsHost = Omit<ChatRouteHost, "planRoute">

export interface ChatSelectionInput {
  selection: ModelRoutingSelection
  /** The engine request the legacy block built; its selection is replaced per alias. */
  routingRequest: RoutingRequest
  promptText: string
  estimatedInputTokens: number
  hints: RulesClassifierHints
  workspaceId: string | null
  hasImages: boolean
  /** The turn's tools need a tool-capable model. */
  needsTools: boolean
}

export type ChatSelection =
  | {
      kind: "selected"
      providerId: string
      modelId: string
      /** The engine plan for the chosen deployment, for the routing indicator and telemetry. */
      plan: RoutingPlan
      actionId: string
      ruleId: RuleId | null
      features: RoutingFeatures
      /** Deployments each tier alias resolved to, in the engine's order. */
      aliasRefs: Record<string, DeploymentRef[]>
      dataClass: DataClass
      /** Selection facts carried into the seal. */
      selectionKind: ModelRoutingSelection["kind"]
      estimatedInputTokens: number
      hasImages: boolean
      needsTools: boolean
    }
  | ChatRouteRefusal

export interface ChatRouteRefusal {
  kind: "refused"
  code: "ROUTE_NO_SOLUTION"
  /** Why nothing was eligible: engine aliases without candidates, action exclusions. */
  reasons: string[]
  decision: RouteDecision | null
}

// ── shared pieces ─────────────────────────────────────────────────────────────

export function dataClassFor(
  settings: RouterFusionSettings,
  workspaceId: string | null
): DataClass {
  // A workspace may only raise the default, never lower it (D30). Chat has no
  // per-session override yet, so the session argument is left out.
  return resolveDataClass(settings, workspaceId ?? undefined)
}

/**
 * Trusted features for a chat turn. The conversation itself is how a chat asks
 * for missing information, so a chat turn never pauses for input: the model
 * asks in its reply. `missing_information` is therefore empty by construction.
 */
export function chatFeatures(promptText: string, hints: RulesClassifierHints): RoutingFeatures {
  const snapshot = {
    userText: promptText,
    trustedConstraints: [],
    phase: "intake" as const,
    failedAttempts: 0,
    verificationKinds: [],
    sourceRevision: null,
    missingInformation: [],
  }
  const input = buildClassifierInput(snapshot, CHAT_CLASSIFIER_TOKEN_CAP)
  const features = extractFeatures(snapshot, classifyWithRules(input.text, hints), input)
  return { ...features, missing_information: [] }
}

function healthOf(host: RouteFactsHost, ref: DeploymentRef): DeploymentHealth {
  const deps = host.engineDeps
  if (!deps.isProviderAvailable(ref.providerId)) return "unavailable"
  const deployment = deps.getDeploymentCircuitBreakerState?.(deploymentIdOf(ref))
  const provider = deps.getCircuitBreakerState(ref.providerId)
  if (deployment === "open" || provider === "open") return "unavailable"
  if (deployment === "half-open" || provider === "half-open") return "degraded"
  return "healthy"
}

export function factsFor(
  host: RouteFactsHost,
  ref: DeploymentRef,
  billing: { subscription: boolean; lane: ChatLane }
): DeploymentFacts {
  const deps = host.engineDeps
  const capabilities = deps.getCapabilities?.(ref.providerId, ref.modelId)
  const local = deps.isLocalProvider?.(ref.providerId) ?? false
  return {
    ...(capabilities
      ? {
          capabilities: {
            ...(capabilities.tools !== undefined ? { tools: capabilities.tools } : {}),
            ...(capabilities.vision !== undefined ? { vision: capabilities.vision } : {}),
            ...(capabilities.structuredOutput !== undefined
              ? { structuredOutput: capabilities.structuredOutput }
              : {}),
            ...(capabilities.contextTokens !== undefined
              ? { contextTokens: capabilities.contextTokens }
              : {}),
          },
        }
      : {}),
    ...(deps.getContextWindow
      ? { contextWindow: deps.getContextWindow(ref.providerId, ref.modelId) }
      : {}),
    pricing: host.pricingOf(ref.providerId, ref.modelId),
    local,
    subscription: billing.subscription,
    lane: billing.lane,
    aggregator: host.isAggregator(ref.providerId),
  }
}

export function laneOfProvider(providerId: string): ChatLane {
  return providerId === "anthropic" ? "claude-agent-sdk" : "ai-sdk"
}

export function routeRequestFor(
  host: RouteFactsHost,
  input: {
    runId: string
    decisionId: string
    features: RoutingFeatures
    estimatedInputTokens: number
    hasImages: boolean
    dataClass: DataClass
    refs: DeploymentRef[]
    requestedActionId?: string
    solverOverride?: string
    routingPolicy?: RoutingRequest["dataPolicy"]
  }
): RouteRequest {
  const { settings } = host
  const health: Record<string, DeploymentHealth> = {}
  for (const ref of input.refs) health[deploymentIdOf(ref)] = healthOf(host, ref)
  return {
    runId: input.runId,
    decisionId: input.decisionId,
    createdAt: new Date(host.now()).toISOString(),
    requestedMode: input.requestedActionId ? "direct" : "auto",
    ...(input.requestedActionId ? { requestedActionId: input.requestedActionId } : {}),
    // Chat is a direct run in this release; fusion modes are chosen explicitly elsewhere.
    allowedModes: ["direct"],
    profile: "balanced",
    // A chat reply is not a delivered change; the agent's own tool edits are
    // reviewed by the permission system, not by an acceptance profile.
    deliversChange: false,
    budgetMode: settings.budgetMode,
    runAvailableMicrousd: Number.MAX_SAFE_INTEGER,
    deadlineRemainingMs: Number.MAX_SAFE_INTEGER,
    dataPolicy: {
      dataClass: input.dataClass,
      restrictedGrantProviderIds: [...settings.restrictedGrantProviderIds],
      revokedDeploymentIds: [],
      ...(input.routingPolicy?.allowedProviderIds
        ? { allowedProviderIds: [...input.routingPolicy.allowedProviderIds] }
        : {}),
      ...(input.routingPolicy?.excludedProviderIds
        ? { excludedProviderIds: [...input.routingPolicy.excludedProviderIds] }
        : {}),
    },
    inputModalities: input.hasImages ? ["text", "image"] : ["text"],
    estimatedInputTokens: Math.max(1, input.estimatedInputTokens),
    features: input.features,
    classifierVersion: RULES_CLASSIFIER_VERSION,
    approvedRuleRows: [...settings.approvedRuleRows],
    health,
    capabilities: {
      sandboxTier: null,
      acceptanceProfileAvailable: false,
      // A chat turn has no review call in this release: text_basic (schema only) is the one profile.
      verifierProfiles: ["text_basic"],
      webToolsAvailable: false,
    },
    hasFusionAncestor: false,
    ...(input.solverOverride ? { roleDeploymentOverrides: { solver: input.solverOverride } } : {}),
    unknownPriceCallReserveMicrousd: usdToMicrousd(settings.unknownPriceCallReserveUsd),
  }
}

/**
 * Why actions could not serve the turn. With `focus`, only that action's
 * reasons (every other action is excluded as "not requested", which says
 * nothing); without, every action a chat could run (modes chat does not allow
 * are not a reason).
 */
export function exclusionsOf(result: ActionRouteResult, focus?: string): string[] {
  return result.decision.candidates
    .filter((candidate) => !candidate.eligible)
    .filter((candidate) =>
      focus
        ? candidate.action_id === focus
        : !candidate.exclusion_reasons.includes("MODE_NOT_ALLOWED")
    )
    .flatMap((candidate) =>
      candidate.exclusion_reasons.map((reason) => `${candidate.action_id}:${reason}`)
    )
}

function refsOfPlan(plan: RoutingPlan): DeploymentRef[] {
  const seen = new Set<string>()
  const refs: DeploymentRef[] = []
  for (const candidate of plan.orderedCandidates) {
    const ref = { providerId: candidate.providerId, modelId: candidate.modelId }
    const id = deploymentIdOf(ref)
    if (seen.has(id)) continue
    seen.add(id)
    refs.push(ref)
  }
  return refs
}

/** The plan with `ref` promoted to the selected candidate (the action router may skip an unhealthy first pick). */
function planSelecting(plan: RoutingPlan, ref: DeploymentRef): RoutingPlan {
  const index = plan.orderedCandidates.findIndex(
    (candidate) => candidate.providerId === ref.providerId && candidate.modelId === ref.modelId
  )
  const { costCap: _softCap, overBudgetWarning: _warning, ...rest } = plan
  if (index <= 0) return rest
  const selected = plan.orderedCandidates[index]
  return {
    ...rest,
    selected,
    orderedCandidates: [selected, ...plan.orderedCandidates.filter((_, i) => i !== index)],
  }
}

// ── 1. selection ─────────────────────────────────────────────────────────────

/**
 * Resolve the requested selection to one deployment without any silent
 * fallback. Engine errors other than "no candidates" propagate unchanged, as
 * they do on the ordinary path.
 */
export async function selectChatDeployment(
  host: ChatRouteHost,
  input: ChatSelectionInput
): Promise<ChatSelection> {
  const dataClass = dataClassFor(host.settings, input.workspaceId)
  const labelled = chatFeatures(input.promptText, input.hints)
  // Whether the turn can use tools is a runtime fact, not a label: a prompt that
  // mentions files does not make a tool-less turn need a tool-capable model.
  const features: RoutingFeatures = input.needsTools ? labelled : { ...labelled, tool_need: "none" }
  // The soft per-request cap is replaced by the run cap (D5/D31): the engine
  // must not drop or reorder candidates by it.
  const baseRequest: RoutingRequest = {
    ...input.routingRequest,
    maxCostPerRequestUsd: Number.POSITIVE_INFINITY,
  }
  const common = {
    features,
    dataClass,
    selectionKind: input.selection.kind,
    estimatedInputTokens: input.estimatedInputTokens,
    hasImages: input.hasImages,
    needsTools: input.needsTools,
  }

  if (input.selection.kind !== "auto") {
    let plan: RoutingPlan
    try {
      plan = await host.planRoute({ ...baseRequest, selection: input.selection })
    } catch (error) {
      if (!(error instanceof RoutingNoCandidatesError)) throw error
      const target =
        input.selection.kind === "alias"
          ? `alias:${input.selection.alias}`
          : `${input.selection.providerId}::${input.selection.modelId}`
      return {
        kind: "refused",
        code: "ROUTE_NO_SOLUTION",
        reasons: [`NO_CANDIDATES:${target}`],
        decision: null,
      }
    }
    const ref = { providerId: plan.selected.providerId, modelId: plan.selected.modelId }
    return {
      kind: "selected",
      ...ref,
      plan: planSelecting(plan, ref),
      actionId: PINNED_CHAT_ACTION_ID,
      ruleId: "R1_explicit_action",
      aliasRefs: {},
      ...common,
    }
  }

  // Auto: resolve every tier alias a direct action can use, then let the action
  // router choose among the actions the user's approved rule rows allow.
  const directAliases = new Set<string>()
  for (const action of listFusionActions(host.settings)) {
    if (action.mode !== "direct" || action.enabled === false) continue
    for (const alias of Object.values(action.roles)) directAliases.add(alias)
  }
  const aliasPlans: Record<string, RoutingPlan> = {}
  const aliasRefs: Record<string, DeploymentRef[]> = {}
  const reasons: string[] = []
  for (const alias of directAliases) {
    try {
      const plan = await host.planRoute({ ...baseRequest, selection: { kind: "alias", alias } })
      aliasPlans[alias] = plan
      aliasRefs[alias] = refsOfPlan(plan)
    } catch (error) {
      if (!(error instanceof RoutingNoCandidatesError)) throw error
      reasons.push(`NO_CANDIDATES:alias:${alias}`)
    }
  }
  const refs = Object.values(aliasRefs).flat()
  const registry = buildFusionRegistry({
    deployments: refs,
    aliases: aliasRefs,
    // Billing is provisional here: a subscription-capable provider is assumed
    // to be on quota; the seal decides from the account actually used.
    factsOf: (ref) =>
      factsFor(host, ref, {
        subscription: host.subscriptionCapable(ref.providerId),
        lane: laneOfProvider(ref.providerId),
      }),
  })
  const { config, omittedActions } = buildFusionConfig(host.settings, registry, host.environment)
  const directIds = new Set(
    listFusionActions(host.settings)
      .filter((action) => action.mode === "direct")
      .map((action) => action.id)
  )
  // Only direct actions can serve a chat turn; the others' gaps are not a reason here.
  for (const omitted of omittedActions) {
    if (directIds.has(omitted.actionId)) reasons.push(`${omitted.actionId}:${omitted.reason}`)
  }
  const result = routeAction(
    config,
    routeRequestFor(host, {
      runId: host.newId(),
      decisionId: host.newId(),
      features,
      estimatedInputTokens: input.estimatedInputTokens,
      hasImages: input.hasImages,
      dataClass,
      refs,
      routingPolicy: input.routingRequest.dataPolicy,
    })
  )
  const solverId = result.selected?.roles.solver
  const solver = solverId ? config.deploymentsById[solverId] : undefined
  if (!result.selected || !solver) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [...reasons, ...exclusionsOf(result)],
      decision: result.decision,
    }
  }
  const ref = { providerId: solver.providerId, modelId: solver.modelRevision }
  const solverAlias = config.actions[result.selected.actionId].config.roles.solver
  const solverPlan = solverAlias ? aliasPlans[solverAlias] : undefined
  if (!solverPlan) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [...reasons, `SOLVER_ALIAS_UNRESOLVED:${solverAlias ?? "none"}`],
      decision: result.decision,
    }
  }
  return {
    kind: "selected",
    ...ref,
    plan: planSelecting(solverPlan, ref),
    actionId: result.selected.actionId,
    ruleId: result.ruleId,
    aliasRefs,
    ...common,
  }
}

// ── 2. seal ──────────────────────────────────────────────────────────────────

export interface ChatSealInput {
  selection: Extract<ChatSelection, { kind: "selected" }>
  /** The provider and model the send will actually use (a late plugin patch included). */
  providerId: string
  modelId: string
  lane: ChatLane
  /** The turn's final environment overlay (account credentials included). */
  env: Record<string, string> | undefined
  sessionId: string
  /** The send's own output bound, when the user configured one. */
  maxOutputTokens: number | undefined
  /** The Agent SDK budget the send already carries (a goal budget), if any. */
  existingMaxBudgetUsd: number | undefined
}

export type ChatSeal =
  | {
      kind: "stamped"
      stamp: RouterFusionTurnStamp
      ledger: RouterFusionLedgerStamp
      prepared: PreparedChatRoute
      /** The output bound every call of the turn is reserved for; pinned onto the send when unset. */
      maxOutputTokens: number
      decision: RouteDecision
    }
  | ChatRouteRefusal

/** Quota or bill: decided by the credential the account environment actually carries. */
export function isSubscriptionEnv(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  return SUBSCRIPTION_TOKEN_ENV.some((key) => typeof env[key] === "string" && env[key].length > 0)
}

/**
 * Fix the route for the deployment the send will call, with definitive billing,
 * and stamp the turn. A route that is not feasible for that deployment (its
 * reserve exceeds the run cap, its data class is not allowed, strict budget and
 * no audited price) is an explicit refusal.
 */
export function sealChatRoute(host: ChatRouteHost, input: ChatSealInput): ChatSeal {
  const { selection, lane } = input
  const ref: DeploymentRef = { providerId: input.providerId, modelId: input.modelId }
  const deploymentId = deploymentIdOf(ref)
  const subscription = isSubscriptionEnv(input.env)
  const actions = listFusionActions(host.settings)
  const action = actions.find((candidate) => candidate.id === selection.actionId)
  const solverAlias = action?.roles.solver
  // The chosen action's solver tier resolves to this deployment for the run;
  // other tiers keep what the engine resolved so the snapshot stays complete.
  const aliases: Record<string, DeploymentRef[]> = { ...selection.aliasRefs }
  if (solverAlias) aliases[solverAlias] = [ref]
  const registry = buildFusionRegistry({
    deployments: [ref],
    aliases,
    // A model the user picked by name is taken at its word for capabilities it did not deny.
    ...(selection.selectionKind === "manual" ? { pinned: ref } : {}),
    factsOf: (candidate) =>
      deploymentIdOf(candidate) === deploymentId
        ? factsFor(host, candidate, { subscription, lane })
        : factsFor(host, candidate, {
            subscription: host.subscriptionCapable(candidate.providerId),
            lane: laneOfProvider(candidate.providerId),
          }),
  })
  const { config, omittedActions } = buildFusionConfig(host.settings, registry, host.environment)
  const runId = host.newId()
  const result = routeAction(
    config,
    routeRequestFor(host, {
      runId,
      decisionId: host.newId(),
      features: selection.features,
      estimatedInputTokens: selection.estimatedInputTokens,
      hasImages: selection.hasImages,
      dataClass: selection.dataClass,
      refs: [ref, ...Object.values(selection.aliasRefs).flat()],
      requestedActionId: selection.actionId,
      solverOverride: deploymentId,
    })
  )
  const compiled = config.actions[selection.actionId]
  if (!result.selected || !compiled || result.selected.estimate === null) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [
        ...omittedActions
          .filter((omitted) => omitted.actionId === selection.actionId)
          .map((omitted) => `${omitted.actionId}:${omitted.reason}`),
        ...exclusionsOf(result, selection.actionId),
      ],
      decision: result.decision,
    }
  }
  const deployment = config.deploymentsById[deploymentId]
  const extension = compiled.extension
  const estimate = result.selected.estimate
  const capMicrousd = extension.run_cap_microusd
  const maxOutputTokens =
    input.maxOutputTokens ?? Math.min(extension.role_output_tokens, deployment.maxOutputTokens)
  // The seal pins the action, so its own rule is always "explicit action"; the
  // rule that made the choice is the selection's (e.g. R6_baseline for Auto).
  const ruleId = selection.ruleId
  const decision: RouteDecision = {
    ...result.decision,
    reason_codes: [
      ...result.decision.reason_codes,
      `selection:${selection.selectionKind}`,
      ...(ruleId ? [`selected_by:${ruleId}`] : []),
      `billing:${subscription ? "subscription" : "metered"}`,
    ],
  }
  const stamp: RouterFusionTurnStamp = {
    runId,
    decisionId: decision.decision_id,
    actionId: selection.actionId,
    mode: "direct",
    ruleId,
    deploymentId,
    providerId: ref.providerId,
    modelId: ref.modelId,
    budgetMode: host.settings.budgetMode,
    capMicrousd,
    reserveEstimateMicrousd: estimate.reserveMicrousd,
    priceKnown: estimate.priceKnown,
    acceptanceProfile: result.acceptanceProfile ?? "text_basic",
    lane,
  }
  const capUsd = capMicrousd / 1_000_000
  const ledger: RouterFusionLedgerStamp = {
    runId,
    mode: lane === "claude-agent-sdk" ? "envelope" : "per_call",
    transportAttempts: extension.limits.transport_attempts_per_call,
    deploymentId,
    ...(lane === "claude-agent-sdk"
      ? {
          envelopeMaxBudgetUsd:
            input.existingMaxBudgetUsd !== undefined
              ? Math.min(input.existingMaxBudgetUsd, capUsd)
              : capUsd,
        }
      : {}),
  }
  const dataClass = selection.dataClass
  const prepared: PreparedChatRoute = {
    stamp,
    ledger,
    decision,
    config,
    sessionId: input.sessionId,
    dataClass,
    maxModelCalls: extension.limits.max_model_calls,
    deadlineMs: extension.limits.deadline_ms,
    unknownPriceCallReserveMicrousd: usdToMicrousd(host.settings.unknownPriceCallReserveUsd),
    liveRefusal: (calledDeploymentId) => liveRefusalFor(host, calledDeploymentId, dataClass),
  }
  return { kind: "stamped", stamp, ledger, prepared, maxOutputTokens, decision }
}

/**
 * AUTH-07, evaluated against the settings of this moment: a provider switched
 * off, a restricted-data grant withdrawn, or Router + Fusion itself switched off
 * for chat since the route was made. A deployment id outside the app's
 * `provider::model` shape (never produced here) is refused as unknown.
 */
export function liveRefusalFor(
  host: RouteFactsHost,
  deploymentId: string,
  dataClass: DataClass,
  surface: RouterFusionSurface = "chat"
): string | null {
  const separator = deploymentId.indexOf("::")
  if (separator <= 0) return "DEPLOYMENT_UNKNOWN"
  const providerId = deploymentId.slice(0, separator)
  const settings = host.currentSettings()
  const fusion = settings?.routerFusion
  if (!fusion || fusion.enabled !== true || fusion.surfaces?.[surface] !== true)
    return "ROUTER_FUSION_DISABLED"
  if (!host.engineDeps.isProviderAvailable(providerId)) return "PROVIDER_UNAVAILABLE"
  if (
    dataClass === "restricted" &&
    !(host.engineDeps.isLocalProvider?.(providerId) ?? false) &&
    !(fusion.restrictedGrantProviderIds ?? []).includes(providerId)
  ) {
    return "RESTRICTED_NOT_GRANTED"
  }
  return null
}
