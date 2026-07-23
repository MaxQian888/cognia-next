// Route-ticket remint gate (ADR-0090 Phase 8).
//
// After a crash/restart a gateway route ticket may be reminted ONLY for the
// SAME frozen execution spec: identical execution fingerprint, identical
// candidate deployment set, identical model bindings. Any drift pauses the
// run (`recovery_required`) instead of silently re-routing — a restart must
// never widen or move a session's route.

export interface TicketRemintSpec {
  executionFingerprint: string
  /** Candidate deployment ids the ticket was scoped to. */
  candidateDeploymentIds: string[]
  modelBindings: { primary: string; fast?: string; powerful?: string }
}

export type TicketRemintPlan = { action: "remint" } | { action: "pause"; mismatches: string[] }

export function planTicketRemint(
  previous: TicketRemintSpec,
  next: TicketRemintSpec
): TicketRemintPlan {
  const mismatches: string[] = []
  if (previous.executionFingerprint !== next.executionFingerprint) {
    mismatches.push("executionFingerprint")
  }
  const prevCandidates = [...previous.candidateDeploymentIds].sort().join(",")
  const nextCandidates = [...next.candidateDeploymentIds].sort().join(",")
  if (prevCandidates !== nextCandidates) mismatches.push("candidateDeploymentIds")
  for (const role of ["primary", "fast", "powerful"] as const) {
    if ((previous.modelBindings[role] ?? null) !== (next.modelBindings[role] ?? null)) {
      mismatches.push(`modelBindings.${role}`)
    }
  }
  return mismatches.length === 0 ? { action: "remint" } : { action: "pause", mismatches }
}
