/**
 * The learned router's lifecycle: train → seal → publish → load (ADR-0188
 * D12; DESIGN §7.2 "freeze features, action_hash, training data hash, slice
 * and calibration reports; no head is published when a class label is missing
 * or samples are insufficient; artifacts carry a manifest and a checksum").
 *
 *   trainRoutingPredictor   grouped time-shifted split (EVAL-01) → one
 *                           logistic head per action hash, fitted on training
 *                           groups only → Platt calibration on held-out
 *                           calibration groups only → test metrics → a
 *                           `training` manifest sealed with sha256.
 *   publishRoutingPredictor verifies the seal, WITHHOLDS every head that is not
 *                           calibrated or has no test evaluation (EVAL-02),
 *                           and seals a `published` manifest of the rest; with
 *                           no publishable head it refuses.
 *   loadRoutingPredictor    verifies a published manifest (seal, features
 *                           version, every head calibrated) and returns a
 *                           synchronous predictor for the routing path.
 *
 * The seal is sha256 (WebCrypto, browser and Node) over canonical JSON: keys
 * sorted, no whitespace, `undefined` members dropped, non-finite numbers
 * refused — byte-identical to `canonicalJson` in `@cognia/router-fusion`
 * (`util/sha256.ts`), which this zero-dependency package cannot import. Every
 * number in a manifest is the stored double, and JSON round-trips doubles
 * exactly, so a manifest verifies wherever it is loaded.
 */

import {
  groupedTimeSplit,
  type GroupedSample,
  type GroupedTimeSplit,
  type GroupedTimeSplitOptions,
} from "./grouped-split"
import {
  DEFAULT_LOGISTIC_OPTIONS,
  fitLogisticRegression,
  logisticLogit,
  logisticSigmoid,
  RoutingMathError,
  type LogisticDiagnostics,
  type LogisticModel,
} from "./logistic"
import {
  applyPlattCalibration,
  fitPlattCalibration,
  plattDataRefusals,
  probabilityMetrics,
  type PlattCalibration,
  type PlattRefusalReason,
  type ProbabilityMetrics,
} from "./platt"

export const ROUTING_PREDICTOR_SCHEMA = "cognia.routing-predictor/v1" as const
export const ROUTING_PREDICTOR_KIND = "logistic-platt-1" as const

/** One routed decision with its independent acceptance outcome. */
export interface RoutingTrainingSample extends GroupedSample {
  /** Unique id; samples are processed in `sampleId` order, whatever order they arrive in. */
  sampleId: string
  actionId: string
  /** The compiled action's hash; one head per hash, so a changed action gets a new head. */
  actionHash: string
  /** Encoded feature vector, in `featureNames` order. */
  features: readonly number[]
  /** Independent acceptance label (degraded / unknown / failed are false). */
  accepted: boolean
}

export interface RoutingTrainingPolicy {
  /** L2 strength on standardized coefficients (sklearn `1 / C`). */
  l2: number
  maxIterations: number
  tolerance: number
  standardize: boolean
  /** Minimum training rows of EACH class before a head is fitted. */
  minTrainingPerClass: number
  /** Minimum calibration rows of EACH class before a head is calibrated. */
  minCalibrationPerClass: number
  eceBins: number
  /**
   * A feature is in distribution within its training [min, max] widened by
   * this share of the range on each side; a feature that was constant in
   * training must match exactly.
   */
  oodMargin: number
}

export const DEFAULT_ROUTING_TRAINING_POLICY: RoutingTrainingPolicy = {
  l2: DEFAULT_LOGISTIC_OPTIONS.l2,
  maxIterations: DEFAULT_LOGISTIC_OPTIONS.maxIterations,
  tolerance: DEFAULT_LOGISTIC_OPTIONS.tolerance,
  standardize: DEFAULT_LOGISTIC_OPTIONS.standardize,
  minTrainingPerClass: 10,
  minCalibrationPerClass: 5,
  eceBins: 10,
  oodMargin: 0.1,
}

export interface TrainRoutingPredictorOptions {
  /** Version of the host's feature encoding; loading refuses any other. */
  featuresVersion: string
  featureNames: readonly string[]
  /** Frozen embedding model revision when the encoding includes one. */
  embeddingVersion?: string | null
  /** ISO timestamp recorded in the manifest (passed in, so training stays pure). */
  createdAt: string
  /** Seeds the calibration draw of the split. */
  seed: number
  split?: Omit<GroupedTimeSplitOptions, "seed">
  policy?: Partial<RoutingTrainingPolicy>
}

export type RoutingHeadWithheldReason =
  | "SINGLE_CLASS_TRAINING"
  | "INSUFFICIENT_TRAINING_DATA"
  | "NOT_CONVERGED"
  | "NO_CALIBRATION_DATA"
  | "CALIBRATION_NOT_INDEPENDENT"
  | "SINGLE_CLASS_CALIBRATION"
  | "INSUFFICIENT_CALIBRATION_DATA"
  | "CALIBRATION_NOT_CONVERGED"
  | "NON_POSITIVE_CALIBRATION_SLOPE"
  | "NO_TEST_DATA"

/** Every withholding reason, in report order. All but `NO_TEST_DATA` mean `calibrated: false`. */
export const ROUTING_HEAD_WITHHELD_REASONS: readonly RoutingHeadWithheldReason[] = [
  "SINGLE_CLASS_TRAINING",
  "INSUFFICIENT_TRAINING_DATA",
  "NOT_CONVERGED",
  "NO_CALIBRATION_DATA",
  "CALIBRATION_NOT_INDEPENDENT",
  "SINGLE_CLASS_CALIBRATION",
  "INSUFFICIENT_CALIBRATION_DATA",
  "CALIBRATION_NOT_CONVERGED",
  "NON_POSITIVE_CALIBRATION_SLOPE",
  "NO_TEST_DATA",
]

const PLATT_TO_HEAD_REASON: Record<PlattRefusalReason, RoutingHeadWithheldReason> = {
  NO_CALIBRATION_DATA: "NO_CALIBRATION_DATA",
  NOT_INDEPENDENT: "CALIBRATION_NOT_INDEPENDENT",
  SINGLE_CLASS: "SINGLE_CLASS_CALIBRATION",
  INSUFFICIENT_DATA: "INSUFFICIENT_CALIBRATION_DATA",
  NOT_CONVERGED: "CALIBRATION_NOT_CONVERGED",
  NON_POSITIVE_SLOPE: "NON_POSITIVE_CALIBRATION_SLOPE",
}

export interface RoutingClassCounts {
  samples: number
  positives: number
  negatives: number
}

export interface RoutingPredictorHead {
  actionId: string
  actionHash: string
  /** A converged head with an accepted Platt calibration on independent data. */
  calibrated: boolean
  /** Calibrated AND evaluated on the test window; only these are ever published. */
  publishable: boolean
  /** Empty exactly when `publishable`. */
  withheldReasons: RoutingHeadWithheldReason[]
  counts: {
    training: RoutingClassCounts
    calibration: RoutingClassCounts
    test: RoutingClassCounts
  }
  /** Null when the training data could not support a fit. */
  model: LogisticModel | null
  training: LogisticDiagnostics | null
  /** Present when a Platt fit ran; accepted only when `calibrated`. */
  calibration: PlattCalibration | null
  /** Training range per feature, for the in-distribution check. */
  featureRanges: { min: number[]; max: number[] } | null
  metrics: {
    /** Calibrated probabilities on the calibration split (in-sample for Platt). */
    calibration: ProbabilityMetrics | null
    /** The test window: the head alone, and after calibration. */
    test: { raw: ProbabilityMetrics; calibrated: ProbabilityMetrics | null } | null
  }
}

export interface RoutingSplitReport {
  strategy: "grouped-time-shifted"
  seed: number
  testFraction: number | null
  testStartsAt: number | null
  calibrationFraction: number
  partitions: Record<
    "train" | "calibration" | "test" | "excluded",
    { groups: number; samples: number }
  >
  /** sha256 of the sorted group-id list per partition — auditable without exposing session ids. */
  groupsSha256: Record<"train" | "calibration" | "test" | "excluded", string>
}

export interface WithheldRoutingHead {
  actionId: string
  actionHash: string
  reasons: RoutingHeadWithheldReason[]
}

export interface RoutingPredictorManifest {
  schema: typeof ROUTING_PREDICTOR_SCHEMA
  predictorKind: typeof ROUTING_PREDICTOR_KIND
  /** `training` holds every head; `published` only the publishable ones. */
  kind: "training" | "published"
  createdAt: string
  publishedAt: string | null
  /** The training manifest a published one was cut from. */
  sourceManifestSha256: string | null
  featuresVersion: string
  featureNames: string[]
  embeddingVersion: string | null
  /** sha256 over the canonical, sampleId-ordered training samples. */
  trainingDataSha256: string
  sampleCount: number
  split: RoutingSplitReport
  policy: RoutingTrainingPolicy
  heads: RoutingPredictorHead[]
  /** Heads left out at publication, with why. Always empty on a training manifest. */
  withheldHeads: WithheldRoutingHead[]
  /** sha256 over the canonical JSON of every other member. */
  sha256: string
}

export interface RoutingPredictorTraining<T extends RoutingTrainingSample> {
  manifest: RoutingPredictorManifest
  /** The split the manifest was trained on (samples in `sampleId` order within each partition). */
  split: GroupedTimeSplit<T>
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, `undefined` object members dropped (array holes become null),
 * non-finite numbers refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot encode a non-finite number")
    }
    if (value === undefined) {
      throw new TypeError("canonical JSON cannot encode undefined at the top level")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`
}

/** Lowercase hex sha256 of UTF-8 text via WebCrypto (browser, Node, WebView). */
export async function digestSha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("WebCrypto (crypto.subtle) is unavailable; a routing manifest cannot be sealed")
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text))
  let hex = ""
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/** The seal of a manifest: sha256 over its canonical JSON without the `sha256` member. */
export function routingManifestDigest(manifest: RoutingPredictorManifest): Promise<string> {
  return digestSha256Hex(canonicalJson({ ...manifest, sha256: undefined }))
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function resolvePolicy(overrides: Partial<RoutingTrainingPolicy> = {}): RoutingTrainingPolicy {
  const policy: RoutingTrainingPolicy = Object.assign(
    { ...DEFAULT_ROUTING_TRAINING_POLICY },
    Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  )
  const problems: string[] = []
  if (!(Number.isFinite(policy.l2) && policy.l2 >= 0)) problems.push("l2 must be >= 0")
  if (!isPositiveInteger(policy.maxIterations)) problems.push("maxIterations must be >= 1")
  if (!(Number.isFinite(policy.tolerance) && policy.tolerance > 0))
    problems.push("tolerance must be > 0")
  if (typeof policy.standardize !== "boolean") problems.push("standardize must be a boolean")
  if (!isPositiveInteger(policy.minTrainingPerClass))
    problems.push("minTrainingPerClass must be >= 1")
  if (!isPositiveInteger(policy.minCalibrationPerClass)) {
    problems.push("minCalibrationPerClass must be >= 1")
  }
  if (!isPositiveInteger(policy.eceBins)) problems.push("eceBins must be >= 1")
  if (!(Number.isFinite(policy.oodMargin) && policy.oodMargin >= 0))
    problems.push("oodMargin must be >= 0")
  if (problems.length > 0) {
    throw new RoutingMathError("INVALID_OPTION", `invalid training policy: ${problems.join("; ")}`)
  }
  return policy
}

function validateSamples(samples: readonly RoutingTrainingSample[], width: number): void {
  const ids = new Set<string>()
  const actionOfHash = new Map<string, string>()
  samples.forEach((sample, index) => {
    const where = `sample ${index}`
    if (typeof sample.sampleId !== "string" || sample.sampleId.length === 0) {
      throw new RoutingMathError("INVALID_SAMPLE", `${where} has no sampleId`)
    }
    if (ids.has(sample.sampleId)) {
      throw new RoutingMathError("DUPLICATE_ID", `sampleId ${sample.sampleId} appears twice`)
    }
    ids.add(sample.sampleId)
    if (typeof sample.actionId !== "string" || sample.actionId.length === 0) {
      throw new RoutingMathError("INVALID_SAMPLE", `${where} has no actionId`)
    }
    if (typeof sample.actionHash !== "string" || sample.actionHash.length === 0) {
      throw new RoutingMathError("INVALID_SAMPLE", `${where} has no actionHash`)
    }
    const knownAction = actionOfHash.get(sample.actionHash)
    if (knownAction !== undefined && knownAction !== sample.actionId) {
      throw new RoutingMathError(
        "INVALID_SAMPLE",
        `actionHash ${sample.actionHash} belongs to both ${knownAction} and ${sample.actionId}`
      )
    }
    actionOfHash.set(sample.actionHash, sample.actionId)
    if (typeof sample.accepted !== "boolean") {
      throw new RoutingMathError("INVALID_LABEL", `${where}: accepted must be a boolean`)
    }
    if (!Array.isArray(sample.features) || sample.features.length !== width) {
      throw new RoutingMathError(
        "DIMENSION_MISMATCH",
        `${where} has ${sample.features?.length ?? 0} features, expected ${width}`
      )
    }
    for (let j = 0; j < width; j++) {
      if (!Number.isFinite(sample.features[j])) {
        throw new RoutingMathError("NON_FINITE", `${where}: feature ${j} is not a finite number`)
      }
    }
  })
}

function classCounts(labels: readonly boolean[]): RoutingClassCounts {
  let positives = 0
  for (const label of labels) if (label) positives++
  return { samples: labels.length, positives, negatives: labels.length - positives }
}

function metricsOf(
  probabilities: readonly number[],
  labels: readonly boolean[],
  bins: number
): ProbabilityMetrics {
  const metrics = probabilityMetrics(probabilities, labels, { bins })
  if (!metrics) throw new RoutingMathError("EMPTY_SAMPLE", "metrics need at least one row")
  return metrics
}

function orderedReasons(reasons: Set<RoutingHeadWithheldReason>): RoutingHeadWithheldReason[] {
  return ROUTING_HEAD_WITHHELD_REASONS.filter((reason) => reasons.has(reason))
}

interface HeadBucket<T extends RoutingTrainingSample> {
  actionId: string
  actionHash: string
  train: T[]
  calibration: T[]
  test: T[]
}

function buildHead<T extends RoutingTrainingSample>(
  bucket: HeadBucket<T>,
  featureNames: string[],
  policy: RoutingTrainingPolicy
): RoutingPredictorHead {
  const reasons = new Set<RoutingHeadWithheldReason>()
  const trainLabels = bucket.train.map((sample) => sample.accepted)
  const trainCounts = classCounts(trainLabels)
  if (trainCounts.samples === 0) reasons.add("INSUFFICIENT_TRAINING_DATA")
  else if (trainCounts.positives === 0 || trainCounts.negatives === 0) {
    reasons.add("SINGLE_CLASS_TRAINING")
  } else if (Math.min(trainCounts.positives, trainCounts.negatives) < policy.minTrainingPerClass) {
    reasons.add("INSUFFICIENT_TRAINING_DATA")
  }

  let model: LogisticModel | null = null
  let training: LogisticDiagnostics | null = null
  if (reasons.size === 0) {
    const fit = fitLogisticRegression(
      bucket.train.map((sample) => sample.features),
      trainLabels,
      {
        l2: policy.l2,
        maxIterations: policy.maxIterations,
        tolerance: policy.tolerance,
        standardize: policy.standardize,
        featureNames,
      }
    )
    model = fit.model
    training = fit.diagnostics
    if (!fit.diagnostics.converged) reasons.add("NOT_CONVERGED")
  }

  const calibrationLabels = bucket.calibration.map((sample) => sample.accepted)
  const independence = {
    calibrationGroupIds: bucket.calibration.map((sample) => sample.groupId),
    fittingGroupIds: new Set(bucket.train.map((sample) => sample.groupId)),
  }
  let calibration: PlattCalibration | null = null
  let calibrated = false
  const head = model
  if (head && training?.converged) {
    const scores = bucket.calibration.map((sample) => logisticLogit(head, sample.features))
    const platt = fitPlattCalibration(scores, calibrationLabels, independence, {
      minPerClass: policy.minCalibrationPerClass,
    })
    calibration = platt.calibration
    if (platt.calibrated) calibrated = true
    else for (const reason of platt.reasons) reasons.add(PLATT_TO_HEAD_REASON[reason])
  } else {
    // No usable head, but the calibration data's own shortcomings still belong in the report.
    for (const reason of plattDataRefusals(calibrationLabels, independence, {
      minPerClass: policy.minCalibrationPerClass,
    })) {
      reasons.add(PLATT_TO_HEAD_REASON[reason])
    }
  }

  let calibrationMetrics: ProbabilityMetrics | null = null
  let testMetrics: RoutingPredictorHead["metrics"]["test"] = null
  const accepted = calibrated ? calibration : null
  if (head && accepted) {
    calibrationMetrics = metricsOf(
      bucket.calibration.map((sample) =>
        applyPlattCalibration(accepted, logisticLogit(head, sample.features))
      ),
      calibrationLabels,
      policy.eceBins
    )
  }
  if (bucket.test.length === 0) reasons.add("NO_TEST_DATA")
  else if (head) {
    const testLabels = bucket.test.map((sample) => sample.accepted)
    const logits = bucket.test.map((sample) => logisticLogit(head, sample.features))
    testMetrics = {
      raw: metricsOf(logits.map(logisticSigmoid), testLabels, policy.eceBins),
      calibrated: accepted
        ? metricsOf(
            logits.map((logit) => applyPlattCalibration(accepted, logit)),
            testLabels,
            policy.eceBins
          )
        : null,
    }
  }

  let featureRanges: RoutingPredictorHead["featureRanges"] = null
  if (bucket.train.length > 0) {
    const min = [...bucket.train[0].features]
    const max = [...bucket.train[0].features]
    for (const sample of bucket.train) {
      for (let j = 0; j < featureNames.length; j++) {
        if (sample.features[j] < min[j]) min[j] = sample.features[j]
        if (sample.features[j] > max[j]) max[j] = sample.features[j]
      }
    }
    featureRanges = { min, max }
  }

  const withheldReasons = orderedReasons(reasons)
  return {
    actionId: bucket.actionId,
    actionHash: bucket.actionHash,
    calibrated,
    publishable: calibrated && withheldReasons.length === 0,
    withheldReasons,
    counts: {
      training: trainCounts,
      calibration: classCounts(calibrationLabels),
      test: classCounts(bucket.test.map((sample) => sample.accepted)),
    },
    model,
    training,
    calibration,
    featureRanges,
    metrics: { calibration: calibrationMetrics, test: testMetrics },
  }
}

async function splitReport<T extends GroupedSample>(
  split: GroupedTimeSplit<T>
): Promise<RoutingSplitReport> {
  const partitions = ["train", "calibration", "test", "excluded"] as const
  const counts = {} as RoutingSplitReport["partitions"]
  const hashes = {} as RoutingSplitReport["groupsSha256"]
  for (const partition of partitions) {
    counts[partition] = { groups: split.groups[partition].length, samples: split[partition].length }
    hashes[partition] = await digestSha256Hex(canonicalJson(split.groups[partition]))
  }
  return {
    strategy: "grouped-time-shifted",
    seed: split.seed,
    testFraction: split.testFraction,
    testStartsAt: split.testStartsAt,
    calibrationFraction: split.calibrationFraction,
    partitions: counts,
    groupsSha256: hashes,
  }
}

async function seal(
  unsealed: Omit<RoutingPredictorManifest, "sha256">
): Promise<RoutingPredictorManifest> {
  const sha256 = await digestSha256Hex(canonicalJson(unsealed))
  return { ...unsealed, sha256 }
}

/**
 * Train one calibrated head per action hash and seal the result. Pure and
 * deterministic: the same samples (in any order), options and seed produce a
 * byte-identical manifest and the same sha256.
 */
export async function trainRoutingPredictor<T extends RoutingTrainingSample>(
  samples: readonly T[],
  options: TrainRoutingPredictorOptions
): Promise<RoutingPredictorTraining<T>> {
  if (typeof options.featuresVersion !== "string" || options.featuresVersion.length === 0) {
    throw new RoutingMathError("INVALID_OPTION", "featuresVersion is required")
  }
  const featureNames = [...options.featureNames]
  if (featureNames.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new RoutingMathError("INVALID_OPTION", "every feature needs a non-empty name")
  }
  if (new Set(featureNames).size !== featureNames.length) {
    throw new RoutingMathError("INVALID_OPTION", "featureNames must be unique")
  }
  if (typeof options.createdAt !== "string" || !Number.isFinite(Date.parse(options.createdAt))) {
    throw new RoutingMathError("INVALID_OPTION", "createdAt must be an ISO timestamp")
  }
  const embeddingVersion = options.embeddingVersion ?? null
  if (
    embeddingVersion !== null &&
    (typeof embeddingVersion !== "string" || embeddingVersion.length === 0)
  ) {
    throw new RoutingMathError(
      "INVALID_OPTION",
      "embeddingVersion must be a non-empty string or null"
    )
  }
  const policy = resolvePolicy(options.policy)
  validateSamples(samples, featureNames.length)

  const ordered = [...samples].sort((left, right) => compareStrings(left.sampleId, right.sampleId))
  const split = groupedTimeSplit(ordered, { ...options.split, seed: options.seed })

  const buckets = new Map<string, HeadBucket<T>>()
  for (const sample of ordered) {
    if (!buckets.has(sample.actionHash)) {
      buckets.set(sample.actionHash, {
        actionId: sample.actionId,
        actionHash: sample.actionHash,
        train: [],
        calibration: [],
        test: [],
      })
    }
  }
  for (const partition of ["train", "calibration", "test"] as const) {
    for (const sample of split[partition]) buckets.get(sample.actionHash)?.[partition].push(sample)
  }
  const heads = [...buckets.values()]
    .sort(
      (left, right) =>
        compareStrings(left.actionId, right.actionId) ||
        compareStrings(left.actionHash, right.actionHash)
    )
    .map((bucket) => buildHead(bucket, featureNames, policy))

  const trainingDataSha256 = await digestSha256Hex(
    canonicalJson(
      ordered.map((sample) => ({
        sampleId: sample.sampleId,
        groupId: sample.groupId,
        timestamp: sample.timestamp,
        actionId: sample.actionId,
        actionHash: sample.actionHash,
        features: [...sample.features],
        accepted: sample.accepted,
      }))
    )
  )

  const manifest = await seal({
    schema: ROUTING_PREDICTOR_SCHEMA,
    predictorKind: ROUTING_PREDICTOR_KIND,
    kind: "training",
    createdAt: options.createdAt,
    publishedAt: null,
    sourceManifestSha256: null,
    featuresVersion: options.featuresVersion,
    featureNames,
    embeddingVersion,
    trainingDataSha256,
    sampleCount: ordered.length,
    split: await splitReport(split),
    policy,
    heads,
    withheldHeads: [],
  })
  return { manifest, split }
}

const CALIBRATION_REASONS = new Set<RoutingHeadWithheldReason>(
  ROUTING_HEAD_WITHHELD_REASONS.filter((reason) => reason !== "NO_TEST_DATA")
)

function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function headProblems(head: RoutingPredictorHead, manifest: RoutingPredictorManifest): string[] {
  const problems: string[] = []
  const where = `head ${head.actionId}@${head.actionHash}`
  const reasons = Array.isArray(head.withheldReasons) ? head.withheldReasons : []
  if (!Array.isArray(head.withheldReasons)) problems.push(`${where}: withheldReasons is missing`)
  if (head.publishable !== (reasons.length === 0)) {
    problems.push(`${where}: publishable must hold exactly when nothing is withheld`)
  }
  if (head.publishable && !head.calibrated)
    problems.push(`${where}: publishable but not calibrated`)
  if (head.calibrated) {
    if (reasons.some((reason) => CALIBRATION_REASONS.has(reason))) {
      problems.push(`${where}: calibrated despite a calibration or training refusal`)
    }
    if (!head.model || !head.calibration || !head.featureRanges) {
      problems.push(`${where}: calibrated without a model, calibration and feature ranges`)
    } else {
      const width = manifest.featureNames.length
      if (!sameStrings(head.model.featureNames, manifest.featureNames)) {
        problems.push(`${where}: model features differ from the manifest`)
      }
      for (const [name, values] of [
        ["coefficients", head.model.coefficients],
        ["means", head.model.means],
        ["scales", head.model.scales],
        ["featureRanges.min", head.featureRanges.min],
        ["featureRanges.max", head.featureRanges.max],
      ] as const) {
        if (!Array.isArray(values) || values.length !== width) {
          problems.push(`${where}: ${name} must have ${width} entries`)
        }
      }
      if (!(head.calibration.slope > 0)) problems.push(`${where}: calibration slope must be > 0`)
    }
  } else if (!reasons.some((reason) => CALIBRATION_REASONS.has(reason))) {
    problems.push(`${where}: not calibrated but no training or calibration reason is recorded`)
  }
  return problems
}

/**
 * Structural and seal problems of a manifest; empty means it can be trusted.
 * Checks the schema, the sha256 seal, per-head invariants (a calibrated head
 * has a model, an accepted positive-slope calibration and matching feature
 * shapes; `publishable` ⇔ nothing withheld) and, for a published manifest,
 * that every head is publishable.
 */
export async function verifyRoutingPredictorManifest(
  manifest: RoutingPredictorManifest
): Promise<string[]> {
  if (!manifest || typeof manifest !== "object") return ["manifest is not an object"]
  const problems: string[] = []
  if (manifest.schema !== ROUTING_PREDICTOR_SCHEMA)
    problems.push(`unsupported schema ${String(manifest.schema)}`)
  if (manifest.predictorKind !== ROUTING_PREDICTOR_KIND) {
    problems.push(`unsupported predictor kind ${String(manifest.predictorKind)}`)
  }
  if (typeof manifest.sha256 !== "string") problems.push("manifest is not sealed")
  else {
    try {
      if ((await routingManifestDigest(manifest)) !== manifest.sha256) {
        problems.push("sha256 does not match the manifest content")
      }
    } catch (error) {
      problems.push(`manifest cannot be canonicalized: ${(error as Error).message}`)
    }
  }
  if (
    !Array.isArray(manifest.featureNames) ||
    new Set(manifest.featureNames).size !== manifest.featureNames.length
  ) {
    problems.push("featureNames must be a list of unique names")
  }
  if (!Array.isArray(manifest.heads)) return [...problems, "heads is missing"]
  const hashes = new Set<string>()
  for (const head of manifest.heads) {
    if (!head || typeof head !== "object") {
      problems.push("a head is not an object")
      continue
    }
    if (hashes.has(head.actionHash)) problems.push(`two heads share action hash ${head.actionHash}`)
    hashes.add(head.actionHash)
    if (Array.isArray(manifest.featureNames)) {
      try {
        problems.push(...headProblems(head, manifest))
      } catch (error) {
        problems.push(`head ${String(head.actionHash)} is malformed: ${(error as Error).message}`)
      }
    }
  }
  if (!Array.isArray(manifest.withheldHeads)) problems.push("withheldHeads is missing")
  if (manifest.kind === "published") {
    if (typeof manifest.publishedAt !== "string")
      problems.push("a published manifest needs publishedAt")
    if (typeof manifest.sourceManifestSha256 !== "string") {
      problems.push("a published manifest needs its source manifest sha256")
    }
    for (const head of manifest.heads) {
      if (!head?.publishable) {
        problems.push(
          `published manifest carries withheld head ${head.actionId}@${head.actionHash}`
        )
      }
    }
  } else if (manifest.kind === "training") {
    if (manifest.publishedAt !== null || manifest.sourceManifestSha256 !== null) {
      problems.push("a training manifest has no publication fields")
    }
    if (Array.isArray(manifest.withheldHeads) && manifest.withheldHeads.length > 0) {
      problems.push("a training manifest lists no withheld heads")
    }
  } else {
    problems.push(`unknown manifest kind ${String(manifest.kind)}`)
  }
  return problems
}

export type PublishRoutingPredictorResult =
  | {
      status: "published"
      manifest: RoutingPredictorManifest
      withheldHeads: WithheldRoutingHead[]
    }
  | {
      status: "refused"
      reason: "MANIFEST_INVALID" | "NOT_A_TRAINING_MANIFEST" | "NO_PUBLISHABLE_HEADS"
      problems: string[]
      withheldHeads: WithheldRoutingHead[]
    }

/**
 * Cut a published manifest from a verified training manifest. Every head that
 * is not calibrated (single class, no or dependent calibration data, …) or has
 * no test evaluation is withheld with its reasons (EVAL-02); when none is
 * left, publication is refused.
 */
export async function publishRoutingPredictor(
  manifest: RoutingPredictorManifest,
  options: { publishedAt: string }
): Promise<PublishRoutingPredictorResult> {
  if (
    typeof options.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(options.publishedAt))
  ) {
    throw new RoutingMathError("INVALID_OPTION", "publishedAt must be an ISO timestamp")
  }
  const problems = await verifyRoutingPredictorManifest(manifest)
  if (problems.length > 0) {
    return { status: "refused", reason: "MANIFEST_INVALID", problems, withheldHeads: [] }
  }
  if (manifest.kind !== "training") {
    return {
      status: "refused",
      reason: "NOT_A_TRAINING_MANIFEST",
      problems: ["only a training manifest can be published"],
      withheldHeads: [],
    }
  }
  const withheldHeads = manifest.heads
    .filter((head) => !head.publishable)
    .map((head) => ({
      actionId: head.actionId,
      actionHash: head.actionHash,
      reasons: [...head.withheldReasons],
    }))
  const heads = manifest.heads.filter((head) => head.publishable)
  if (heads.length === 0) {
    return {
      status: "refused",
      reason: "NO_PUBLISHABLE_HEADS",
      problems: ["no head is calibrated on independent data and evaluated on the test window"],
      withheldHeads,
    }
  }
  const { sha256: sourceManifestSha256, ...content } = manifest
  const published = await seal({
    ...content,
    kind: "published",
    publishedAt: options.publishedAt,
    sourceManifestSha256,
    heads,
    withheldHeads,
  })
  return { status: "published", manifest: published, withheldHeads }
}

export interface RoutingPredictionAction {
  actionId: string
  actionHash: string
}

export interface RoutingPrediction {
  actionId: string
  actionHash: string
  /** Calibrated probability that this action's result is accepted. */
  pPass: number
  /** The head's probability before calibration; a diagnostic, never a p_pass. */
  rawProbability: number
  /** Training rows behind the head. */
  supportCount: number
  inDistribution: boolean
  predictorVersion: string
}

export interface RoutingPredictor {
  /** `logistic-platt-1@<first 16 hex of the published sha256>`. */
  version: string
  manifestSha256: string
  featuresVersion: string
  featureNames: readonly string[]
  /** Action hashes this predictor has a calibrated head for. */
  actionHashes: readonly string[]
  /**
   * Null when there is no calibrated head for this exact action (unknown
   * hash, or the hash belongs to another action id). Throws on a feature
   * vector of the wrong width or with a non-finite value.
   */
  predict(action: RoutingPredictionAction, features: readonly number[]): RoutingPrediction | null
}

export type LoadRoutingPredictorResult =
  { status: "loaded"; predictor: RoutingPredictor } | { status: "refused"; problems: string[] }

/**
 * Verify a published manifest and build the synchronous predictor the router
 * calls per candidate. Refuses a training manifest, a broken seal, a head that
 * is not calibrated, and a features version (or feature list) that differs
 * from the host's current encoding.
 */
export async function loadRoutingPredictor(
  manifest: RoutingPredictorManifest,
  expected: { featuresVersion: string; featureNames?: readonly string[] }
): Promise<LoadRoutingPredictorResult> {
  let copy: RoutingPredictorManifest
  try {
    copy = JSON.parse(JSON.stringify(manifest)) as RoutingPredictorManifest
  } catch (error) {
    return { status: "refused", problems: [`manifest is not JSON: ${(error as Error).message}`] }
  }
  const problems = await verifyRoutingPredictorManifest(copy)
  if (copy.kind !== "published") problems.push("only a published manifest can be loaded")
  if (copy.featuresVersion !== expected.featuresVersion) {
    problems.push(
      `features version ${String(copy.featuresVersion)} does not match the host's ${expected.featuresVersion}`
    )
  }
  if (expected.featureNames && !sameStrings(copy.featureNames ?? [], expected.featureNames)) {
    problems.push("feature names differ from the host's encoding")
  }
  if (problems.length > 0) return { status: "refused", problems }

  const version = `${ROUTING_PREDICTOR_KIND}@${copy.sha256.slice(0, 16)}`
  const byHash = new Map(copy.heads.map((head) => [head.actionHash, head]))
  const margin = copy.policy.oodMargin
  return {
    status: "loaded",
    predictor: {
      version,
      manifestSha256: copy.sha256,
      featuresVersion: copy.featuresVersion,
      featureNames: [...copy.featureNames],
      actionHashes: copy.heads.map((head) => head.actionHash),
      predict(action, features) {
        const head = byHash.get(action.actionHash)
        if (!head || head.actionId !== action.actionId) return null
        const model = head.model as LogisticModel
        const calibration = head.calibration as PlattCalibration
        const ranges = head.featureRanges as { min: number[]; max: number[] }
        const logit = logisticLogit(model, features)
        let inDistribution = true
        for (let j = 0; j < features.length; j++) {
          const slack = margin * (ranges.max[j] - ranges.min[j])
          if (features[j] < ranges.min[j] - slack || features[j] > ranges.max[j] + slack) {
            inDistribution = false
            break
          }
        }
        return {
          actionId: head.actionId,
          actionHash: head.actionHash,
          pPass: applyPlattCalibration(calibration, logit),
          rawProbability: logisticSigmoid(logit),
          supportCount: head.counts.training.samples,
          inDistribution,
          predictorVersion: version,
        }
      },
    },
  }
}
