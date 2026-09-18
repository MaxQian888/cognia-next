// Notification V2 incident + inhibition policy (pure helpers + DB glue).
//
// An incident is a root-cause collapse: when one fact is judged the ROOT of
// a burst (a failing run that spawns cascading child errors), the member
// facts are folded into the incident and inhibited from delivering while it
// is open — the operator gets the ONE root alert, not N echoes. Crucially:
//
//   • The ROOT fact itself is never inhibited — if the root's own send
//     fails, suppression must not hide every alert; the members stay
//     deliverable until the root is accepted.
//   • Member suppression is folded by the PLANNER reading `memberFactKeys`,
//     so a member that arrives before the fold still delivers (no retroactive
//     hiding of already-accepted sends).
//   • ACK transitions open → acknowledged and cancels the escalation timer;
//     resolve closes the incident and releases pending member work.
//
// The pure helpers (shouldFold, foldKey) are testable; the DB glue writes the
// `incident` policy-state row the planner reads.

import type { NotificationPolicyStateRow } from "@/types/notifications/decision"
import type { PlannerFact } from "./planner"
import { stableHash } from "../result/materiality"
import {
  putPolicyState,
  transitionIncident,
  getPolicyState,
} from "@/lib/db/notification-policy-state"
import { cancelTimersFor } from "@/lib/db/notification-timers"

/** How a member fact is judged to share a root with an incident. */
export interface IncidentCorrelation {
  /** The run whose failure opened the incident. */
  runId?: string
  /** The source subsystem ("scheduler", "agent-team"). */
  source?: string
  /** A shared group/correlation key producers stamp on related facts. */
  groupKey?: string
}

/**
 * Should `fact` fold into `incident`'s member set? Pure — a fact folds when
 * it shares the incident's run, group key, or source AND is not itself the
 * root. Correlation is deliberately conservative: over-folding hides real
//   alerts, so an ambiguous match does NOT fold.
 */
export function shouldFoldIntoIncident(
  incident: NotificationPolicyStateRow,
  fact: PlannerFact,
  correlation: IncidentCorrelation
): boolean {
  if (!incident.incident) return false
  if (incident.incident.state === "resolved") return false
  if (incident.incident.rootFactKey === fact.factKey) return false
  if (correlation.runId && fact.runId && correlation.runId === fact.runId) return true
  if (correlation.groupKey && fact.factKey.includes(correlation.groupKey)) return true
  return false
}

/** The incident row's stable fact key (root → incident identity). */
export function incidentFactKey(scopeKey: string, rootFactKey: string): string {
  return `incident:${stableHash({ s: scopeKey, r: rootFactKey }).slice(0, 16)}`
}

/**
 * Open (or extend) an incident rooted at `rootFact`. Members fold in; the
 * root is recorded separately so the planner never inhibits it. Returns the
 * written policy-state row.
 */
export async function openIncident(input: {
  scopeKey: string
  rootFactKey: string
  memberFactKeys?: string[]
  now?: number
}): Promise<NotificationPolicyStateRow> {
  const now = input.now ?? Date.now()
  const factKey = incidentFactKey(input.scopeKey, input.rootFactKey)
  const existing = await getPolicyState(input.scopeKey, factKey, "incident")
  const members = new Set(existing?.incident?.memberFactKeys ?? [])
  for (const m of input.memberFactKeys ?? []) {
    if (m !== input.rootFactKey) members.add(m)
  }
  return putPolicyState({
    scopeKey: input.scopeKey,
    factKey,
    stateKind: "incident",
    incident: {
      rootFactKey: input.rootFactKey,
      memberFactKeys: [...members],
      state:
        existing?.incident?.state === "resolved" ? "open" : (existing?.incident?.state ?? "open"),
      openedAt: existing?.incident?.openedAt ?? now,
      ...(existing?.incident?.acknowledgedAt
        ? { acknowledgedAt: existing.incident.acknowledgedAt }
        : {}),
      ...(existing?.incident?.ackedBy ? { ackedBy: existing.incident.ackedBy } : {}),
    },
  })
}

/**
 * ACK an incident — open → acknowledged, and cancel its escalation timers
 * (ACK is the explicit "I saw it" that stops the re-notify path).
 */
export async function acknowledgeIncident(
  scopeKey: string,
  rootFactKey: string,
  ackedBy: string,
  now?: number
): Promise<NotificationPolicyStateRow | undefined> {
  const factKey = incidentFactKey(scopeKey, rootFactKey)
  const updated = await transitionIncident(scopeKey, factKey, {
    state: "acknowledged",
    ackedBy,
    at: now,
  })
  // ACK cancels any pending escalation for the root fact.
  await cancelTimersFor({ factKey: rootFactKey, kind: "escalation" }, "incident-acknowledged")
  return updated
}

/**
 * Resolve an incident — closes it and releases member suppression. Pending
 * member work stays pending until the next plan; nothing is force-sent here
//   (recovery notifications only fire on an explicit recovery event).
 */
export async function resolveIncident(
  scopeKey: string,
  rootFactKey: string,
  now?: number
): Promise<NotificationPolicyStateRow | undefined> {
  const factKey = incidentFactKey(scopeKey, rootFactKey)
  return transitionIncident(scopeKey, factKey, { state: "resolved", at: now })
}
