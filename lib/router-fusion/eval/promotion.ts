/**
 * Promotion and rollback of the learned router (ADR-0188 D12/D28, B6).
 *
 * Two guards stand in front of a promotion, and both are refusals rather than
 * warnings:
 *
 *  - **The grouped bootstrap must have passed.** Not "looked better" — passed:
 *    the upper bound of the cost-per-accepted delta below the threshold AND the
 *    lower bound of the pass-rate delta above the margin, on whole resampled
 *    groups. An inconclusive verdict promotes nothing, and a log with no
 *    randomization cannot produce a verdict at all.
 *  - **A simulated predictor is never promoted.** A manifest trained on
 *    generated samples has met no real request and spent no real money, so
 *    whatever its numbers say it may not be put in front of traffic (EVAL-04).
 *    The panel shows the refusal instead of hiding the button, because "this
 *    is a rehearsal" is the useful thing to tell someone looking at a green
 *    report.
 *
 * What promotion does is a pointer move inside the fusion database, which is
 * what makes rollback one click: the previous manifest is remembered on the row
 * that replaced it, and restoring it is the same transaction in reverse.
 *
 * ROLE 7 DORMANCY. An active manifest changes no routing decision today. The
 * router's `QualityPredictor` port exists (`action-router.ts`) but nothing wires
 * a learned predictor into `routing/run-route.ts` yet, so the learned router
 * only ever shadows. That is documented here, shown in the panel as "shadow
 * only", and pinned by `shadow-router.test.ts`.
 */

import type { RoutingPredictorManifest } from "@cognia/eval-core"

import type { FusionDB } from "../db/fusion-db"
import type { FusionPredictorManifestRow } from "../db/types"
import type { RoutingExperimentReport } from "./routing-experiment"
import {
  activatePredictorManifest,
  deactivatePredictor,
  rollbackPredictorManifest,
  sealPredictorManifest,
  type RoutingRegistryError,
} from "./routing-store"
import { ROUTING_FEATURES_VERSION } from "./routing-sample"

export type PromotionRefusal =
  "SIMULATED_REPORT" | "NO_PUBLISHED_MANIFEST" | "GATE_NOT_PASSED" | "FEATURES_VERSION_MISMATCH"

export interface PromotionDecision {
  allowed: boolean
  refusals: PromotionRefusal[]
}

/** May this report's predictor be put in front of traffic? */
export function routingPromotionDecision(report: RoutingExperimentReport): PromotionDecision {
  const refusals: PromotionRefusal[] = []
  if (report.label === "simulated") refusals.push("SIMULATED_REPORT")
  if (report.publication.status !== "published") refusals.push("NO_PUBLISHED_MANIFEST")
  if (!report.gate.passed) refusals.push("GATE_NOT_PASSED")
  if (report.featuresVersion !== ROUTING_FEATURES_VERSION) {
    refusals.push("FEATURES_VERSION_MISMATCH")
  }
  return { allowed: refusals.length === 0, refusals }
}

export type PromoteRoutingPredictorResult =
  | { status: "promoted"; row: FusionPredictorManifestRow }
  | { status: "refused"; refusals: PromotionRefusal[] }

export interface PromoteRoutingPredictorInput {
  report: RoutingExperimentReport
  /** The published manifest the report refers to; its sha256 must match. */
  manifest: RoutingPredictorManifest
  now: number
}

/**
 * Seal the published manifest into the registry and make it the active one.
 * Refuses, without writing anything, when the decision says no.
 */
export async function promoteRoutingPredictor(
  db: FusionDB,
  input: PromoteRoutingPredictorInput
): Promise<PromoteRoutingPredictorResult> {
  const decision = routingPromotionDecision(input.report)
  if (!decision.allowed) return { status: "refused", refusals: decision.refusals }
  if (
    input.report.publication.status !== "published" ||
    input.report.publication.manifestSha256 !== input.manifest.sha256
  ) {
    return { status: "refused", refusals: ["NO_PUBLISHED_MANIFEST"] }
  }
  await sealPredictorManifest(db, {
    manifestSha256: input.manifest.sha256,
    kind: "published",
    featuresVersion: input.manifest.featuresVersion,
    manifest: input.manifest as unknown as Record<string, unknown>,
    label: input.report.label,
    gateVerdict: input.report.gate.gate?.verdict ?? null,
    gateReasons: input.report.gate.gate?.reasons ?? input.report.gate.refusals,
    now: input.now,
  })
  const row = await activatePredictorManifest(db, input.manifest.sha256, {
    now: input.now,
    expectedFeaturesVersion: ROUTING_FEATURES_VERSION,
  })
  return { status: "promoted", row }
}

/**
 * Record a manifest without activating it — what a simulated or gate-refused
 * experiment leaves behind, so the run is auditable even though nothing was
 * promoted.
 */
export async function recordRoutingManifest(
  db: FusionDB,
  input: {
    manifest: RoutingPredictorManifest
    label: "live" | "simulated"
    gateVerdict: "pass" | "fail" | "inconclusive" | null
    gateReasons: readonly string[]
    now: number
  }
): Promise<FusionPredictorManifestRow> {
  return sealPredictorManifest(db, {
    manifestSha256: input.manifest.sha256,
    kind: input.manifest.kind,
    featuresVersion: input.manifest.featuresVersion,
    manifest: input.manifest as unknown as Record<string, unknown>,
    label: input.label,
    gateVerdict: input.gateVerdict,
    gateReasons: input.gateReasons,
    now: input.now,
  })
}

export type RollbackRoutingPredictorResult =
  | { status: "rolled_back"; row: FusionPredictorManifestRow }
  | { status: "deactivated"; row: FusionPredictorManifestRow | null }
  | { status: "refused"; code: RoutingRegistryError["code"]; message: string }

/**
 * One click back. When the active manifest replaced an earlier one, that one
 * becomes active again; when it was the first promotion there is nothing to
 * restore, so the learned router is switched off instead — which is the state
 * the user is asking for either way.
 */
export async function rollbackRoutingPredictor(
  db: FusionDB,
  options: { now: number }
): Promise<RollbackRoutingPredictorResult> {
  try {
    return { status: "rolled_back", row: await rollbackPredictorManifest(db, options) }
  } catch (error) {
    const registry = error as RoutingRegistryError
    if (registry?.name !== "RoutingRegistryError") throw error
    if (registry.code === "NO_ROLLBACK_TARGET") {
      return { status: "deactivated", row: await deactivatePredictor(db, options) }
    }
    return { status: "refused", code: registry.code, message: registry.message }
  }
}
