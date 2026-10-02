/**
 * Automated incident reconciliation (plan §9).
 *
 * Runs each minute after aggregation with the latest per-component
 * evaluation. Only that latest evaluation is acted on: delayed batches that
 * filled old slots never open historic incidents or replay old transitions,
 * so they cannot cause a notification storm. Each transition is one guarded
 * batch (job lease + expected revision + write token), and a stable event
 * ID per update makes a replay create neither a second update nor a second
 * email.
 *
 * Lifecycle for an automated incident (fingerprint = component ID):
 * - open after `OUTAGE_CONSECUTIVE_FAILURES` consecutive expected reference
 *   failures with fresh reference evidence, outside maintenance;
 * - `monitoring` after `RECOVERY_CONSECUTIVE_PASSES` reference passes;
 * - resolve after a further `RESOLVE_STABLE_MINUTES` passes, labelled
 *   corroborated when a fresh native witness also passes, uncorroborated when
 *   none is available, and held while a fresh native witness still fails;
 * - a fresh failure while monitoring returns to `investigating` with one
 *   update; after resolution a recurrence opens a new incident linked to its
 *   predecessor, never reopening history.
 * Pinned (manually owned) and manual incidents are never changed.
 */

import {
  HOUR_MS,
  MINUTE_MS,
  OUTAGE_CONSECUTIVE_FAILURES,
  RECOVERY_CONSECUTIVE_PASSES,
  RESOLVE_STABLE_MINUTES,
  type ComponentId,
  type IncidentImpact,
  type LocalizedText,
} from "../../../../../lib/status/contract"
import { featureOn } from "../env"
import { leaseGuard } from "../platform/lease"
import { logEvent } from "../platform/http"
import type { ComponentEvaluation, JobContext, ReconcileInput } from "../seams"
import { alertOperator } from "../notifications/alerts"
import { parseJsonColumn } from "./ids"
import {
  committed,
  planCreateIncident,
  planIncidentTransition,
  readOpenIncidentByFingerprint,
  readUpdates,
  type IncidentRow,
} from "./store"
import {
  automatedTitle,
  escalatedMessage,
  monitoringMessage,
  openedMessage,
  refailedMessage,
  resolvedMessage,
  type WitnessTally,
} from "./templates"

/** Reference passes needed before an automated incident resolves. */
export const RESOLVE_CONSECUTIVE_PASSES = RECOVERY_CONSECUTIVE_PASSES + RESOLVE_STABLE_MINUTES
/** An evaluation older than this is history, not the current state. */
export const MAX_EVALUATION_AGE_MS = 5 * MINUTE_MS
/** A recurrence within this long after resolution links its predecessor. */
export const PREDECESSOR_WINDOW_MS = 24 * HOUR_MS
/** Observer alerts for the same probe are not repeated within this long. */
export const OBSERVER_ALERT_COOLDOWN_MS = HOUR_MS

export type AutomationDecision =
  | { kind: "none"; reason: string }
  | { kind: "open"; impact: IncidentImpact }
  | { kind: "escalate" }
  | { kind: "monitoring" }
  | { kind: "refail" }
  | { kind: "resolve"; corroborated: boolean }

export interface OpenIncidentFacts {
  state: IncidentRow["state"]
  impact: IncidentImpact
  source: IncidentRow["source"]
  pinned: boolean
  updatedAtMs: number
}

export function tallyWitnesses(evaluation: ComponentEvaluation): WitnessTally {
  return {
    total: evaluation.witnesses.length,
    failing: evaluation.witnesses.filter((witness) => witness.result === "fail").length,
    passing: evaluation.witnesses.filter((witness) => witness.result === "pass").length,
  }
}

/** Impact backed by the evidence: a passing fresh witness makes it partial. */
export function evidenceImpact(evaluation: ComponentEvaluation): IncidentImpact {
  return evaluation.witnesses.some((witness) => witness.result === "pass")
    ? "partial_outage"
    : "major_outage"
}

/** Pure decision for one component; the caller applies it. */
export function decideAutomation(
  evaluation: ComponentEvaluation,
  open: OpenIncidentFacts | null,
  context: { nowMs: number; manualIncidentCovers: boolean }
): AutomationDecision {
  if (context.nowMs - evaluation.evaluatedAtMs > MAX_EVALUATION_AGE_MS) {
    return { kind: "none", reason: "stale_evaluation" }
  }
  // Unknown, runner errors and stale reference evidence are observer
  // problems: they never open, advance or resolve a service incident.
  if (!evaluation.referenceFresh) return { kind: "none", reason: "reference_not_fresh" }
  const streaks = evaluation.referenceStreaks
  const failingNow = streaks.failures >= 1 && streaks.passes === 0

  if (!open) {
    if (evaluation.inMaintenance) return { kind: "none", reason: "maintenance" }
    if (streaks.failures < OUTAGE_CONSECUTIVE_FAILURES)
      return { kind: "none", reason: "below_threshold" }
    if (context.manualIncidentCovers) return { kind: "none", reason: "manual_incident_open" }
    return { kind: "open", impact: evidenceImpact(evaluation) }
  }

  if (open.source !== "automated" || open.pinned) return { kind: "none", reason: "manually_owned" }
  if (evaluation.evaluatedAtMs < open.updatedAtMs)
    return { kind: "none", reason: "older_than_incident" }

  if (open.state === "monitoring") {
    if (failingNow) {
      return evaluation.inMaintenance ? { kind: "none", reason: "maintenance" } : { kind: "refail" }
    }
    if (streaks.passes >= RESOLVE_CONSECUTIVE_PASSES) {
      const native = evaluation.witnesses.filter((witness) => witness.profileId === "native")
      if (native.some((witness) => witness.result === "fail")) {
        return { kind: "none", reason: "witness_still_failing" }
      }
      return { kind: "resolve", corroborated: native.some((witness) => witness.result === "pass") }
    }
    return { kind: "none", reason: "monitoring" }
  }

  // investigating / identified
  if (streaks.passes >= RECOVERY_CONSECUTIVE_PASSES) return { kind: "monitoring" }
  if (
    failingNow &&
    open.impact !== "major_outage" &&
    evidenceImpact(evaluation) === "major_outage"
  ) {
    // Escalate only, never de-escalate: a flapping witness cannot produce
    // an update per minute.
    return { kind: "escalate" }
  }
  return { kind: "none", reason: "unchanged" }
}

async function manualIncidentCovers(db: D1Database, componentId: ComponentId): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT component_ids_json FROM incidents
       WHERE resolved_at IS NULL AND source = 'manual'
       ORDER BY started_at DESC LIMIT 50`
    )
    .all<{ component_ids_json: string }>()
  return result.results.some((row) =>
    parseJsonColumn<ComponentId[]>(row.component_ids_json, "incidents.component_ids_json").includes(
      componentId
    )
  )
}

async function recentPredecessor(
  db: D1Database,
  fingerprint: string,
  nowMs: number
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM incidents WHERE fingerprint = ? AND resolved_at IS NOT NULL AND resolved_at >= ?
       ORDER BY resolved_at DESC LIMIT 1`
    )
    .bind(fingerprint, nowMs - PREDECESSOR_WINDOW_MS)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function reconcileComponent(job: JobContext, evaluation: ComponentEvaluation): Promise<void> {
  const db = job.env.DB
  const componentId = evaluation.componentId
  const open = await readOpenIncidentByFingerprint(db, componentId)
  const decision = decideAutomation(
    evaluation,
    open
      ? {
          state: open.state,
          impact: open.impact,
          source: open.source,
          pinned: open.pinned === 1,
          updatedAtMs: open.updated_at,
        }
      : null,
    {
      nowMs: job.nowMs,
      manualIncidentCovers: open ? false : await manualIncidentCovers(db, componentId),
    }
  )
  if (decision.kind === "none") return

  const guard = leaseGuard(job.lease, job.nowMs)
  const tally = tallyWitnesses(evaluation)
  const evidenceAtMs = evaluation.latestEvidenceAtMs
  const streaks = evaluation.referenceStreaks

  if (decision.kind === "open") {
    const plan = planCreateIncident(db, {
      title: automatedTitle(componentId, decision.impact),
      state: "investigating",
      impact: decision.impact,
      componentIds: [componentId],
      source: "automated",
      fingerprint: componentId,
      pinned: false,
      manualOwner: null,
      predecessorId: await recentPredecessor(db, componentId, job.nowMs),
      update: {
        message: openedMessage(componentId, streaks.failures, tally),
        source: "automated",
        atMs: job.nowMs,
        evidenceAtMs,
        correctionOf: null,
      },
      extraGuard: guard,
    })
    const results = await db.batch(plan.statements)
    logEvent("incident.automation", {
      action: "open",
      componentId,
      incidentId: plan.incidentId,
      applied: committed(results),
      fence: job.lease.fence,
    })
    return
  }

  if (!open) return
  let state: IncidentRow["state"] = open.state
  let impact: IncidentImpact = open.impact
  let message: LocalizedText
  switch (decision.kind) {
    case "escalate":
      impact = "major_outage"
      message = escalatedMessage(componentId, tally)
      break
    case "monitoring":
      state = "monitoring"
      message = monitoringMessage(componentId, streaks.passes)
      break
    case "refail":
      state = "investigating"
      impact = open.impact === "major_outage" ? "major_outage" : evidenceImpact(evaluation)
      message = refailedMessage(componentId)
      break
    case "resolve":
      state = "resolved"
      message = resolvedMessage(componentId, streaks.passes, decision.corroborated)
      break
  }
  const plan = planIncidentTransition(db, {
    current: open,
    currentUpdates: await readUpdates(db, open.id),
    expectedRevision: open.revision,
    state,
    impact,
    componentIds: parseJsonColumn<ComponentId[]>(
      open.component_ids_json,
      "incidents.component_ids_json"
    ),
    pinned: false,
    manualOwner: null,
    update: { message, source: "automated", atMs: job.nowMs, evidenceAtMs, correctionOf: null },
    notify: true,
    automationOnly: true,
    extraGuard: guard,
  })
  const results = await db.batch(plan.statements)
  logEvent("incident.automation", {
    action: decision.kind,
    componentId,
    incidentId: open.id,
    applied: committed(results),
    fence: job.lease.fence,
  })
}

export async function reconcileIncidents(job: JobContext, input: ReconcileInput): Promise<void> {
  // An observer that stopped reporting is an operations problem, never a
  // public incident, so the operator hears about it even while incident
  // automation is still switched off during the rollout (plan §12).
  if (!input.observer.referenceHealthy) {
    const probe = input.observer.referenceProbeId ?? "none"
    const last = input.observer.lastReferenceAtMs
    await alertOperator(job.env, {
      key: `observer:${probe}`,
      severity: "warning",
      summary:
        last === null
          ? `Reference observer ${probe} has not reported; service status is unknown, not an outage.`
          : `Reference observer ${probe} last reported at ${new Date(last).toISOString()}; service status is unknown, not an outage.`,
      nowMs: job.nowMs,
      cooldownMs: OBSERVER_ALERT_COOLDOWN_MS,
    })
  }

  // Flag off: no automated incident is opened or changed, and manual
  // incidents are untouched either way.
  if (!featureOn(job.env.FEATURE_INCIDENT_AUTOMATION)) return

  for (const evaluation of input.evaluations) {
    await reconcileComponent(job, evaluation)
  }
}
