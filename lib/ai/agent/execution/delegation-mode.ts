// Delegation-mode decision (ADR-0090 Phase 7).
//
// Given the parent's and the candidate child's FROZEN specs, decide whether
// the child may run as a NATIVE subagent (same process, inherits the parent's
// route/credential/host — only a frozen model role differs) or must be
// ORCHESTRATED (its own spec, its own attempt identity, exchanged with the
// parent through a HandoffEnvelope). The reasons are machine-readable so the
// orchestrator, audits, and traces all key off the same vocabulary.

import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

export type DelegationDivergenceReason =
  | "runtime-differs"
  | "route-differs"
  | "host-differs"
  | "deployment-differs"
  | "credential-differs"
  | "capability-differs"

export interface DelegationModeDecision {
  mode: "native" | "orchestrated"
  /** Non-empty exactly when mode is "orchestrated". */
  reasons: DelegationDivergenceReason[]
}

function routeIdentity(spec: ResolvedAgentExecutionSpec): string {
  // Route identity for delegation: kind + policy. A gateway child minted its
  // own ticket only in orchestrated mode, so ticket identity is not compared
  // here — the sidecar enforces one ticket per process env.
  return `${spec.route.kind}:${spec.route.routePolicy}`
}

/**
 * Decide native vs orchestrated. Native iff runtime, route, host, deployment
 * and credential reference are ALL identical and the child requires no hard
 * capability the parent's effective set lacks — model role variance alone
 * (subagent "haiku"/"opus" selectors mapping to frozen bindings) stays native.
 */
export function decideDelegationMode(
  parent: ResolvedAgentExecutionSpec,
  child: ResolvedAgentExecutionSpec
): DelegationModeDecision {
  const reasons: DelegationDivergenceReason[] = []

  if (parent.runtimeAdapter !== child.runtimeAdapter) reasons.push("runtime-differs")
  if (routeIdentity(parent) !== routeIdentity(child)) reasons.push("route-differs")
  if (parent.hostRef !== child.hostRef) reasons.push("host-differs")
  if ((parent.deploymentRef ?? null) !== (child.deploymentRef ?? null)) {
    reasons.push("deployment-differs")
  }
  if ((parent.credential?.profileRef ?? null) !== (child.credential?.profileRef ?? null)) {
    reasons.push("credential-differs")
  }
  // A native child lives inside the parent's process: any hard capability the
  // parent's effective set cannot serve forces orchestration.
  const parentCaps = new Set(parent.capabilities.effective)
  if (child.capabilities.effective.some((cap) => !parentCaps.has(cap))) {
    reasons.push("capability-differs")
  }

  return reasons.length === 0 ? { mode: "native", reasons: [] } : { mode: "orchestrated", reasons }
}
