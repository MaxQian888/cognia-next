/**
 * The routing sample: one routed decision as the learned router sees it
 * (ADR-0188 D12/D28, B6).
 *
 * Pure, and text-free by construction. `encodeRoutingFeatures` turns the
 * router's categorical `RoutingFeatures` into a fixed-width numeric vector, and
 * everything downstream — the split, the logistic heads, the Platt calibration,
 * the export — sees only those numbers, the action, the money and the
 * acceptance label. Prompt text, answer text and the goal string itself never
 * leave this module: the goal contributes one number, its token estimate.
 *
 * The encoding is versioned. `ROUTING_FEATURES_VERSION` is written into every
 * manifest, and `loadRoutingPredictor` refuses a manifest whose version or
 * feature list differs from the host's — so changing this file's vector
 * invalidates every predictor trained on the old one instead of silently
 * feeding it a different meaning per column.
 */

import {
  estimateTokens,
  PHASES,
  TASK_KINDS,
  uuidFromName,
  type RouteDecision,
  type RoutingFeatures,
} from "@cognia/router-fusion"
import type { CostObservation, RoutingTrainingSample } from "@cognia/eval-core"

import type { FusionRoutingSampleRow } from "../db/types"

/** Bump on ANY change to the vector: names, order, scaling or clamps. */
export const ROUTING_FEATURES_VERSION = "router-fusion-features/1"

const AMBIGUITIES = ["low", "medium", "high", "unknown"] as const
const TOOL_NEEDS = ["none", "read_only", "sandbox_write", "external_write", "unknown"] as const
const SCOPES = ["single_item", "single_file", "multi_file", "cross_system", "unknown"] as const
/** `detectLanguage` answers exactly these three. */
const LANGUAGES = ["en", "zh", "und"] as const

/** Counts are clamped so one pathological request cannot dominate standardization. */
const COUNT_CAP = 10

function oneHotNames(prefix: string, values: readonly string[]): string[] {
  return values.map((value) => `${prefix}:${value}`)
}

/**
 * The columns of the feature vector, in order. Frozen together with
 * `ROUTING_FEATURES_VERSION`; a manifest carries this list and the loader
 * compares it name by name.
 */
export const ROUTING_FEATURE_NAMES: readonly string[] = [
  ...oneHotNames("task", TASK_KINDS),
  ...oneHotNames("phase", PHASES),
  ...oneHotNames("ambiguity", AMBIGUITIES),
  ...oneHotNames("tool_need", TOOL_NEEDS),
  ...oneHotNames("scope", SCOPES),
  ...oneHotNames("language", LANGUAGES),
  "failed_attempts",
  "missing_information_count",
  "verification_kinds_count",
  "context_truncated",
  "has_source_revision",
  "goal_tokens_log1p",
]

function oneHot(values: readonly string[], actual: string): number[] {
  return values.map((value) => (value === actual ? 1 : 0))
}

function clampCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(COUNT_CAP, Math.floor(value))
}

/**
 * The numeric vector for one request, in `ROUTING_FEATURE_NAMES` order.
 *
 * A value the router does not recognize (a label from a newer classifier, say)
 * one-hots to all zeros for its group rather than throwing: the vector stays
 * the declared width, and the head reads it as "none of the known values",
 * which is what an unseen label is.
 */
export function encodeRoutingFeatures(features: RoutingFeatures): number[] {
  const language = features.language.toLowerCase()
  const vector = [
    ...oneHot(TASK_KINDS, features.task),
    ...oneHot(PHASES, features.phase),
    ...oneHot(AMBIGUITIES, features.ambiguity),
    ...oneHot(TOOL_NEEDS, features.tool_need),
    ...oneHot(SCOPES, features.scope),
    ...oneHot(LANGUAGES, language),
    clampCount(features.failed_attempts),
    clampCount(features.missing_information.length),
    clampCount(features.verification_kinds.length),
    features.context_truncated ? 1 : 0,
    features.source_revision ? 1 : 0,
    Math.log1p(estimateTokens(features.goal)),
  ]
  if (vector.length !== ROUTING_FEATURE_NAMES.length) {
    throw new Error(
      `routing feature vector is ${vector.length} wide, expected ${ROUTING_FEATURE_NAMES.length}`
    )
  }
  return vector
}

/**
 * The probability the router selected `actionId` with.
 *
 * The rules router is deterministic: it evaluates the rule rows in order and
 * takes the first eligible candidate, so the action it chose was chosen with
 * probability 1 and every other candidate with 0. Recording it explicitly —
 * rather than assuming it downstream — is what lets a later stochastic policy
 * (an ε-greedy exploration arm, say) drop straight into the same sample
 * without every consumer having to learn a second convention.
 *
 * Null when the decision selected nothing at all: there is no sample to draw
 * from a run that was refused before any action was picked.
 */
export function rulesPropensity(decision: RouteDecision, actionId: string): number | null {
  if (decision.selected_action_id === null) return null
  return decision.selected_action_id === actionId ? 1 : 0
}

/** One row per (run, decision): collecting the same run twice updates, never duplicates. */
export function sampleIdFor(runId: string, decisionId: string): string {
  return uuidFromName(`router-fusion|routing-sample|${runId}|${decisionId}`)
}

/** One shadow decision per (sample, predictor). */
export function shadowIdFor(sampleId: string, manifestSha256: string): string {
  return uuidFromName(`router-fusion|shadow|${sampleId}|${manifestSha256}`)
}

/**
 * The independent acceptance label (EVAL-03).
 *
 * Accepted means the run succeeded AND its own result claimed
 * `quality_status: "accepted"`. A degraded answer, an unknown outcome, a
 * failure, a cancellation and an expiry are all not accepted — and every one of
 * them keeps its cost in the numerator.
 */
export function sampleAccepted(
  runStatus: string,
  qualityStatus: "accepted" | "degraded" | "unknown" | null
): boolean {
  return runStatus === "succeeded" && qualityStatus === "accepted"
}

/** The sample as the trainer reads it. */
export function toTrainingSample(row: FusionRoutingSampleRow): RoutingTrainingSample {
  return {
    sampleId: row.sampleId,
    groupId: row.groupId,
    timestamp: row.decidedAt,
    actionId: row.actionId,
    actionHash: row.actionHash,
    features: row.features,
    accepted: row.accepted,
  }
}

/** The sample as the accepted-cost metric reads it (EVAL-03). */
export function toCostObservation(row: FusionRoutingSampleRow): CostObservation {
  return { costMicrousd: row.costMicrousd, accepted: row.accepted }
}

/**
 * Refuse a sample set that mixes recorded and simulated rows.
 *
 * A report is either live or simulated, never a blend whose numbers could be
 * read as the other (EVAL-04, and the same rule the live smoke applies to its
 * own run). Returns the single label, or throws.
 */
export function sampleSetLabel(
  rows: readonly FusionRoutingSampleRow[]
): "live" | "simulated" | null {
  if (rows.length === 0) return null
  const origins = new Set(rows.map((row) => row.origin))
  if (origins.size > 1) {
    throw new Error(
      "routing sample set mixes recorded and simulated rows; a report is either live or simulated"
    )
  }
  return origins.has("simulated") ? "simulated" : "live"
}

export const ROUTING_SAMPLE_EXPORT_SCHEMA = "cognia.routing-samples/v1" as const

export interface RoutingSampleExport {
  schema: typeof ROUTING_SAMPLE_EXPORT_SCHEMA
  featuresVersion: string
  featureNames: string[]
  /** `simulated` when the rows came from the fake generator; `live` for recorded traffic. */
  label: "live" | "simulated"
  exportedAt: string
  sampleCount: number
  rows: RoutingSampleExportRow[]
}

export interface RoutingSampleExportRow {
  sampleId: string
  groupId: string
  decidedAt: number
  actionId: string
  actionHash: string
  mode: string
  ruleId: string | null
  /** The action the deterministic rules policy would have chosen. */
  baselineActionId: string
  features: number[]
  /** The router's selection probability for the action that ran. */
  propensity: number
  costMicrousd: number
  costStatus: string
  accepted: boolean
  qualityStatus: string | null
  runStatus: string
}

/**
 * The export a trainer or a notebook reads (WP-F2 step 4).
 *
 * Every row carries its propensity, because a sample drawn by a policy is not
 * a sample drawn at random: without the probability the action was chosen with,
 * an off-policy estimate of what a different router would have cost is not
 * identifiable. Ids of the run, the session and the account are NOT in the
 * export — the group id is a stable opaque key, and nothing else leaves.
 */
export function buildRoutingSampleExport(
  rows: readonly FusionRoutingSampleRow[],
  options: { exportedAt: string }
): RoutingSampleExport {
  const label = sampleSetLabel(rows) ?? "simulated"
  const ordered = [...rows].sort((left, right) => left.sampleId.localeCompare(right.sampleId))
  const versions = new Set(ordered.map((row) => row.featuresVersion))
  if (versions.size > 1) {
    throw new Error(
      `routing sample set spans feature versions ${[...versions].sort().join(", ")}; train on one encoding`
    )
  }
  return {
    schema: ROUTING_SAMPLE_EXPORT_SCHEMA,
    featuresVersion: [...versions][0] ?? ROUTING_FEATURES_VERSION,
    featureNames: [...ROUTING_FEATURE_NAMES],
    label,
    exportedAt: options.exportedAt,
    sampleCount: ordered.length,
    rows: ordered.map((row) => ({
      sampleId: row.sampleId,
      groupId: row.groupId,
      decidedAt: row.decidedAt,
      actionId: row.actionId,
      actionHash: row.actionHash,
      mode: row.mode,
      ruleId: row.ruleId,
      baselineActionId: row.baselineActionId,
      features: [...row.features],
      propensity: row.propensity,
      costMicrousd: row.costMicrousd,
      costStatus: row.costStatus,
      accepted: row.accepted,
      qualityStatus: row.qualityStatus,
      runStatus: row.runStatus,
    })),
  }
}

const MODES = new Set(["direct", "cascade", "panel", "delegate"])
const COST_STATUSES = new Set(["actual", "estimated", "pending"])
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "reconciling",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
])
const QUALITY_STATUSES = new Set(["accepted", "degraded", "unknown"])

function field(row: Record<string, unknown>, name: string, index: number): unknown {
  if (!(name in row)) throw new Error(`routing sample ${index} has no ${name}`)
  return row[name]
}

function stringField(row: Record<string, unknown>, name: string, index: number): string {
  const value = field(row, name, index)
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`routing sample ${index}: ${name} must be a non-empty string`)
  }
  return value
}

function numberField(row: Record<string, unknown>, name: string, index: number): number {
  const value = field(row, name, index)
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`routing sample ${index}: ${name} must be a finite number`)
  }
  return value
}

/**
 * Read an export back into rows, refusing anything it cannot vouch for.
 *
 * Strict on purpose: this is the door a file off disk comes through, and a
 * sample set is the thing a promotion decision is made from. A wrong feature
 * width, a propensity outside (0, 1], a negative or fractional cost, an
 * unknown mode — each is a refusal naming the row, never a silently dropped or
 * defaulted value.
 */
export function parseRoutingSampleExport(
  value: unknown,
  options: { now: number; expiresAt?: number }
): FusionRoutingSampleRow[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("routing sample export must be an object")
  }
  const document = value as Partial<RoutingSampleExport>
  if (document.schema !== ROUTING_SAMPLE_EXPORT_SCHEMA) {
    throw new Error(
      `routing sample export schema must be ${ROUTING_SAMPLE_EXPORT_SCHEMA}, got ${String(document.schema)}`
    )
  }
  if (typeof document.featuresVersion !== "string" || document.featuresVersion.length === 0) {
    throw new Error("routing sample export names no features version")
  }
  if (document.label !== "live" && document.label !== "simulated") {
    throw new Error(
      `routing sample export label must be live or simulated, got ${String(document.label)}`
    )
  }
  if (!Array.isArray(document.rows)) throw new Error("routing sample export carries no rows")
  const width = Array.isArray(document.featureNames)
    ? document.featureNames.length
    : ROUTING_FEATURE_NAMES.length
  const origin = document.label === "simulated" ? "simulated" : "recorded"
  const expiresAt = options.expiresAt ?? options.now

  return document.rows.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`routing sample ${index} is not an object`)
    }
    const row = raw as unknown as Record<string, unknown>
    const features = field(row, "features", index)
    if (!Array.isArray(features) || features.length !== width) {
      throw new Error(`routing sample ${index}: features must be ${width} numbers`)
    }
    for (const entry of features) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        throw new Error(`routing sample ${index}: every feature must be a finite number`)
      }
    }
    const propensity = numberField(row, "propensity", index)
    if (!(propensity > 0 && propensity <= 1)) {
      throw new Error(
        `routing sample ${index}: propensity must be within (0, 1], got ${propensity}`
      )
    }
    const costMicrousd = numberField(row, "costMicrousd", index)
    if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) {
      throw new Error(
        `routing sample ${index}: cost must be a non-negative integer microusd, got ${costMicrousd}`
      )
    }
    const accepted = field(row, "accepted", index)
    if (typeof accepted !== "boolean") {
      throw new Error(`routing sample ${index}: accepted must be a boolean`)
    }
    const mode = stringField(row, "mode", index)
    if (!MODES.has(mode)) throw new Error(`routing sample ${index}: unknown mode ${mode}`)
    const costStatus = stringField(row, "costStatus", index)
    if (!COST_STATUSES.has(costStatus)) {
      throw new Error(`routing sample ${index}: unknown cost status ${costStatus}`)
    }
    const runStatus = stringField(row, "runStatus", index)
    if (!RUN_STATUSES.has(runStatus)) {
      throw new Error(`routing sample ${index}: unknown run status ${runStatus}`)
    }
    const quality = row.qualityStatus
    if (quality !== null && quality !== undefined && !QUALITY_STATUSES.has(String(quality))) {
      throw new Error(`routing sample ${index}: unknown quality status ${String(quality)}`)
    }
    const ruleId = row.ruleId
    if (ruleId !== null && ruleId !== undefined && typeof ruleId !== "string") {
      throw new Error(`routing sample ${index}: ruleId must be a string or null`)
    }
    return {
      sampleId: stringField(row, "sampleId", index),
      // The export carries no run id — it is an internal identifier and the
      // sample id already keys the row. Reusing it keeps the shape total.
      runId: stringField(row, "sampleId", index),
      groupId: stringField(row, "groupId", index),
      actionId: stringField(row, "actionId", index),
      actionHash: stringField(row, "actionHash", index),
      mode: mode as FusionRoutingSampleRow["mode"],
      ruleId: typeof ruleId === "string" ? ruleId : null,
      baselineActionId: stringField(row, "baselineActionId", index),
      featuresVersion: document.featuresVersion as string,
      features: features as number[],
      propensity,
      origin,
      costMicrousd,
      costStatus: costStatus as FusionRoutingSampleRow["costStatus"],
      accepted,
      qualityStatus:
        typeof quality === "string" ? (quality as FusionRoutingSampleRow["qualityStatus"]) : null,
      runStatus: runStatus as FusionRoutingSampleRow["runStatus"],
      decidedAt: numberField(row, "decidedAt", index),
      createdAt: options.now,
      expiresAt,
    }
  })
}
