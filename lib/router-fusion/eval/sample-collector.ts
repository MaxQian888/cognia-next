/**
 * Building routing samples out of runs that already happened (ADR-0188 B6).
 *
 * The router's hot path writes nothing extra for the experiment: the fusion
 * database already holds the run, the route decision it was made from, the
 * event journal that carries the result's own verdict, and the ledger that
 * settled its bill. The collector is the read model over those four, so
 * enabling the experiment costs a routed turn exactly nothing and turning it
 * off leaves no orphaned writes behind.
 *
 * Two consequences worth stating plainly:
 *
 *  - **Features are re-encoded, not replayed.** The decision does not store the
 *    feature vector, so the collector rebuilds it from the run's stored input
 *    with the RULES classifier, always — whichever classifier routed the run at
 *    the time. Every sample is therefore encoded by one deterministic function,
 *    which is the property the trainer needs; what it costs is that a sample is
 *    a statement about the request, not a recording of the router's own
 *    momentary belief.
 *  - **Collection has a deadline.** The input it re-encodes from is an artifact
 *    on the content window (7 days), while samples live on their own, much
 *    longer window. A run collected in time keeps its sample long after the
 *    text is gone; a run collected too late cannot be collected at all, and
 *    says so (`input_unavailable`) instead of contributing an empty vector.
 */

import { isTerminalRunStatus } from "@cognia/router-fusion"

import type { FusionDB } from "../db/fusion-db"
import { decodeRunInput } from "../db/run-input"
import type { FusionRoutingSampleRow, FusionRunRow } from "../db/types"
import { runFeatures } from "../routing/run-route"
import {
  encodeRoutingFeatures,
  ROUTING_FEATURES_VERSION,
  rulesPropensity,
  sampleAccepted,
  sampleIdFor,
} from "./routing-sample"
import { putRoutingSamples, routingSampleExpiry } from "./routing-store"

/** Why one run produced no sample. Every reason is a fact about the run, never a silent drop. */
export type RoutingSampleSkipReason =
  /** Still running, queued or waiting: it has no outcome to label yet. */
  | "not_terminal"
  /** No route decision was ever stored (refused before routing). */
  | "no_decision"
  /** The router selected nothing — a refusal, not a choice to learn from. */
  | "no_action_selected"
  /** The bill is not settled yet; collecting now would understate the cost. */
  | "cost_pending"
  /** The stored input is gone (content window) or unreadable (locked vault). */
  | "input_unavailable"

export interface RoutingSampleSkip {
  runId: string
  reason: RoutingSampleSkipReason
}

export interface CollectRoutingSamplesDeps {
  /** Plain text of one of a run's artifacts, or null when it is gone or unreadable. */
  readArtifact(runId: string, artifactId: string): Promise<string | null>
  now(): number
}

export interface CollectRoutingSamplesOptions {
  /** Only runs that ended at or after this epoch millisecond. */
  since?: number
  /** Stop after this many runs are scanned. */
  limit?: number
}

export interface CollectRoutingSamplesResult {
  scanned: number
  collected: number
  skipped: RoutingSampleSkip[]
}

/** The result's own verdict, read from the run's journal. */
export async function qualityStatusOf(
  db: FusionDB,
  runId: string
): Promise<"accepted" | "degraded" | "unknown" | null> {
  const events = await db.fusionRunEvents.where("runId").equals(runId).toArray()
  events.sort((left, right) => left.seq - right.seq)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== "answer.completed") continue
    const status = events[index].payload.quality_status
    if (status === "accepted" || status === "degraded" || status === "unknown") return status
    return null
  }
  return null
}

async function sampleOf(
  db: FusionDB,
  run: FusionRunRow,
  deps: CollectRoutingSamplesDeps
): Promise<FusionRoutingSampleRow | RoutingSampleSkipReason> {
  if (!isTerminalRunStatus(run.status)) return "not_terminal"
  if (run.costStatus === "pending") return "cost_pending"
  const decisionRow = await db.fusionRouteDecisions.get(run.decisionId)
  if (!decisionRow) return "no_decision"
  const propensity = rulesPropensity(decisionRow.decision, run.actionId)
  if (propensity === null || propensity === 0) return "no_action_selected"
  if (!run.inputArtifactId) return "input_unavailable"

  let stored: ReturnType<typeof decodeRunInput>
  try {
    stored = decodeRunInput(await deps.readArtifact(run.runId, run.inputArtifactId))
  } catch {
    // A locked vault or a reaped artifact is a fact about this run, not a
    // reason to abandon the sweep: the run is reported and the others go on.
    return "input_unavailable"
  }
  if (!stored) return "input_unavailable"

  const qualityStatus = await qualityStatusOf(db, run.runId)
  const now = deps.now()
  return {
    sampleId: sampleIdFor(run.runId, run.decisionId),
    runId: run.runId,
    groupId: run.sessionId ?? run.runId,
    actionId: run.actionId,
    actionHash: run.actionHash,
    mode: run.mode,
    ruleId: run.ruleId,
    // Nothing but the rules router routes real traffic today (the learned
    // router only ever shadows), so the baseline arm of a replay comparison is
    // the action that ran. The moment an exploration arm exists this stops
    // being an identity and the field starts carrying information.
    baselineActionId: run.actionId,
    featuresVersion: ROUTING_FEATURES_VERSION,
    features: encodeRoutingFeatures(runFeatures(stored.messages, stored.jsonSchema)),
    propensity,
    origin: "recorded",
    costMicrousd: Math.max(0, Math.round(run.budget.spentMicrousd)),
    costStatus: run.costStatus,
    accepted: sampleAccepted(run.status, qualityStatus),
    qualityStatus,
    runStatus: run.status,
    decidedAt: decisionRow.createdAt,
    createdAt: now,
    expiresAt: routingSampleExpiry(now),
  }
}

/**
 * Collect every terminal run that has not been sampled into a fresh set of
 * rows. Idempotent: a run already collected is rewritten in place, so running
 * the collector twice leaves the training set identical.
 */
export async function collectRoutingSamples(
  db: FusionDB,
  deps: CollectRoutingSamplesDeps,
  options: CollectRoutingSamplesOptions = {}
): Promise<CollectRoutingSamplesResult> {
  const runs = await db.fusionRuns.toArray()
  runs.sort(
    (left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId)
  )
  const candidates = runs
    .filter(
      (run) => options.since === undefined || (run.terminalAt ?? run.updatedAt) >= options.since
    )
    .slice(0, options.limit ?? runs.length)

  const rows: FusionRoutingSampleRow[] = []
  const skipped: RoutingSampleSkip[] = []
  for (const run of candidates) {
    const result = await sampleOf(db, run, deps)
    if (typeof result === "string") skipped.push({ runId: run.runId, reason: result })
    else rows.push(result)
  }
  const collected = await putRoutingSamples(db, rows)
  return { scanned: candidates.length, collected, skipped }
}
