/**
 * Route a Run API request across every mode it allows (ADR-0188 D10/D11/D13, B3).
 *
 * A chat turn is a direct run, so its route only ever chooses a direct action.
 * A Run API request can ask for `auto`, `cascade` or `panel`, and the answer is
 * the full ActionRouter: every enabled action of an allowed mode is assessed,
 * every role alias of those actions is resolved by the app's own routing engine
 * (health, breakers, capabilities, data policy), and the decision records each
 * candidate with its real exclusions and estimates.
 *
 * The run executes on this host with the AI SDK and the user's own API keys
 * (`calls/role-call-executor.ts`), so every deployment is described as that
 * lane: metered, bounded billing, no hidden retries. Nothing is relaxed to find
 * a route: when no action fits data scope, capabilities and budget together,
 * the request is refused with the router's reasons (ROUTE-08).
 */

import {
  buildClassifierInput,
  classifyWithRules,
  extractFeatures,
  isVerifierProfile,
  routeAction,
  usdToMicrousd,
  type CompiledFusionConfig,
  type DataClass,
  type ExecutionMode,
  type Message,
  type RoleName,
  type RouteDecision,
  type RouteRequest,
  type RoutingFeatures,
  type RuleId,
  type RunRequest,
  type TaskKind,
  type VerifierProfile,
} from "@cognia/router-fusion"
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"

import {
  CHAT_CLASSIFIER_TOKEN_CAP,
  dataClassFor,
  exclusionsOf,
  factsFor,
  routeRequestFor,
} from "../chat/route-chat-turn"
import type { ChatRouteHost, ChatRouteRefusal } from "../chat/route-chat-turn"
import {
  buildFusionConfig,
  buildFusionRegistry,
  listFusionActions,
  type DeploymentRef,
} from "../chat/fusion-config"

export interface RunRouteInput {
  runId: string
  decisionId: string
  request: RunRequest
  messages: Message[]
  /** The caller asked for structured output: a schema check is possible. */
  jsonSchema: Record<string, unknown> | null
  sessionId: string
  /** The host can run the panel's read-only web tools. */
  webToolsAvailable: boolean
  executableModes: readonly ExecutionMode[]
  /**
   * The app project a chat turn belongs to, for its data class (D30). A Run API
   * request names its workspace in `request.workspace_id` instead.
   */
  workspaceId?: string | null
}

export type RunRoute =
  | {
      kind: "selected"
      config: CompiledFusionConfig
      decision: RouteDecision
      actionId: string
      ruleId: RuleId | null
      mode: ExecutionMode
      /** Role → the deployment it is pinned to for the run's lifetime. */
      roles: Partial<Record<RoleName, string>>
      capMicrousd: number
      maxModelCalls: number
      deadlineMs: number
      task: TaskKind
      acceptanceProfile: VerifierProfile
      dataClass: DataClass
    }
  | ChatRouteRefusal

/** Profiles this host can produce for a Run API run. Code fixtures need a sandbox (B4). */
export function runVerifierProfiles(jsonSchema: Record<string, unknown> | null): VerifierProfile[] {
  return [
    "text_basic",
    "text_review",
    "evidence_review",
    ...(jsonSchema ? (["schema_fixture"] as VerifierProfile[]) : []),
  ]
}

/** Labels for the request: the caller's text is untrusted, its system turns are its constraints. */
export function runFeatures(
  messages: readonly Message[],
  jsonSchema: Record<string, unknown> | null
): RoutingFeatures {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")
  const snapshot = {
    userText,
    trustedConstraints: messages
      .filter((message) => message.role === "system")
      .map((message) => message.content),
    phase: "intake" as const,
    failedAttempts: 0,
    verificationKinds: jsonSchema ? ["json_schema"] : [],
    sourceRevision: null,
    missingInformation: [],
  }
  const input = buildClassifierInput(snapshot, CHAT_CLASSIFIER_TOKEN_CAP)
  const features = extractFeatures(
    snapshot,
    classifyWithRules(input.text, { hasCode: /```/.test(userText) }),
    input
  )
  // A Run API request is answered, not paused: what the model cannot know, it
  // says in its answer. Waiting for input belongs to delegate work (B4).
  return { ...features, missing_information: [] }
}

function refsOfPlan(plan: RoutingPlan): DeploymentRef[] {
  const seen = new Set<string>()
  const refs: DeploymentRef[] = []
  for (const candidate of plan.orderedCandidates) {
    const key = `${candidate.providerId}::${candidate.modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ providerId: candidate.providerId, modelId: candidate.modelId })
  }
  return refs
}

export async function routeRunRequest(
  host: ChatRouteHost,
  input: RunRouteInput
): Promise<RunRoute> {
  const { request } = input
  const allowedModes = (request.mode === "auto" ? request.allowed_modes : [request.mode]).filter(
    (mode) => input.executableModes.includes(mode)
  )
  const actions = listFusionActions(host.settings).filter(
    (action) => action.enabled !== false && allowedModes.includes(action.mode)
  )
  const aliases = [...new Set(actions.flatMap((action) => Object.values(action.roles)))]

  // Every alias the candidate actions name, resolved without any fallback.
  const baseRequest: RoutingRequest = {
    surface: "gateway",
    selection: { kind: "auto" },
    sessionId: input.sessionId,
    maxCostPerRequestUsd: Number.POSITIVE_INFINITY,
  }
  const aliasRefs: Record<string, DeploymentRef[]> = {}
  const reasons: string[] = []
  for (const alias of aliases) {
    try {
      aliasRefs[alias] = refsOfPlan(
        await host.planRoute({ ...baseRequest, selection: { kind: "alias", alias } })
      )
    } catch (error) {
      if (!(error instanceof RoutingNoCandidatesError)) throw error
      reasons.push(`NO_CANDIDATES:alias:${alias}`)
    }
  }
  const refs = Object.values(aliasRefs).flat()
  const registry = buildFusionRegistry({
    deployments: refs,
    aliases: aliasRefs,
    // The run is executed here with the user's API keys: metered, bounded.
    factsOf: (ref) => factsFor(host, ref, { subscription: false, lane: "ai-sdk" }),
  })
  const { config, omittedActions } = buildFusionConfig(host.settings, registry, host.environment)
  const candidateIds = new Set(actions.map((action) => action.id))
  for (const omitted of omittedActions) {
    if (candidateIds.has(omitted.actionId)) reasons.push(`${omitted.actionId}:${omitted.reason}`)
  }

  const features = runFeatures(input.messages, input.jsonSchema)
  const dataClass = dataClassFor(host.settings, input.workspaceId ?? request.workspace_id ?? null)
  const promptTokens = input.messages.reduce(
    (sum, message) => sum + Math.ceil(message.content.length / 4),
    0
  )
  const capMicrousd = usdToMicrousd(request.budget.max_cost_usd)
  const base = routeRequestFor(host, {
    runId: input.runId,
    decisionId: input.decisionId,
    features,
    estimatedInputTokens: Math.max(1, promptTokens),
    hasImages: false,
    dataClass,
    refs,
  })
  const routeRequest: RouteRequest = {
    ...base,
    requestedMode: request.mode,
    allowedModes,
    profile: request.profile,
    ...(request.acceptance_profile_id && isVerifierProfile(request.acceptance_profile_id)
      ? { requestedAcceptanceProfile: request.acceptance_profile_id }
      : {}),
    budgetMode: request.budget.mode,
    runAvailableMicrousd: capMicrousd,
    deadlineRemainingMs: request.deadline_ms,
    capabilities: {
      sandboxTier: null,
      acceptanceProfileAvailable: false,
      verifierProfiles: runVerifierProfiles(input.jsonSchema),
      webToolsAvailable: input.webToolsAvailable,
    },
  }
  const result = routeAction(config, routeRequest)
  const selected = result.selected
  if (!selected || !result.acceptanceProfile) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [...reasons, ...exclusionsOf(result)],
      decision: result.decision,
    }
  }
  const compiled = config.actions[selected.actionId]
  const decision: RouteDecision = {
    ...result.decision,
    reason_codes: [...result.decision.reason_codes, "entry:run_api", "billing:metered"],
  }
  return {
    kind: "selected",
    config,
    decision,
    actionId: selected.actionId,
    ruleId: result.ruleId,
    mode: selected.mode,
    roles: selected.roles,
    // A request may lower the action's cap and deadline, never raise them (D22).
    capMicrousd: Math.min(compiled.extension.run_cap_microusd, capMicrousd),
    maxModelCalls: compiled.extension.limits.max_model_calls,
    deadlineMs: Math.min(compiled.extension.limits.deadline_ms, request.deadline_ms),
    task: features.task,
    acceptanceProfile: result.acceptanceProfile,
    dataClass,
  }
}
