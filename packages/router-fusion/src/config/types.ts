/**
 * Router + Fusion configuration model.
 *
 * The spec's `PolicyConfig` / `ActionConfig` / `RateCard` contracts are kept
 * verbatim. Cognia adds what a desktop host needs on top of them — per-action
 * limits and run caps (ADR-0188 D22/D29), deployments that describe any
 * provider the app can reach rather than the spec's three, and the facts the
 * hard filter needs (billing transparency, hidden retries, data classes).
 */

import type {
  ActionConfig,
  DataClass,
  ExecutionMode,
  PolicyConfig,
  RateCard,
} from "../contracts/schemas"
import type { Microusd } from "../money/microusd"
import type { PerCallPrices } from "../usage/normalize"

export type DeploymentHealth = "healthy" | "degraded" | "unavailable"

/** How a deployment's adapter treats transport retries it performs on its own. */
export type InternalRetryBehaviour = "none" | "observable" | "hidden"

/**
 * `bounded`: the worst-case bill of one call is computable before dispatch.
 * `estimated`: only a conservative estimate is possible (subscription quotas,
 * an SDK that loops internally). Strict budgets exclude `estimated`.
 */
export type BillingTransparency = "bounded" | "estimated"

export type InputModality = "text" | "image"

export interface FusionDeployment {
  /** Stable id, `providerId:modelId` for app providers. */
  id: string
  providerId: string
  modelRevision: string
  /** Where the data ends up; aggregators that cannot prove it must not accept restricted data. */
  dataClasses: DataClass[]
  inputModalities: InputModality[]
  contextLimit: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsJsonSchema: boolean
  usageLookup: boolean
  providerIdempotency: boolean
  cacheMode: "none" | "automatic" | "explicit"
  /** Null when no audited price exists — allowed only in tracked budgets. */
  rateCardId: string | null
  internalRetry: InternalRetryBehaviour
  billingTransparency: BillingTransparency
  enabled: boolean
  /** Fake/demo deployments; refused when compiling for production. */
  exampleOnly: boolean
  /** Typical latency for the latency estimate (ms, P95). */
  p95LatencyMs: number
}

export interface FusionRegistry {
  registry_version: string
  example_only: boolean
  deployments: FusionDeployment[]
  /** Alias → deployment ids in the host's preference order. */
  aliases: Record<string, string[]>
  rate_cards: RateCard[]
  per_call_prices?: Record<string, PerCallPrices>
}

export interface ActionLimits {
  max_model_calls: number
  deadline_ms: number
  transport_attempts_per_call: number
  max_format_repairs: number
  max_reroutes: number
  panel_size: number
  panel_min_candidates: number
  panel_evidence_rounds: number
  worker_model_turns: number
  worker_tool_operations: number
  worker_repair_rounds: number
  lead_takeovers: number
}

/** Cognia's per-action settings beside the spec's `ActionConfig`. */
export interface ActionExtension {
  limits: ActionLimits
  run_cap_microusd: Microusd
  /** Panel/cascade read-only web tools (D26); ignored for other modes. */
  web_tools_enabled: boolean
  /** Maximum output tokens reserved per role call. */
  role_output_tokens: number
}

export type RoleName =
  | "solver"
  | "reviewer"
  | "cheap"
  | "strong"
  | "panel_a"
  | "panel_b"
  | "panel_c"
  | "judge"
  | "synthesizer"
  | "lead"
  | "worker"

export const REQUIRED_ROLES: Record<ExecutionMode, readonly RoleName[]> = {
  direct: ["solver"],
  cascade: ["cheap", "strong"],
  panel: ["panel_a", "panel_b", "judge", "synthesizer"],
  delegate: ["lead", "worker"],
}

export const OPTIONAL_ROLES: Record<ExecutionMode, readonly RoleName[]> = {
  direct: ["reviewer"],
  cascade: ["reviewer"],
  panel: ["panel_c"],
  delegate: ["reviewer"],
}

export const VERIFIER_PROFILES = [
  "text_basic",
  "text_review",
  "schema_fixture",
  "evidence_review",
  "code_fixture",
] as const
export type VerifierProfile = (typeof VERIFIER_PROFILES)[number]

export type RuntimeEnvironment = "production" | "development" | "test"

export interface FusionConfigInput {
  policy: PolicyConfig
  registry: FusionRegistry
  extensions: Record<string, ActionExtension>
  environment: RuntimeEnvironment
}

export interface CompiledAction {
  config: ActionConfig
  extension: ActionExtension
  /** sha256 over everything that can change the action's outcome (ROUTE-05). */
  actionHash: string
}

export interface CompiledFusionConfig {
  policy: PolicyConfig
  registry: FusionRegistry
  actions: Record<string, CompiledAction>
  deploymentsById: Record<string, FusionDeployment>
  rateCardsById: Record<string, RateCard>
  environment: RuntimeEnvironment
  /** sha256 of the whole compiled snapshot; a run pins it for its lifetime. */
  digest: string
}
