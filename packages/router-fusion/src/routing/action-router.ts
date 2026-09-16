/**
 * ActionRouter (DESIGN §6, ADR-0188 D10/D11).
 *
 *   features → classify → enumerate actions → hard filter H → quality
 *   → total cost / latency → select (stable rule order) → RouteDecision
 *
 * Every enabled action is assessed and appears in the decision with its real
 * exclusion reasons, versions and estimates (ROUTE-06); nothing is explained
 * after the fact. In rule mode no candidate carries a success probability
 * (`p_pass = null`, ROUTE-01). Auto only picks the conservative baseline unless
 * the user approved a rule row for that slice (D11). When no action satisfies
 * data scope, capabilities and budget together, the decision says so plainly
 * instead of relaxing a requirement (ROUTE-08).
 */

import {
  CONTRACT_SCHEMA_VERSION,
  type ActionConfig,
  type CandidateAssessment,
  type ExecutionMode,
  type QualityEstimate,
  type RouteDecision,
  type RoutingFeatures,
} from "../contracts/schemas"
import { BASELINE_ACTION_ID } from "../config/builtin-catalog"
import type {
  CompiledAction,
  CompiledFusionConfig,
  DeploymentHealth,
  FusionDeployment,
  InputModality,
  RoleName,
  VerifierProfile,
} from "../config/types"
import type { Microusd } from "../money/microusd"
import { PROFILES, actionSatisfiesProfile, resolveAcceptanceProfile } from "../verify/profiles"
import {
  deploymentExclusions as deploymentExclusionsFor,
  selectDeploymentInAliasOrder,
  type DataPolicyView,
  type DeploymentExclusion,
  type DeploymentFilterContext,
  type DeploymentSelector,
  type RoleRequirements,
} from "./deployment-filter"
import {
  estimateAction,
  expectedForCall,
  type ActionEstimate,
  type EstimateContext,
} from "./estimate"

export const RULE_ROWS = [
  "economy_simple",
  "cascade_verifiable",
  "panel_research",
  "delegate_multifile",
] as const
export type RuleRowId = (typeof RULE_ROWS)[number]

export const DEFAULT_RULE_ROW_ACTIONS: Record<RuleRowId, string[]> = {
  economy_simple: ["direct_economy"],
  cascade_verifiable: ["cascade_schema", "cascade_code"],
  panel_research: ["panel_review"],
  delegate_multifile: ["delegate_code"],
}

export type RuleId =
  | "R0_needs_input"
  | "R1_explicit_action"
  | "R1_explicit_mode"
  | "R2_economy_simple"
  | "R3_cascade_verifiable"
  | "R4_panel_research"
  | "R5_delegate_multifile"
  | "R6_baseline"

export interface QualityEvidence {
  /** Grouped pass rate of this action on the matching slice from an offline eval. */
  groupPassRate: number
  supportCount: number
}

export interface QualityPredictor {
  version: string
  predict(features: RoutingFeatures, actionId: string, actionHash: string): QualityEstimate | null
}

export interface HostCapabilities {
  /** Strongest sandbox tier reachable for delegate work, or null. */
  sandboxTier: string | null
  /** A trusted acceptance profile (command + report) exists for the workspace. */
  acceptanceProfileAvailable: boolean
  verifierProfiles: VerifierProfile[]
  webToolsAvailable: boolean
}

export interface RouteRequest {
  runId: string
  decisionId: string
  createdAt: string
  requestedMode: "auto" | ExecutionMode
  /** A specific action chosen by the user or caller; must belong to `allowedModes`. */
  requestedActionId?: string
  allowedModes: ExecutionMode[]
  profile: "economy" | "balanced" | "quality"
  requestedAcceptanceProfile?: string
  deliversChange: boolean
  budgetMode: "strict" | "tracked"
  runAvailableMicrousd: Microusd
  deadlineRemainingMs: number
  dataPolicy: DataPolicyView
  inputModalities: InputModality[]
  estimatedInputTokens: number
  features: RoutingFeatures
  classifierVersion: string
  approvedRuleRows: RuleRowId[]
  ruleRowActions?: Partial<Record<RuleRowId, string[]>>
  health: Record<string, DeploymentHealth>
  capabilities: HostCapabilities
  /** The run is a descendant of a fusion run; recursion is refused (INV-09). */
  hasFusionAncestor: boolean
  /** Deployment the session used per alias last turn. */
  affinity?: Record<string, string>
  /**
   * A concrete deployment the user pinned for a role (a manual model pick).
   * It is a hard override: still hard-filtered, never silently replaced.
   */
  roleDeploymentOverrides?: Partial<Record<RoleName, string>>
  evalEvidence?: Record<string, QualityEvidence>
  predictor?: QualityPredictor
  unknownPriceCallReserveMicrousd: Microusd
  expectedOutputTokens?: number
}

export type ActionExclusion =
  | "ACTION_DISABLED"
  | "MODE_NOT_ALLOWED"
  | "MODE_NOT_REQUESTED"
  | "ACTION_NOT_REQUESTED"
  | "RULE_NOT_MATCHED"
  | "RULE_ROW_NOT_APPROVED"
  | "FUSION_RECURSION"
  | "SANDBOX_UNAVAILABLE"
  | "ACCEPTANCE_PROFILE_MISSING"
  | "VERIFIER_UNAVAILABLE"
  | "PROFILE_BELOW_TASK_MINIMUM"
  | "PANEL_SAME_REVISION"
  | "BUDGET_EXCEEDS_RUN_AVAILABLE"
  | "DEADLINE_EXCEEDED"
  | `ROLE_UNRESOLVABLE:${string}`

export interface CandidateDetail {
  actionId: string
  actionHash: string
  mode: ExecutionMode
  ruleId: RuleId | null
  roles: Partial<Record<RoleName, string>>
  rejectedDeployments: Array<{ role: string; deploymentId: string; reasons: DeploymentExclusion[] }>
  estimate: ActionEstimate | null
  affinityKept: boolean
}

export interface ActionRouteResult {
  decision: RouteDecision
  selected: CandidateDetail | null
  details: CandidateDetail[]
  ruleId: RuleId | null
  /** Set when the run must pause for input instead of guessing. */
  needsInput: boolean
  /** Acceptance profile the selected action must satisfy. */
  acceptanceProfile: VerifierProfile | null
  acceptanceProfileRaised: boolean
}

function roleNeeds(
  role: RoleName,
  mode: ExecutionMode,
  features: RoutingFeatures,
  webTools: boolean
): { tools: boolean; jsonSchema: boolean; readsInput: boolean } {
  switch (role) {
    case "solver":
      return {
        tools: features.tool_need !== "none" && features.tool_need !== "unknown",
        jsonSchema: false,
        readsInput: true,
      }
    case "cheap":
    case "strong":
      return { tools: false, jsonSchema: true, readsInput: true }
    case "panel_a":
    case "panel_b":
    case "panel_c":
      return { tools: webTools, jsonSchema: true, readsInput: true }
    case "judge":
      return { tools: false, jsonSchema: true, readsInput: false }
    case "synthesizer":
    case "reviewer":
      return { tools: false, jsonSchema: mode !== "direct", readsInput: false }
    case "lead":
      return { tools: false, jsonSchema: true, readsInput: true }
    case "worker":
      return { tools: true, jsonSchema: true, readsInput: false }
  }
}

function qualityFor(action: CompiledAction, request: RouteRequest): QualityEstimate {
  const predicted = request.predictor?.predict(
    request.features,
    action.config.id,
    action.actionHash
  )
  if (predicted && predicted.source === "model" && predicted.p_pass !== null) return predicted
  const evidence = request.evalEvidence?.[action.actionHash]
  if (evidence) {
    return {
      action_id: action.config.id,
      p_pass: null,
      group_pass_rate: evidence.groupPassRate,
      source: "eval",
      support_count: evidence.supportCount,
      in_distribution: true,
      predictor_version: null,
    }
  }
  return {
    action_id: action.config.id,
    p_pass: null,
    group_pass_rate: null,
    source: "rule",
    support_count: 0,
    in_distribution: false,
    predictor_version: null,
  }
}

function matchesRuleRow(row: RuleRowId, features: RoutingFeatures, request: RouteRequest): boolean {
  switch (row) {
    case "economy_simple":
      return (
        (features.task === "text.transform" || features.task === "data.extract") &&
        (features.ambiguity === "low" || features.ambiguity === "medium") &&
        !features.context_truncated
      )
    case "cascade_verifiable":
      return features.verification_kinds.some(
        (kind) => kind === "schema" || kind === "json_schema" || kind === "code_test"
      )
    case "panel_research":
      return features.task === "research.synthesis"
    case "delegate_multifile":
      return (
        (features.task === "code.implement" || features.task === "code.debug") &&
        features.scope === "multi_file" &&
        request.capabilities.sandboxTier !== null &&
        request.capabilities.acceptanceProfileAvailable
      )
  }
}

const RULE_FOR_ROW: Record<RuleRowId, RuleId> = {
  economy_simple: "R2_economy_simple",
  cascade_verifiable: "R3_cascade_verifiable",
  panel_research: "R4_panel_research",
  delegate_multifile: "R5_delegate_multifile",
}

function explicitModeOrder(
  actions: CompiledAction[],
  profile: RouteRequest["profile"]
): CompiledAction[] {
  const economyFirst = profile === "economy"
  return [...actions].sort((a, b) => {
    const aEco = a.config.id.includes("economy") ? 0 : 1
    const bEco = b.config.id.includes("economy") ? 0 : 1
    return economyFirst ? aEco - bEco : bEco - aEco
  })
}

export function routeAction(
  config: CompiledFusionConfig,
  request: RouteRequest,
  selector: DeploymentSelector = selectDeploymentInAliasOrder
): ActionRouteResult {
  const filterContext: DeploymentFilterContext = {
    config,
    budgetMode: request.budgetMode,
    health: request.health,
    policy: request.dataPolicy,
  }
  const estimateContext: EstimateContext = {
    rateCardsById: config.rateCardsById,
    unknownPriceCallReserveMicrousd: request.unknownPriceCallReserveMicrousd,
    expectedOutputTokens: request.expectedOutputTokens ?? 1024,
  }
  const actions = config.policy.actions.map((action) => config.actions[action.id])
  const details: CandidateDetail[] = []
  const assessments: CandidateAssessment[] = []
  const reasonCodes: string[] = [
    `classifier:${request.classifierVersion}`,
    `budget:${request.budgetMode}`,
  ]

  const needsInput = request.features.missing_information.length > 0
  const ruleRowActions = { ...DEFAULT_RULE_ROW_ACTIONS, ...request.ruleRowActions }
  const approved = new Set(request.approvedRuleRows)

  // Which rule, if any, proposes each action (stable order).
  const proposal = new Map<string, RuleId>()
  let preferenceOrder: string[] = []
  if (request.requestedActionId) {
    proposal.set(request.requestedActionId, "R1_explicit_action")
    preferenceOrder = [request.requestedActionId]
  } else if (request.requestedMode !== "auto") {
    const ofMode = explicitModeOrder(
      actions.filter((a) => a.config.mode === request.requestedMode),
      request.profile
    )
    for (const action of ofMode) proposal.set(action.config.id, "R1_explicit_mode")
    preferenceOrder = ofMode.map((a) => a.config.id)
  } else {
    for (const row of RULE_ROWS) {
      if (!matchesRuleRow(row, request.features, request)) continue
      for (const actionId of ruleRowActions[row] ?? []) {
        if (!proposal.has(actionId)) proposal.set(actionId, RULE_FOR_ROW[row])
        preferenceOrder.push(actionId)
      }
    }
    if (!proposal.has(BASELINE_ACTION_ID)) proposal.set(BASELINE_ACTION_ID, "R6_baseline")
    preferenceOrder.push(BASELINE_ACTION_ID)
  }

  const eligibleIds = new Set<string>()
  for (const action of actions) {
    const { config: cfg, extension } = action
    const exclusions: string[] = []
    const ruleId = proposal.get(cfg.id) ?? null
    if (!cfg.enabled) exclusions.push("ACTION_DISABLED")
    if (!request.allowedModes.includes(cfg.mode)) exclusions.push("MODE_NOT_ALLOWED")
    if (request.requestedActionId && request.requestedActionId !== cfg.id)
      exclusions.push("ACTION_NOT_REQUESTED")
    else if (
      !request.requestedActionId &&
      request.requestedMode !== "auto" &&
      request.requestedMode !== cfg.mode
    ) {
      exclusions.push("MODE_NOT_REQUESTED")
    }
    if (request.requestedMode === "auto" && !request.requestedActionId) {
      if (ruleId === null) exclusions.push("RULE_NOT_MATCHED")
      else if (ruleId !== "R6_baseline") {
        const row = (Object.keys(RULE_FOR_ROW) as RuleRowId[]).find(
          (r) => RULE_FOR_ROW[r] === ruleId
        )
        if (row && !approved.has(row)) exclusions.push("RULE_ROW_NOT_APPROVED")
      }
    }
    if (request.hasFusionAncestor && cfg.mode !== "direct") exclusions.push("FUSION_RECURSION")
    if (cfg.mode === "delegate") {
      if (request.capabilities.sandboxTier === null) exclusions.push("SANDBOX_UNAVAILABLE")
      if (!request.capabilities.acceptanceProfileAvailable)
        exclusions.push("ACCEPTANCE_PROFILE_MISSING")
    }
    const actionProfile = cfg.verifier_profile as VerifierProfile
    if (!request.capabilities.verifierProfiles.includes(actionProfile))
      exclusions.push("VERIFIER_UNAVAILABLE")
    const resolution = resolveAcceptanceProfile({
      actionProfile,
      requestedProfile: request.requestedAcceptanceProfile,
      task: request.features.task,
      deliversChange: request.deliversChange,
    })
    if (!actionSatisfiesProfile(actionProfile, resolution.profile))
      exclusions.push("PROFILE_BELOW_TASK_MINIMUM")

    // Resolve every role to a deployment through the (re-checked) selector.
    const roles: Partial<Record<RoleName, FusionDeployment>> = {}
    const roleIds: Partial<Record<RoleName, string>> = {}
    const rejectedDeployments: CandidateDetail["rejectedDeployments"] = []
    let affinityKept = false
    const webTools =
      cfg.mode === "panel" && extension.web_tools_enabled && request.capabilities.webToolsAvailable
    for (const [role, alias] of Object.entries(cfg.roles) as Array<[RoleName, string]>) {
      const needs = roleNeeds(role, cfg.mode, request.features, webTools)
      const requirements: RoleRequirements = {
        inputModalities: needs.readsInput ? request.inputModalities : ["text"],
        needsTools: needs.tools,
        needsJsonSchema: needs.jsonSchema,
        inputTokens: request.estimatedInputTokens,
        outputTokens: extension.role_output_tokens,
      }
      const pinnedId = request.roleDeploymentOverrides?.[role]
      const pinned = pinnedId ? config.deploymentsById[pinnedId] : undefined
      const selection = pinnedId
        ? { deployment: pinned ?? null, rejected: [], affinityKept: false }
        : selector({
            alias,
            role,
            requirements,
            context: filterContext,
            affinityDeploymentId: request.affinity?.[alias],
            switchMargin: config.policy.switch_margin,
            expectedCost: (deployment) =>
              expectedForCall(
                {
                  deployment,
                  inputTokens: request.estimatedInputTokens,
                  outputTokens: extension.role_output_tokens,
                },
                estimateContext
              ),
          })
      for (const rejected of selection.rejected) rejectedDeployments.push({ role, ...rejected })
      // A selector cannot bypass the filter: re-check what it returned.
      const chosen = selection.deployment
      const recheck = chosen ? deploymentExclusionsFor(chosen, requirements, filterContext) : []
      if (!chosen || recheck.length > 0) {
        if (chosen) rejectedDeployments.push({ role, deploymentId: chosen.id, reasons: recheck })
        exclusions.push(`ROLE_UNRESOLVABLE:${role}`)
        continue
      }
      roles[role] = chosen
      roleIds[role] = chosen.id
      affinityKept = affinityKept || selection.affinityKept
    }

    if (cfg.mode === "panel") {
      const members = (["panel_a", "panel_b", "panel_c"] as RoleName[])
        .map((r) => roles[r])
        .filter(Boolean) as FusionDeployment[]
      if (new Set(members.map((d) => d.modelRevision)).size < members.length)
        exclusions.push("PANEL_SAME_REVISION")
    }

    let estimate: ActionEstimate | null = null
    const unresolved = exclusions.some((e) => e.startsWith("ROLE_UNRESOLVABLE"))
    if (!unresolved) {
      estimate = estimateAction(
        {
          mode: cfg.mode,
          extension,
          roles,
          taskInputTokens: request.estimatedInputTokens,
          reviewCall:
            PROFILES[resolution.profile].needsModelCall &&
            (cfg.mode === "direct" || cfg.mode === "cascade"),
          webToolsEnabled: webTools,
        },
        estimateContext
      )
      const cap = Math.min(extension.run_cap_microusd, request.runAvailableMicrousd)
      if (estimate.reserveMicrousd > cap) exclusions.push("BUDGET_EXCEEDS_RUN_AVAILABLE")
      if (estimate.p95Ms > Math.min(request.deadlineRemainingMs, extension.limits.deadline_ms))
        exclusions.push("DEADLINE_EXCEEDED")
    }

    const detail: CandidateDetail = {
      actionId: cfg.id,
      actionHash: action.actionHash,
      mode: cfg.mode,
      ruleId,
      roles: roleIds,
      rejectedDeployments,
      estimate,
      affinityKept,
    }
    details.push(detail)
    const eligible = exclusions.length === 0
    if (eligible) eligibleIds.add(cfg.id)
    assessments.push({
      action_id: cfg.id,
      eligible,
      exclusion_reasons: dedupe([
        ...exclusions,
        ...rejectedDeployments.flatMap((r) =>
          r.reasons.map((reason) => `${r.role}:${r.deploymentId}:${reason}`)
        ),
      ]),
      quality: qualityFor(action, request),
      expected_cost_microusd: estimate?.expectedMicrousd ?? 0,
      reserve_cost_microusd: estimate?.reserveMicrousd ?? 0,
      estimated_p95_ms: Math.round(estimate?.p95Ms ?? 0),
    })
  }

  let selected: CandidateDetail | null = null
  let ruleId: RuleId | null = null
  if (needsInput) {
    ruleId = "R0_needs_input"
    reasonCodes.push("rule:R0_needs_input", "NEEDS_INPUT")
  } else {
    for (const actionId of preferenceOrder) {
      if (!eligibleIds.has(actionId)) continue
      selected = details.find((d) => d.actionId === actionId) ?? null
      ruleId = proposal.get(actionId) ?? null
      break
    }
    if (selected && ruleId) {
      reasonCodes.push(`rule:${ruleId}`)
      if (selected.affinityKept) reasonCodes.push("affinity:kept")
      if (selected.estimate && !selected.estimate.priceKnown) reasonCodes.push("price:estimated")
    } else {
      reasonCodes.push("NO_ELIGIBLE_ACTION")
    }
  }

  const selectedConfig: ActionConfig | undefined = selected
    ? config.actions[selected.actionId].config
    : undefined
  const resolution = selectedConfig
    ? resolveAcceptanceProfile({
        actionProfile: selectedConfig.verifier_profile as VerifierProfile,
        requestedProfile: request.requestedAcceptanceProfile,
        task: request.features.task,
        deliversChange: request.deliversChange,
      })
    : null
  if (resolution?.raisedToMinimum) reasonCodes.push("acceptance:raised_to_minimum")

  const decision: RouteDecision = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    decision_id: request.decisionId,
    run_id: request.runId,
    selected_action_id: selected?.actionId ?? null,
    mode_selected: selected?.mode ?? null,
    candidates: assessments,
    reason_codes: reasonCodes,
    policy_version: config.policy.policy_version,
    registry_version: config.registry.registry_version,
    prompt_version:
      selectedConfig?.prompt_version ?? config.policy.actions[0]?.prompt_version ?? "none",
    classifier_version: request.classifierVersion,
    degraded: false,
    created_at: request.createdAt,
  }
  return {
    decision,
    selected,
    details,
    ruleId,
    needsInput,
    acceptanceProfile: resolution?.profile ?? null,
    acceptanceProfileRaised: resolution?.raisedToMinimum ?? false,
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
