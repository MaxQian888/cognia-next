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
 *
 * An `auto` request is labelled by the rules classifier, or — with the opt-in
 * LLM classifier on (D18, B5) — by one ledgered classification call booked on
 * the routing surface, falling back to the rules on any failure (ROUTE-03). The
 * decision's `classifier_version` and reason codes say which it was and why.
 * An explicit mode is not chosen by labels, so it is never classified by a model.
 */

import {
  buildClassifierInput,
  classifyWithRules,
  ConfigCompileError,
  extractFeatures,
  intakeSnapshot,
  isVerifierProfile,
  routeAction,
  usdToMicrousd,
  type ClassifierInput,
  type ClassifierLabels,
  type CompiledFusionConfig,
  type DataClass,
  type ExecutionMode,
  type Message,
  type RoleName,
  type RouteDecision,
  type RouteRequest,
  type RoutingFeatures,
  type RoutingSnapshot,
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
  routeClassificationOf,
  routeRequestFor,
  withClassification,
} from "../chat/route-chat-turn"
import type { ChatRouteHost, ChatRouteRefusal } from "../chat/route-chat-turn"
import {
  DELEGATE_UNAVAILABLE,
  type DelegateCapabilities,
  type DelegateCapabilityDeps,
} from "./delegate-capabilities"
import type { ClassificationOutcome } from "./llm-classifier"
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
  /** Test seam: what this device can do for a delegate request (WP-D4). */
  delegateCapabilities?: DelegateCapabilityDeps
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
      /**
       * The project the run belongs to, and its checkout. Delegate needs both:
       * the acceptance profile and its approval live on the project, and the
       * sandbox stages into a worktree of that checkout. Null for every route
       * that named no project — which is also why such a request is never
       * routed to delegate.
       */
      projectId: string | null
      workspaceRoot: string | null
      /** The `.cognia/workspace.json` profile a delegate run must verify with. */
      acceptanceProfileId: string | null
    }
  | ChatRouteRefusal

/**
 * Profiles this host can produce for a Run API run.
 *
 * `code_fixture` is offered only when this device can BOTH confine the command
 * and find an approved one to run (B4): a profile with no runtime verifier can
 * only ever be inconclusive, and offering it would let the router pick an
 * action it cannot accept.
 */
export function runVerifierProfiles(
  jsonSchema: Record<string, unknown> | null,
  delegate: Pick<
    DelegateCapabilities,
    "sandboxTier" | "acceptanceProfileAvailable"
  > = DELEGATE_UNAVAILABLE
): VerifierProfile[] {
  return [
    "text_basic",
    "text_review",
    "evidence_review",
    ...(jsonSchema ? (["schema_fixture"] as VerifierProfile[]) : []),
    ...(delegate.sandboxTier !== null && delegate.acceptanceProfileAvailable
      ? (["code_fixture"] as VerifierProfile[])
      : []),
  ]
}

/** The request as the classifiers see it: the caller's text is untrusted, its system turns are its constraints. */
export function runSnapshot(
  messages: readonly Message[],
  jsonSchema: Record<string, unknown> | null
): RoutingSnapshot {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")
  return intakeSnapshot(userText, {
    trustedConstraints: messages
      .filter((message) => message.role === "system")
      .map((message) => message.content),
    verificationKinds: jsonSchema ? ["json_schema"] : [],
  })
}

/** Features from labels some classifier produced (the rules, or the model's). */
export function runFeaturesFrom(
  snapshot: RoutingSnapshot,
  classified: { labels: ClassifierLabels; input: ClassifierInput }
): RoutingFeatures {
  const features = extractFeatures(snapshot, classified.labels, classified.input)
  // A Run API request is answered, not paused: what the model cannot know, it
  // says in its answer. Waiting for input belongs to delegate work (B4).
  return { ...features, missing_information: [] }
}

/** Labels for the request from the rules classifier. */
export function runFeatures(
  messages: readonly Message[],
  jsonSchema: Record<string, unknown> | null
): RoutingFeatures {
  const snapshot = runSnapshot(messages, jsonSchema)
  const input = buildClassifierInput(snapshot, CHAT_CLASSIFIER_TOKEN_CAP)
  return runFeaturesFrom(snapshot, {
    labels: classifyWithRules(input.text, { hasCode: /```/.test(snapshot.userText) }),
    input,
  })
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
  const workspaceId = input.workspaceId ?? request.workspace_id ?? null

  // What this device can do for a delegate request, asked once and only when a
  // delegate action is actually a candidate — a cascade or a panel request
  // never pays for the sandbox probe or the project read (WP-D4).
  const delegatePossible = actions.some((action) => action.mode === "delegate")
  const delegate: DelegateCapabilities = delegatePossible
    ? await (async () => {
        const { delegateCapabilitiesFor } = await import("./delegate-capabilities")
        return delegateCapabilitiesFor(workspaceId, input.delegateCapabilities ?? {})
      })()
    : DELEGATE_UNAVAILABLE

  // Auto: the opt-in LLM classifier labels the request while the aliases are
  // planned. It never throws; a failure is the rules' labels and a reason.
  const snapshot = runSnapshot(input.messages, input.jsonSchema)
  const classifying: Promise<ClassificationOutcome> | null =
    request.mode === "auto" && host.classify
      ? host.classify({
          snapshot,
          hints: { hasCode: /```/.test(snapshot.userText) },
          surface: host.surface ?? "gatewayRuns",
          workspaceId,
        })
      : null

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
  // A request nothing can serve is a REFUSAL with reasons, never a throw.
  //
  // When no alias of any candidate action resolves — no provider configured,
  // every deployment excluded — the policy has zero actions, which the config
  // compiler rejects (`actions` has `minItems: 1`). Letting that `ConfigCompileError`
  // escape made `POST /v1/runs` answer 500 for something the contract calls
  // `422 ROUTE_NO_SOLUTION`, and threw away the reasons already collected.
  let built: ReturnType<typeof buildFusionConfig>
  try {
    built = buildFusionConfig(host.settings, registry, host.environment)
  } catch (error) {
    if (!(error instanceof ConfigCompileError)) throw error
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      // No decision: nothing was ever assessed, and inventing an empty one
      // would put a `RouteDecision` in the journal that describes no routing.
      reasons: [...reasons, ...error.issues.map((issue) => `CONFIG_INVALID:${issue.pointer}`)],
      decision: null,
    }
  }
  const { config, omittedActions } = built
  const candidateIds = new Set(actions.map((action) => action.id))
  for (const omitted of omittedActions) {
    if (candidateIds.has(omitted.actionId)) reasons.push(`${omitted.actionId}:${omitted.reason}`)
  }

  const outcome = classifying ? await classifying : null
  const classification = outcome ? routeClassificationOf(outcome) : undefined
  const features = outcome
    ? runFeaturesFrom(snapshot, outcome)
    : runFeatures(input.messages, input.jsonSchema)
  const dataClass = dataClassFor(host.settings, workspaceId)
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
    ...(classification ? { classifierVersion: classification.classifierVersion } : {}),
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
      sandboxTier: delegate.sandboxTier,
      acceptanceProfileAvailable: delegate.acceptanceProfileAvailable,
      verifierProfiles: runVerifierProfiles(input.jsonSchema, delegate),
      webToolsAvailable: input.webToolsAvailable,
    },
  }
  const result = routeAction(config, routeRequest)
  const selected = result.selected
  if (!selected || !result.acceptanceProfile) {
    return {
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: [
        ...reasons,
        ...exclusionsOf(result),
        ...(delegatePossible && delegate.reason ? [`delegate:${delegate.reason}`] : []),
      ],
      decision: withClassification(result.decision, classification),
    }
  }
  const compiled = config.actions[selected.actionId]
  const decision: RouteDecision = {
    ...result.decision,
    reason_codes: [
      ...result.decision.reason_codes,
      "entry:run_api",
      "billing:metered",
      ...(classification?.reasonCodes ?? []),
    ],
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
    projectId: workspaceId,
    workspaceRoot: selected.mode === "delegate" ? await projectRootOf(workspaceId) : null,
    // The profile the run must verify with: the one the request named when it
    // is approved, otherwise the project's only approved one. A delegate route
    // cannot exist without at least one, so an empty answer here is not
    // reachable — `acceptanceProfileAvailable` would have excluded the action.
    acceptanceProfileId:
      selected.mode === "delegate"
        ? request.acceptance_profile_id &&
          delegate.approvedProfileIds.includes(request.acceptance_profile_id)
          ? request.acceptance_profile_id
          : (delegate.approvedProfileIds[0] ?? null)
        : null,
  }
}

/**
 * A project's primary root: the checkout a delegate run reads, stages from,
 * and — only with an approval — writes into.
 *
 * Loaded dynamically for the same reason the capabilities are: a request that
 * routes to cascade or panel never touches the project store.
 */
async function projectRootOf(projectId: string | null): Promise<string | null> {
  if (!projectId) return null
  try {
    const { delegateProjectRoot } = await import("./delegate-capabilities")
    return await delegateProjectRoot(projectId)
  } catch {
    return null
  }
}
