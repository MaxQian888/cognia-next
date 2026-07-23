// Permission restore (ADR-0090 Phase 8).
//
// When a session is recovered, past permission decisions restore
// CONSERVATIVELY: a prior `allow`/`allow_always` is NEVER replayed as an
// allowance (the grant died with the interrupted run) — it comes back as
// `pending` so the user re-decides. `deny` stays denied; `pending` stays
// pending. Nothing here can widen permissions.

import type { CanonicalPermissionEvent } from "@cognia/agent-config-types/canonical-session"

export interface RestoredPermission {
  requestId: string
  toolName: string
  state: "pending" | "denied"
  /** Set when a prior allowance was downgraded (UI can explain the re-ask). */
  downgradedFromAllow?: boolean
}

export function restorePermissionState(
  events: readonly CanonicalPermissionEvent[]
): RestoredPermission[] {
  return events.map((event) => {
    if (event.decision === "deny") {
      return { requestId: event.requestId, toolName: event.toolName, state: "denied" }
    }
    if (event.decision === "pending") {
      return { requestId: event.requestId, toolName: event.toolName, state: "pending" }
    }
    // allow / allow_always: the grant is NOT restored.
    return {
      requestId: event.requestId,
      toolName: event.toolName,
      state: "pending",
      downgradedFromAllow: true,
    }
  })
}
