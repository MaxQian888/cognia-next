/**
 * The shadow router (ADR-0188 D28, B6): the learned router predicts beside the
 * rules router and never acts.
 *
 * "Never acts" is a property of where this module is imported from, so it is
 * worth being exact about it. Nothing on a routing path — `routing/run-route.ts`,
 * `runtime/orchestrator-host.ts`, the chat send seam — imports anything under
 * `lib/router-fusion/eval/`. The only readers of a shadow decision are the
 * report, the CLI and the panel. `shadow-router.test.ts` pins that by reading
 * those files and failing if the import ever appears, which is what turns a
 * promise in a comment into a check.
 *
 * A shadow decision is computed AFTER the fact, from a stored sample: the
 * feature vector the run was encoded to, the action that really ran, and what
 * the active predictor would have chosen instead. It is the cheapest honest
 * form of shadowing — it costs a routed turn nothing at all — and it answers
 * the only question worth asking before a promotion: would this predictor have
 * done something different, and on which requests?
 */

import {
  loadRoutingPredictor,
  type RoutingPredictor,
  type RoutingPredictorManifest,
} from "@cognia/eval-core"

import type { FusionDB } from "../db/fusion-db"
import type { FusionRoutingSampleRow, FusionShadowDecisionRow } from "../db/types"
import { actionCostTable, learnedRoutingChoice, type ActionCostRow } from "./routing-experiment"
import { ROUTING_FEATURE_NAMES, ROUTING_FEATURES_VERSION, shadowIdFor } from "./routing-sample"
import {
  activePredictorManifest,
  listRoutingSamples,
  putShadowDecisions,
  routingSampleExpiry,
} from "./routing-store"

export interface LoadedShadowPredictor {
  predictor: RoutingPredictor
  manifestSha256: string
}

/**
 * The active learned router, or null when none is promoted. A manifest whose
 * seal no longer verifies, or that was trained on another encoding, is refused
 * rather than used: a shadow decision from a manifest nobody can verify is
 * worse than no shadow decision.
 */
export async function activeShadowPredictor(
  db: FusionDB
): Promise<LoadedShadowPredictor | { refused: string[] } | null> {
  const row = await activePredictorManifest(db)
  if (!row) return null
  const loaded = await loadRoutingPredictor(row.manifest as unknown as RoutingPredictorManifest, {
    featuresVersion: ROUTING_FEATURES_VERSION,
    featureNames: ROUTING_FEATURE_NAMES,
  })
  if (loaded.status === "refused") return { refused: loaded.problems }
  return { predictor: loaded.predictor, manifestSha256: row.manifestSha256 }
}

/** One shadow decision per sample. Pure; the store is a separate step. */
export function shadowDecisionsFor(
  rows: readonly FusionRoutingSampleRow[],
  predictor: RoutingPredictor,
  manifestSha256: string,
  costs: ReadonlyMap<string, ActionCostRow>,
  options: { now: number }
): FusionShadowDecisionRow[] {
  return rows.map((row) => {
    const choice = learnedRoutingChoice(predictor, row.features, costs)
    const actual = costs.get(row.actionHash)
    const actualPrediction = actual
      ? predictor.predict({ actionId: actual.actionId, actionHash: row.actionHash }, row.features)
      : null
    return {
      shadowId: shadowIdFor(row.sampleId, manifestSha256),
      sampleId: row.sampleId,
      runId: row.runId,
      manifestSha256,
      predictorVersion: predictor.version,
      actualActionId: row.actionId,
      shadowActionId: choice?.actionId ?? null,
      shadowPPass: choice?.pPass ?? null,
      actualPPass: actualPrediction?.pPass ?? null,
      agreed: choice !== null && choice.actionId === row.actionId,
      // Out of distribution when the predictor had no in-range opinion at all,
      // or when the action that ran was itself outside its head's range.
      inDistribution:
        (choice?.inDistribution ?? false) && (actualPrediction?.inDistribution ?? false),
      createdAt: options.now,
      expiresAt: routingSampleExpiry(options.now),
    }
  })
}

export interface ShadowAgreementSummary {
  evaluated: number
  agreed: number
  /** Agreement as a share of evaluated decisions; null when nothing was evaluated. */
  agreementRate: number | null
  /** Decisions where the predictor had no calibrated, in-range head to offer. */
  noOpinion: number
  outOfDistribution: number
  /** How often the predictor would have chosen each action instead. */
  shadowActionCounts: Record<string, number>
}

export function shadowAgreementSummary(
  decisions: readonly FusionShadowDecisionRow[]
): ShadowAgreementSummary {
  const counts: Record<string, number> = {}
  let agreed = 0
  let noOpinion = 0
  let outOfDistribution = 0
  for (const decision of decisions) {
    if (decision.agreed) agreed += 1
    if (decision.shadowActionId === null) noOpinion += 1
    else counts[decision.shadowActionId] = (counts[decision.shadowActionId] ?? 0) + 1
    if (!decision.inDistribution) outOfDistribution += 1
  }
  return {
    evaluated: decisions.length,
    agreed,
    agreementRate: decisions.length === 0 ? null : agreed / decisions.length,
    noOpinion,
    outOfDistribution,
    shadowActionCounts: counts,
  }
}

export type ShadowRunOutcome =
  | { status: "no_predictor" }
  | { status: "predictor_refused"; problems: string[] }
  | { status: "no_samples"; manifestSha256: string }
  | {
      status: "recorded"
      manifestSha256: string
      predictorVersion: string
      stored: number
      summary: ShadowAgreementSummary
    }

/**
 * Run the active learned router over stored samples and record what it would
 * have chosen. Idempotent: one shadow row per (sample, predictor), so a second
 * pass rewrites the same rows.
 */
export async function recordShadowDecisions(
  db: FusionDB,
  options: { now: number; limit?: number; since?: number }
): Promise<ShadowRunOutcome> {
  const active = await activeShadowPredictor(db)
  if (!active) return { status: "no_predictor" }
  if ("refused" in active) return { status: "predictor_refused", problems: active.refused }

  const rows = await listRoutingSamples(db, {
    featuresVersion: ROUTING_FEATURES_VERSION,
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })
  if (rows.length === 0) return { status: "no_samples", manifestSha256: active.manifestSha256 }

  const decisions = shadowDecisionsFor(
    rows,
    active.predictor,
    active.manifestSha256,
    actionCostTable(rows),
    { now: options.now }
  )
  const stored = await putShadowDecisions(db, decisions)
  return {
    status: "recorded",
    manifestSha256: active.manifestSha256,
    predictorVersion: active.predictor.version,
    stored,
    summary: shadowAgreementSummary(decisions),
  }
}
