/**
 * The built-in action catalog (ADR-0188 D17, plus `cascade_review` from B3) and its per-mode defaults
 * (D22 run caps, D29 limits). Everything here is a default the user can edit;
 * editing produces a new `action_hash`, so no quality estimate carries over.
 *
 * Role aliases name the host's routing tiers (`fast`, `balanced`, `powerful`)
 * through the spec's three role classes: economy → fast, baseline → powerful,
 * independent → balanced. The panel's hard filter additionally refuses two
 * candidates on the same model revision, so "independent" is enforced, not
 * assumed.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  type ActionConfig,
  type ExecutionMode,
  type PolicyConfig,
} from "../contracts/schemas"
import { usdToMicrousd } from "../money/microusd"
import { ROLE_PROMPT_VERSION } from "../prompts/roles"
import { DELEGATE_LIMIT_CEILINGS, type ActionExtension, type ActionLimits } from "./types"

/** The role prompts' version: part of every action hash, so a prompt change re-hashes every action (ROUTE-05). */
export const BUILTIN_PROMPT_VERSION = ROLE_PROMPT_VERSION
export const BUILTIN_POLICY_VERSION = "cognia-policy-1"

export const ROLE_CLASS_ALIASES = {
  economy: "fast",
  baseline: "powerful",
  independent: "balanced",
} as const

const SPEC_LIMITS = {
  transport_attempts_per_call: 2,
  max_format_repairs: 1,
  max_reroutes: 2,
  panel_size: 2,
  panel_min_candidates: 2,
  panel_evidence_rounds: 1,
  // The delegate graph's bounds sit at their V1 ceilings: ≤ 8 worker turns,
  // ≤ 12 tool operations, one repair round, one lead takeover (B4).
  worker_model_turns: DELEGATE_LIMIT_CEILINGS.worker_model_turns,
  worker_tool_operations: DELEGATE_LIMIT_CEILINGS.worker_tool_operations,
  worker_repair_rounds: DELEGATE_LIMIT_CEILINGS.worker_repair_rounds,
  lead_takeovers: DELEGATE_LIMIT_CEILINGS.lead_takeovers,
} as const

export const DEFAULT_LIMITS_BY_MODE: Record<ExecutionMode, ActionLimits> = {
  // Ordinary chat keeps its agentic budget (aiSdkMaxSteps default 256) and the
  // spec's maximum deadline; the idle watchdog stays in force beside it.
  direct: { ...SPEC_LIMITS, max_model_calls: 256, deadline_ms: 3_600_000 },
  cascade: { ...SPEC_LIMITS, max_model_calls: 24, deadline_ms: 120_000 },
  panel: { ...SPEC_LIMITS, max_model_calls: 24, deadline_ms: 120_000 },
  delegate: {
    ...SPEC_LIMITS,
    max_model_calls: 24,
    deadline_ms: 900_000,
    // Only delegate plans subtasks, so only delegate carries the bound.
    delegate_subtasks: DELEGATE_LIMIT_CEILINGS.delegate_subtasks,
  },
}

export const DEFAULT_RUN_CAP_USD_BY_MODE: Record<ExecutionMode, string> = {
  direct: "0.50",
  cascade: "1.00",
  panel: "2.00",
  delegate: "5.00",
}

export const DEFAULT_ROLE_OUTPUT_TOKENS = 8192

export function defaultExtension(mode: ExecutionMode): ActionExtension {
  return {
    limits: { ...DEFAULT_LIMITS_BY_MODE[mode] },
    run_cap_microusd: usdToMicrousd(DEFAULT_RUN_CAP_USD_BY_MODE[mode]),
    web_tools_enabled: mode === "panel",
    role_output_tokens: DEFAULT_ROLE_OUTPUT_TOKENS,
  }
}

const { economy, baseline, independent } = ROLE_CLASS_ALIASES

export const BUILTIN_ACTIONS: readonly ActionConfig[] = [
  {
    id: "direct_baseline",
    mode: "direct",
    roles: { solver: baseline },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "text_basic",
    enabled: true,
  },
  {
    id: "direct_economy",
    mode: "direct",
    roles: { solver: economy },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "text_basic",
    enabled: true,
  },
  {
    id: "cascade_schema",
    mode: "cascade",
    roles: { cheap: economy, strong: baseline },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "schema_fixture",
    enabled: true,
  },
  {
    id: "cascade_code",
    mode: "cascade",
    roles: { cheap: economy, strong: baseline },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "code_fixture",
    enabled: true,
  },
  {
    id: "panel_review",
    mode: "panel",
    roles: { panel_a: economy, panel_b: independent, judge: baseline, synthesizer: baseline },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "evidence_review",
    enabled: true,
  },
  {
    id: "delegate_code",
    mode: "delegate",
    roles: { lead: baseline, worker: economy },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "code_fixture",
    enabled: true,
  },
  // B3: a cascade for text no schema can check (a chat turn). A reviewer model
  // — the strong deployment unless a reviewer role is set — judges the cheap
  // draft. Last, so an explicit cascade that carries a schema is still checked
  // against it by `cascade_schema` first.
  {
    id: "cascade_review",
    mode: "cascade",
    roles: { cheap: economy, strong: baseline },
    prompt_version: BUILTIN_PROMPT_VERSION,
    verifier_profile: "text_review",
    enabled: true,
  },
]

export const BASELINE_ACTION_ID = "direct_baseline"

export function builtinExtensions(): Record<string, ActionExtension> {
  return Object.fromEntries(
    BUILTIN_ACTIONS.map((action) => [action.id, defaultExtension(action.mode)])
  )
}

/** The shipped policy: rules classifier, baseline-only auto (D11), spec limits as the global ceiling. */
export function builtinPolicy(actions: readonly ActionConfig[] = BUILTIN_ACTIONS): PolicyConfig {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    policy_version: BUILTIN_POLICY_VERSION,
    example_only: false,
    production_auto_baseline_only: true,
    classifier: {
      implementation: "rules",
      version: "rules-1",
      input_token_cap: 4096,
      timeout_ms: 1500,
      cache_ttl_seconds: 600,
    },
    limits: {
      max_model_calls: 24,
      ...SPEC_LIMITS,
      run_lease_seconds: 45,
      heartbeat_seconds: 10,
      deadline_default_ms: 120_000,
    },
    switch_margin: 0.15,
    default_delivery: "verified_buffered",
    answer_cache_enabled: false,
    actions: actions.map((action) => ({ ...action, roles: { ...action.roles } })),
  }
}
