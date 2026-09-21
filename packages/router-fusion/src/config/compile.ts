/**
 * Config compiler (DESIGN §17, CFG-01/CFG-02).
 *
 * Validates the policy, registry and per-action extensions as ONE unit, then
 * freezes an immutable snapshot a run pins for its whole life. Every failure
 * names the exact field by JSON pointer; nothing is defaulted silently — a
 * missing price is not $0, an unknown alias is not "whatever is available",
 * and a fake provider never starts in production.
 */

import {
  ActionConfigSchema,
  PolicyConfigSchema,
  RateCardSchema,
  type ActionConfig,
} from "../contracts/schemas"
import { canonicalHash } from "../util/sha256"
import {
  DELEGATE_LIMIT_CEILINGS,
  DELEGATE_MIN_MODEL_CALLS,
  OPTIONAL_ROLES,
  REQUIRED_ROLES,
  VERIFIER_PROFILES,
  type ActionExtension,
  type CompiledAction,
  type CompiledFusionConfig,
  type FusionConfigInput,
  type FusionDeployment,
  type FusionRegistry,
} from "./types"

export interface ConfigIssue {
  pointer: string
  message: string
}

export class ConfigCompileError extends Error {
  readonly code = "CONFIG_INVALID"
  constructor(readonly issues: ConfigIssue[]) {
    super(
      `router-fusion config is invalid:\n${issues.map((i) => `  ${i.pointer}: ${i.message}`).join("\n")}`
    )
    this.name = "ConfigCompileError"
  }
}

function pointer(...segments: Array<string | number>): string {
  return `/${segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
}

function zodIssues(
  prefix: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
): ConfigIssue[] {
  return issues.map((issue) => ({
    pointer: `${prefix}${issue.path.length ? pointer(...issue.path.map((p) => String(p))) : ""}`,
    message: issue.message,
  }))
}

function validateDeployment(
  deployment: FusionDeployment,
  index: number,
  issues: ConfigIssue[]
): void {
  const at = (field: string) => pointer("registry", "deployments", index, field)
  if (!deployment.id) issues.push({ pointer: at("id"), message: "deployment id is required" })
  if (!Number.isSafeInteger(deployment.contextLimit) || deployment.contextLimit < 1) {
    issues.push({ pointer: at("contextLimit"), message: "must be a positive integer" })
  }
  if (!Number.isSafeInteger(deployment.maxOutputTokens) || deployment.maxOutputTokens < 1) {
    issues.push({ pointer: at("maxOutputTokens"), message: "must be a positive integer" })
  }
  if (deployment.dataClasses.length === 0) {
    issues.push({
      pointer: at("dataClasses"),
      message: "a deployment must declare at least one data class",
    })
  }
  if (!Number.isFinite(deployment.p95LatencyMs) || deployment.p95LatencyMs < 0) {
    issues.push({ pointer: at("p95LatencyMs"), message: "must be a non-negative number" })
  }
}

function validateRegistry(
  registry: FusionRegistry,
  issues: ConfigIssue[]
): Record<string, FusionDeployment> {
  const byId: Record<string, FusionDeployment> = {}
  registry.deployments.forEach((deployment, index) => {
    validateDeployment(deployment, index, issues)
    if (byId[deployment.id]) {
      issues.push({
        pointer: pointer("registry", "deployments", index, "id"),
        message: `duplicate deployment id ${deployment.id}`,
      })
    }
    byId[deployment.id] = deployment
  })

  const cardIds = new Set<string>()
  registry.rate_cards.forEach((card, index) => {
    const parsed = RateCardSchema.safeParse(card)
    if (!parsed.success)
      issues.push(...zodIssues(pointer("registry", "rate_cards", index), parsed.error.issues))
    if (cardIds.has(card.id)) {
      issues.push({
        pointer: pointer("registry", "rate_cards", index, "id"),
        message: `duplicate rate card ${card.id}`,
      })
    }
    cardIds.add(card.id)
  })

  registry.deployments.forEach((deployment, index) => {
    if (deployment.rateCardId !== null && !cardIds.has(deployment.rateCardId)) {
      issues.push({
        pointer: pointer("registry", "deployments", index, "rateCardId"),
        message: `rate card ${deployment.rateCardId} does not exist`,
      })
    }
  })

  for (const [alias, ids] of Object.entries(registry.aliases)) {
    if (ids.length === 0) {
      issues.push({
        pointer: pointer("registry", "aliases", alias),
        message: "alias resolves to no deployment",
      })
    }
    ids.forEach((id, index) => {
      if (!byId[id]) {
        issues.push({
          pointer: pointer("registry", "aliases", alias, index),
          message: `deployment ${id} does not exist`,
        })
      }
    })
  }
  return byId
}

function validateExtension(
  actionId: string,
  extension: ActionExtension | undefined,
  issues: ConfigIssue[],
  mode?: ActionConfig["mode"]
): void {
  const at = (...rest: Array<string | number>) => pointer("extensions", actionId, ...rest)
  if (!extension) {
    issues.push({ pointer: at(), message: "every action needs its limits and run cap" })
    return
  }
  const limits = extension.limits
  const positive = [
    "max_model_calls",
    "transport_attempts_per_call",
    "panel_size",
    "panel_min_candidates",
    "worker_model_turns",
    "worker_tool_operations",
  ] as const
  for (const key of positive) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      issues.push({ pointer: at("limits", key), message: "must be a positive integer" })
  }
  for (const key of [
    "max_format_repairs",
    "max_reroutes",
    "panel_evidence_rounds",
    "worker_repair_rounds",
    "lead_takeovers",
  ] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0)
      issues.push({ pointer: at("limits", key), message: "must be a non-negative integer" })
  }
  if (limits.deadline_ms < 1000 || limits.deadline_ms > 3_600_000) {
    issues.push({
      pointer: at("limits", "deadline_ms"),
      message: "must be within 1000..3600000 ms",
    })
  }
  if (limits.panel_size > 3)
    issues.push({ pointer: at("limits", "panel_size"), message: "at most 3 panel members" })
  if (limits.panel_min_candidates > limits.panel_size) {
    issues.push({
      pointer: at("limits", "panel_min_candidates"),
      message: "cannot exceed panel_size",
    })
  }
  for (const key of ["panel_evidence_rounds", "worker_repair_rounds", "lead_takeovers"] as const) {
    if (limits[key] > 1) issues.push({ pointer: at("limits", key), message: "V1 allows at most 1" })
  }
  // The delegate graph's worker bounds (B4). Every mode carries them, so every
  // mode is held to the same ceiling; only delegate spends them.
  for (const key of ["worker_model_turns", "worker_tool_operations"] as const) {
    const ceiling = DELEGATE_LIMIT_CEILINGS[key]
    if (limits[key] > ceiling)
      issues.push({ pointer: at("limits", key), message: `V1 allows at most ${ceiling}` })
  }
  if (limits.delegate_subtasks !== undefined) {
    const ceiling = DELEGATE_LIMIT_CEILINGS.delegate_subtasks
    if (!Number.isSafeInteger(limits.delegate_subtasks) || limits.delegate_subtasks < 1) {
      issues.push({
        pointer: at("limits", "delegate_subtasks"),
        message: "must be a positive integer",
      })
    } else if (limits.delegate_subtasks > ceiling) {
      issues.push({
        pointer: at("limits", "delegate_subtasks"),
        message: `V1 allows at most ${ceiling}`,
      })
    }
  } else if (mode === "delegate") {
    issues.push({
      pointer: at("limits", "delegate_subtasks"),
      message: "a delegate action must say how many subtasks its lead may plan",
    })
  }
  if (mode === "delegate" && limits.max_model_calls < DELEGATE_MIN_MODEL_CALLS) {
    issues.push({
      pointer: at("limits", "max_model_calls"),
      message: `a delegate run needs at least ${DELEGATE_MIN_MODEL_CALLS} model calls: its plan and one worker turn`,
    })
  }
  if (!Number.isSafeInteger(extension.run_cap_microusd) || extension.run_cap_microusd < 0) {
    issues.push({
      pointer: at("run_cap_microusd"),
      message: "must be a non-negative integer microusd",
    })
  }
  if (!Number.isSafeInteger(extension.role_output_tokens) || extension.role_output_tokens < 1) {
    issues.push({ pointer: at("role_output_tokens"), message: "must be a positive integer" })
  }
}

function validateAction(
  action: ActionConfig,
  index: number,
  registry: FusionRegistry,
  extension: ActionExtension | undefined,
  issues: ConfigIssue[]
): void {
  const at = (...rest: Array<string | number>) => pointer("policy", "actions", index, ...rest)
  const parsed = ActionConfigSchema.safeParse(action)
  if (!parsed.success) {
    issues.push(...zodIssues(at(), parsed.error.issues))
    return
  }
  const allowed = new Set<string>([...REQUIRED_ROLES[action.mode], ...OPTIONAL_ROLES[action.mode]])
  for (const role of REQUIRED_ROLES[action.mode]) {
    if (!(role in action.roles))
      issues.push({ pointer: at("roles", role), message: `${action.mode} requires a ${role} role` })
  }
  for (const [role, alias] of Object.entries(action.roles)) {
    if (!allowed.has(role)) {
      issues.push({
        pointer: at("roles", role),
        message: `${role} is not a role of ${action.mode}`,
      })
      continue
    }
    if (!registry.aliases[alias]) {
      issues.push({
        pointer: at("roles", role),
        message: `alias ${alias} does not exist in the registry`,
      })
    }
  }
  if (
    action.mode === "panel" &&
    extension &&
    extension.limits.panel_size === 3 &&
    !("panel_c" in action.roles)
  ) {
    issues.push({
      pointer: at("roles", "panel_c"),
      message: "panel_size 3 requires a panel_c role",
    })
  }
  if (!(VERIFIER_PROFILES as readonly string[]).includes(action.verifier_profile)) {
    issues.push({
      pointer: at("verifier_profile"),
      message: `unknown verifier profile ${action.verifier_profile}`,
    })
  }
  const codeModes = action.mode === "delegate"
  if (codeModes && action.verifier_profile !== "code_fixture") {
    issues.push({
      pointer: at("verifier_profile"),
      message: "delegate actions must verify with code_fixture",
    })
  }
}

/** Everything that can change what an action produces, hashed canonically. */
export function computeActionHash(
  action: ActionConfig,
  extension: ActionExtension,
  registry: FusionRegistry,
  deploymentsById: Record<string, FusionDeployment>
): string {
  const roles = Object.fromEntries(
    Object.entries(action.roles)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([role, alias]) => [
        role,
        {
          alias,
          deployments: (registry.aliases[alias] ?? []).map((id) => ({
            id,
            revision: deploymentsById[id]?.modelRevision ?? null,
            rateCardId: deploymentsById[id]?.rateCardId ?? null,
          })),
        },
      ])
  )
  return canonicalHash({
    id: action.id,
    mode: action.mode,
    roles,
    prompt_version: action.prompt_version,
    verifier_profile: action.verifier_profile,
    extension,
  })
}

export function compileFusionConfig(rawInput: FusionConfigInput): CompiledFusionConfig {
  // The snapshot is frozen; clone first so the caller's objects stay mutable.
  const input = structuredClone(rawInput)
  const issues: ConfigIssue[] = []
  const policyParse = PolicyConfigSchema.safeParse(input.policy)
  if (!policyParse.success) issues.push(...zodIssues("/policy", policyParse.error.issues))

  const deploymentsById = validateRegistry(input.registry, issues)

  if (input.environment === "production") {
    if (input.policy.example_only)
      issues.push({
        pointer: "/policy/example_only",
        message: "example policy refused in production",
      })
    if (input.registry.example_only)
      issues.push({
        pointer: "/registry/example_only",
        message: "example registry refused in production",
      })
    input.registry.deployments.forEach((deployment, index) => {
      if (deployment.exampleOnly || deployment.providerId === "fake") {
        issues.push({
          pointer: pointer("registry", "deployments", index),
          message: `fake/example deployment ${deployment.id} refused in production`,
        })
      }
    })
    input.registry.rate_cards.forEach((card, index) => {
      if (card.example_only) {
        issues.push({
          pointer: pointer("registry", "rate_cards", index, "example_only"),
          message: `example rate card ${card.id} refused in production`,
        })
      }
    })
  }

  const seen = new Set<string>()
  const actions: Record<string, CompiledAction> = {}
  input.policy.actions?.forEach((action, index) => {
    if (seen.has(action.id))
      issues.push({
        pointer: pointer("policy", "actions", index, "id"),
        message: `duplicate action ${action.id}`,
      })
    seen.add(action.id)
    const extension = input.extensions[action.id]
    validateExtension(action.id, extension, issues, action.mode)
    validateAction(action, index, input.registry, extension, issues)
  })

  for (const actionId of Object.keys(input.extensions)) {
    if (!seen.has(actionId))
      issues.push({
        pointer: pointer("extensions", actionId),
        message: "extension for an action that does not exist",
      })
  }

  if (issues.length > 0) throw new ConfigCompileError(issues)

  for (const action of input.policy.actions) {
    const extension = input.extensions[action.id]
    actions[action.id] = {
      config: action,
      extension,
      actionHash: computeActionHash(action, extension, input.registry, deploymentsById),
    }
  }

  const rateCardsById = Object.fromEntries(input.registry.rate_cards.map((card) => [card.id, card]))
  const digest = canonicalHash({
    policy: input.policy,
    registry: input.registry,
    extensions: input.extensions,
    environment: input.environment,
  })
  return deepFreeze({
    policy: input.policy,
    registry: input.registry,
    actions,
    deploymentsById,
    rateCardsById,
    environment: input.environment,
    digest,
  })
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
    Object.freeze(value)
  }
  return value
}
