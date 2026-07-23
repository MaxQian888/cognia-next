// Teammate execution-binding resolver (ADR-0090 Phase 7).
//
// One fixed precedence chain decides which execution binding a teammate
// dispatch feeds the unified resolver:
//
//   managed force-all  >  member  >  run override  >  team default  >  app default
//
// Managed override is EXPLICIT in the trace (never silent), pool mode exposes
// candidate deployment ids ONLY (the coordinator never sees endpoints or
// credentials), and new raw-credential writes are rejected at the store
// boundary via `assertNoNewRawTeammateCredentials`.

import type { AgentExecutionPolicy } from "@cognia/agent-config-types/agent-execution"
import type { TeammateConfig, TeammateExecutionBinding } from "@/types/agent/agent-team"

export type ExecutionBindingSource = "managed" | "member" | "run" | "team-default" | "app-default"

export interface ResolvedTeammateBinding {
  /** Policy fragment for `resolveAgentExecutionSpec` — refs only. */
  policy: Partial<AgentExecutionPolicy>
  source: ExecutionBindingSource
  /** Pool mode: the candidate ids the coordinator may pick from. */
  candidateIds?: string[]
  /** Explicit trace of the chain that was consulted (audit). */
  trace: {
    consulted: ExecutionBindingSource[]
    managedForced: boolean
  }
}

export interface ResolveTeammateBindingInput {
  member?: TeammateExecutionBinding
  runOverride?: TeammateExecutionBinding
  teamDefault?: TeammateExecutionBinding
  appDefault?: TeammateExecutionBinding
  /** Managed policy: force EVERY teammate onto this binding (explicit). */
  managedForceAll?: TeammateExecutionBinding
}

function policyFromBinding(binding: TeammateExecutionBinding): {
  policy: Partial<AgentExecutionPolicy>
  candidateIds?: string[]
} {
  if (binding.mode === "pinned") {
    return {
      policy: {
        ...(binding.runtimePolicy ? { runtimePolicy: binding.runtimePolicy } : {}),
        ...(binding.deploymentRef ? { deploymentRef: binding.deploymentRef } : {}),
        ...(binding.credentialProfileRef
          ? { credentialProfileRef: binding.credentialProfileRef }
          : {}),
        ...(binding.modelRole ? { modelBindingRef: binding.modelRole } : {}),
      },
    }
  }
  if (binding.mode === "pool") {
    // Candidates only — the picked id becomes a pinned deploymentRef AFTER
    // the coordinator chooses; nothing endpoint/credential shaped leaves here.
    return { policy: {}, candidateIds: [...binding.candidateIds] }
  }
  return { policy: {} }
}

/**
 * Resolve the effective binding by fixed precedence. `inherit` (or absence)
 * at any level falls through to the next; managed force-all short-circuits
 * everything and is recorded in the trace.
 */
export function resolveTeammateExecutionBinding(
  input: ResolveTeammateBindingInput
): ResolvedTeammateBinding {
  const chain: Array<[ExecutionBindingSource, TeammateExecutionBinding | undefined]> = [
    ["managed", input.managedForceAll],
    ["member", input.member],
    ["run", input.runOverride],
    ["team-default", input.teamDefault],
    ["app-default", input.appDefault],
  ]

  const consulted: ExecutionBindingSource[] = []
  for (const [source, binding] of chain) {
    consulted.push(source)
    if (!binding || binding.mode === "inherit") continue
    const { policy, candidateIds } = policyFromBinding(binding)
    return {
      policy,
      source,
      ...(candidateIds ? { candidateIds } : {}),
      trace: { consulted, managedForced: source === "managed" },
    }
  }

  // Whole chain inherited: the app default execution applies (empty policy —
  // the unified resolver's own legacy/default mapping decides).
  return {
    policy: {},
    source: "app-default",
    trace: { consulted, managedForced: false },
  }
}

export class RawTeammateCredentialError extends Error {
  readonly field: "apiKey" | "baseURL"

  constructor(field: "apiKey" | "baseURL") {
    super(
      `teammate config rejected: raw "${field}" writes are retired (ADR-0090 Phase 7) — ` +
        `bind a credential/deployment profile reference via config.execution instead`
    )
    this.name = "RawTeammateCredentialError"
    this.field = field
  }
}

/**
 * Reject NEW raw credential material entering a teammate config. Legacy rows
 * stay readable: an unchanged value carried over from `previous` passes, only
 * introducing or changing a raw value throws.
 */
export function assertNoNewRawTeammateCredentials(
  next: TeammateConfig | undefined,
  previous?: TeammateConfig
): void {
  for (const field of ["apiKey", "baseURL"] as const) {
    const incoming = next?.[field]
    if (incoming && incoming !== previous?.[field]) {
      throw new RawTeammateCredentialError(field)
    }
  }
}

/**
 * Migrate a legacy raw-credential teammate config onto the reference model:
 * the legacy provider id IS the deployment id in the ADR-0090 P1 profile
 * store (`deriveProfiles` keeps old provider ids as deployment identity), so
 * a legacy `{provider, apiKey, baseURL}` row becomes a pinned
 * `deploymentRef: provider` whose credential resolves through the store's
 * `legacy-provider-settings` reference — the raw values are NOT copied
 * anywhere new and remain only on the legacy row for rollback.
 */
export function migrateTeammateExecutionBinding(
  config: TeammateConfig
): TeammateExecutionBinding | undefined {
  if (config.execution) return config.execution
  if (!config.apiKey && !config.baseURL && !config.provider) return undefined
  if (!config.provider) return undefined
  return { mode: "pinned", deploymentRef: config.provider }
}
