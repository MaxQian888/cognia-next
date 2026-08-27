/**
 * The incident — one investigation, from "an alert arrived" to "here is the
 * conclusion and what it cites".
 *
 * Pure data and pure transitions. No clock, no id generator, no storage: every
 * caller passes `now` and `id` in, which is what lets the phase rules be tested
 * without a fake timer and what keeps the same model usable from the panel, a
 * future alert webhook, and a scheduled sweep.
 *
 * `phase` is DERIVED, never stored (see `derivePhase`). The first draft carried
 * it as a field advanced by half a dozen call sites, which is exactly the shape
 * that lets an incident claim "attribution" with an empty timeline.
 */

import type {
  SreFinding,
  SreTimeRange,
  SreTimelineDraft,
  SreTimelineRow,
  SreValidationResult,
} from "../evidence"

export type SreIncidentSeverity = "info" | "warning" | "critical"

/**
 * `unconfirmed` is the state a machine-created incident starts in: something
 * fired, but nobody has said it is worth investigating. It is not a degraded
 * `investigating` — the panel lists it separately and the agent does not run.
 */
export type SreIncidentStatus = "unconfirmed" | "investigating" | "resolved" | "dismissed"

export type SreIncidentPhase = "scope" | "evidence" | "attribution" | "conclusion"

export const SRE_INCIDENT_PHASES: readonly SreIncidentPhase[] = [
  "scope",
  "evidence",
  "attribution",
  "conclusion",
]

export interface SreIncidentAlert {
  time: string
  severity: SreIncidentSeverity
  service: string
  message: string
  provider?: string
  model?: string
  traceId?: string
  requestId?: string
}

/**
 * What the panel can honestly say about agent work on this incident.
 *
 * `toolCalls`, not turns: the plugin observes the SRE subagent through its own
 * tool executions (`panel-runtime`'s activity bus) and has no view of the
 * agent's turn counter. `maxTurns` is the budget the subagent is DECLARED with
 * in `plugin.json`, kept as context for the reader — it is not a denominator
 * for `toolCalls`, and the panel never renders the two as a fraction.
 */
export interface SreIncidentAgentRun {
  running: boolean
  /** Evidence queries observed since this incident was opened. */
  toolCalls: number
  /** The subagent's declared turn budget. Context only — see above. */
  maxTurns: number
  startedAt?: string
  finishedAt?: string
  /** Why the run stopped short, when it did. Rendered verbatim; never a code. */
  error?: string
}

export interface SreIncident {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  status: SreIncidentStatus
  severity: SreIncidentSeverity
  environment: string
  services: string[]
  window: SreTimeRange
  alert?: SreIncidentAlert
  traceId?: string
  requestId?: string
  /** Evidence pinned to this incident, in the order it was pinned. */
  evidenceIds: string[]
  timeline: SreTimelineRow[]
  findings: SreFinding[]
  recommendations: SreFinding[]
  /** Last `sre_validate_timeline` result, or null while nothing has been checked. */
  validation: SreValidationResult | null
  agentRun: SreIncidentAgentRun
  /** Set once the conclusion is accepted — the only phase input that is stored. */
  concludedAt?: string
  /** Chat session the incident was opened from, so the panel can scope its list. */
  sessionId?: string
}

/** Why an incident may not be concluded yet. Codes, so the panel can translate them. */
export type SreConcludeBlocker =
  "timeline.empty" | "validation.missing" | "validation.failed" | "status.closed"

export interface SreConcludeCheck {
  ok: boolean
  blocker?: SreConcludeBlocker
}

const IDLE_RUN: SreIncidentAgentRun = { running: false, toolCalls: 0, maxTurns: 15 }

/** Minutes of context kept on either side of an alert's own timestamp. */
const ALERT_WINDOW_LEAD_MS = 60_000
const ALERT_WINDOW_TRAIL_MS = 4 * 60_000

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

/**
 * Which phase the incident is actually in, from what it actually holds.
 *
 * Conclusion is the one phase that needs an explicit act rather than a derived
 * one: a validated timeline is a *finished investigation*, not an accepted
 * answer, and only a person decides the difference.
 */
export function derivePhase(incident: SreIncident): SreIncidentPhase {
  if (incident.concludedAt) return "conclusion"
  if (incident.timeline.length > 0) return "attribution"
  if (incident.evidenceIds.length > 0) return "evidence"
  return "scope"
}

/** Position of a phase in the fixed order — for rendering the phase strip. */
export function phaseIndex(phase: SreIncidentPhase): number {
  return SRE_INCIDENT_PHASES.indexOf(phase)
}

/** Is `phase` already behind the incident's current one? */
export function isPhaseComplete(incident: SreIncident, phase: SreIncidentPhase): boolean {
  return phaseIndex(phase) < phaseIndex(derivePhase(incident))
}

export interface CreateIncidentInput {
  id: string
  now: string
  title: string
  environment: string
  window: SreTimeRange
  severity?: SreIncidentSeverity
  services?: string[]
  traceId?: string
  requestId?: string
  sessionId?: string
  status?: SreIncidentStatus
  maxTurns?: number
}

/** Open an incident a person asked for — already worth investigating. */
export function createIncident(input: CreateIncidentInput): SreIncident {
  return {
    id: input.id,
    createdAt: input.now,
    updatedAt: input.now,
    title: input.title,
    status: input.status ?? "investigating",
    severity: input.severity ?? "warning",
    environment: input.environment,
    services: unique(input.services ?? []),
    window: input.window,
    traceId: input.traceId,
    requestId: input.requestId,
    evidenceIds: [],
    timeline: [],
    findings: [],
    recommendations: [],
    validation: null,
    agentRun: { ...IDLE_RUN, maxTurns: input.maxTurns ?? IDLE_RUN.maxTurns },
    sessionId: input.sessionId,
  }
}

/**
 * Open an incident from an alert.
 *
 * The window is the alert's own timestamp widened backwards more than forwards:
 * an alert fires *after* the thing it is about, so the minute before it carries
 * the cause and the minutes after carry the recovery.
 */
export function createIncidentFromAlert(
  alert: SreIncidentAlert,
  input: { id: string; now: string; environment: string; sessionId?: string; maxTurns?: number }
): SreIncident {
  const fired = Date.parse(alert.time)
  const anchor = Number.isFinite(fired) ? fired : Date.parse(input.now)
  return {
    ...createIncident({
      ...input,
      title: alert.message,
      severity: alert.severity,
      services: [alert.service],
      traceId: alert.traceId,
      requestId: alert.requestId,
      window: {
        startTime: new Date(anchor - ALERT_WINDOW_LEAD_MS).toISOString(),
        endTime: new Date(anchor + ALERT_WINDOW_TRAIL_MS).toISOString(),
      },
      // Nothing has decided this alert deserves an investigation yet.
      status: "unconfirmed",
    }),
    alert,
  }
}

function touch(incident: SreIncident, now: string, patch: Partial<SreIncident>): SreIncident {
  return { ...incident, ...patch, updatedAt: now }
}

/** Promote an alert-created incident into an investigation. */
export function confirmIncident(incident: SreIncident, now: string): SreIncident {
  if (incident.status !== "unconfirmed") return incident
  return touch(incident, now, { status: "investigating" })
}

/** Close an incident as not worth investigating. Keeps whatever was collected. */
export function dismissIncident(incident: SreIncident, now: string): SreIncident {
  if (incident.status === "dismissed") return incident
  return touch(incident, now, { status: "dismissed" })
}

/** Reopen a closed incident for more work. */
export function reopenIncident(incident: SreIncident, now: string): SreIncident {
  if (incident.status === "investigating" || incident.status === "unconfirmed") return incident
  return touch(incident, now, { status: "investigating", concludedAt: undefined })
}

/** Pin evidence, preserving pin order and ignoring repeats. */
export function attachEvidence(
  incident: SreIncident,
  evidenceIds: readonly string[],
  now: string
): SreIncident {
  const merged = unique([...incident.evidenceIds, ...evidenceIds])
  if (merged.length === incident.evidenceIds.length) return incident
  return touch(incident, now, { evidenceIds: merged })
}

/**
 * Unpin evidence.
 *
 * Deliberately does NOT rewrite the timeline that cited it: dropping a row's
 * citation silently is how a timeline ends up asserting something nothing
 * supports. The next validation reports `row.evidence_unknown` instead, which
 * is the honest surface for it.
 */
export function detachEvidence(
  incident: SreIncident,
  evidenceIds: readonly string[],
  now: string
): SreIncident {
  const drop = new Set(evidenceIds)
  const kept = incident.evidenceIds.filter((id) => !drop.has(id))
  if (kept.length === incident.evidenceIds.length) return incident
  return touch(incident, now, { evidenceIds: kept })
}

/**
 * Record a drafted timeline.
 *
 * Any edit to the draft clears the previous validation result: a stale `ok`
 * next to a changed timeline is worse than no verdict at all, because the panel
 * renders it as a green check.
 */
export function applyTimeline(
  incident: SreIncident,
  draft: SreTimelineDraft,
  now: string
): SreIncident {
  return touch(incident, now, {
    timeline: draft.rows,
    findings: draft.findings ?? [],
    recommendations: draft.recommendations ?? [],
    validation: null,
  })
}

/** Record the validator's verdict for the timeline currently held. */
export function applyValidation(
  incident: SreIncident,
  validation: SreValidationResult,
  now: string
): SreIncident {
  return touch(incident, now, { validation })
}

/** Patch the agent-run indicator the panel shows while a subagent is working. */
export function setAgentRun(
  incident: SreIncident,
  patch: Partial<SreIncidentAgentRun>,
  now: string
): SreIncident {
  return touch(incident, now, { agentRun: { ...incident.agentRun, ...patch } })
}

/** May this incident be concluded, and if not, why not? */
export function canConclude(incident: SreIncident): SreConcludeCheck {
  if (incident.status === "dismissed" || incident.status === "resolved") {
    return { ok: false, blocker: "status.closed" }
  }
  if (incident.timeline.length === 0) return { ok: false, blocker: "timeline.empty" }
  if (!incident.validation) return { ok: false, blocker: "validation.missing" }
  if (!incident.validation.ok) return { ok: false, blocker: "validation.failed" }
  return { ok: true }
}

/**
 * Accept the conclusion and close the incident.
 *
 * Throws rather than no-oping when the gate is not met: `canConclude` is the
 * question, and a caller that skipped it has a bug the panel should not paper
 * over by silently leaving the incident open.
 */
export function concludeIncident(incident: SreIncident, now: string): SreIncident {
  const check = canConclude(incident)
  if (!check.ok) throw new Error(`incident cannot be concluded: ${check.blocker}`)
  return touch(incident, now, { status: "resolved", concludedAt: now })
}

/** Sort key for the incident list: open work first, then most recently touched. */
export function compareIncidents(left: SreIncident, right: SreIncident): number {
  const rank: Record<SreIncidentStatus, number> = {
    investigating: 0,
    unconfirmed: 1,
    resolved: 2,
    dismissed: 3,
  }
  return rank[left.status] - rank[right.status] || right.updatedAt.localeCompare(left.updatedAt)
}
