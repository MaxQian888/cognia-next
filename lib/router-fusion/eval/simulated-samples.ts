/**
 * The simulated routing sample set (ADR-0188 B6, EVAL-04).
 *
 * `cognia eval routing --fake` and the panel's "simulated run" need a sample
 * set that is large and varied enough to actually train, calibrate and gate a
 * predictor — otherwise the offline path proves nothing about the code that
 * will run on real traffic. This generator produces one deterministically from
 * a seed: the same seed gives byte-identical rows, on any machine, with no
 * network and no provider.
 *
 * Every row it produces carries `origin: "simulated"`, which is not decoration.
 * `sampleSetLabel` refuses a set that mixes origins, the report built from a
 * simulated set is labelled `simulated` and states that it makes no claim about
 * quality or saving, and a manifest sealed from one is labelled the same way,
 * so a simulated predictor can never be mistaken for evidence about the real
 * router.
 *
 * The latent model behind the labels is deliberately simple and deliberately
 * NOT the model being fitted: acceptance is a logistic function of a few of the
 * encoded features plus a per-action offset, so the heads have something real
 * to find, the classes are both present, and nothing in the generator tells the
 * trainer where to look.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  FEATURE_VERSION,
  PHASES,
  sha256Hex,
  TASK_KINDS,
  uuidFromName,
  type ExecutionMode,
  type RoutingFeatures,
} from "@cognia/router-fusion"
import { createSeededRandom, logisticSigmoid } from "@cognia/eval-core"

import type { FusionRoutingSampleRow } from "../db/types"
import { encodeRoutingFeatures, ROUTING_FEATURES_VERSION } from "./routing-sample"
import { routingSampleExpiry } from "./routing-store"

export interface SimulatedAction {
  actionId: string
  actionHash: string
  mode: ExecutionMode
  ruleId: string
  /** Typical spend of one run of this action, integer microusd. */
  baseCostMicrousd: number
  /** Added to the latent acceptance log-odds: a costlier action is a better one. */
  qualityOffset: number
}

/**
 * Three actions, one per rule row the build wires today. The hashes are derived
 * from the ids so a simulated manifest's head keys look like the real thing and
 * can never collide with a compiled action's hash.
 */
export const SIMULATED_ACTIONS: readonly SimulatedAction[] = [
  {
    actionId: "direct_economy",
    actionHash: sha256Hex("simulated-action|direct_economy"),
    mode: "direct",
    ruleId: "R2_economy_simple",
    baseCostMicrousd: 1_200,
    qualityOffset: -0.6,
  },
  {
    actionId: "cascade_schema",
    actionHash: sha256Hex("simulated-action|cascade_schema"),
    mode: "cascade",
    ruleId: "R3_cascade_verifiable",
    baseCostMicrousd: 5_400,
    qualityOffset: 0.35,
  },
  {
    actionId: "panel_review",
    actionHash: sha256Hex("simulated-action|panel_review"),
    mode: "panel",
    ruleId: "R4_panel_research",
    baseCostMicrousd: 14_800,
    qualityOffset: 0.9,
  },
]

const AMBIGUITIES = ["low", "medium", "high", "unknown"] as const
const TOOL_NEEDS = ["none", "read_only", "sandbox_write", "external_write", "unknown"] as const
const SCOPES = ["single_item", "single_file", "multi_file", "cross_system", "unknown"] as const
const LANGUAGES = ["en", "zh"] as const

/** Difficulty each label adds to the latent log-odds; higher means harder to accept. */
const AMBIGUITY_PENALTY: Record<(typeof AMBIGUITIES)[number], number> = {
  low: 0,
  medium: 0.5,
  high: 1.1,
  unknown: 0.8,
}
const SCOPE_PENALTY: Record<(typeof SCOPES)[number], number> = {
  single_item: 0,
  single_file: 0.2,
  multi_file: 0.7,
  cross_system: 1.2,
  unknown: 0.6,
}

export interface SimulatedSampleOptions {
  seed: number
  /** Conversations to generate; each contributes two to four turns. */
  sessionCount?: number
  /** Epoch millisecond the first session was decided at. */
  startedAt?: number
  /** Spacing between sessions; the time axis the split shifts along. */
  sessionSpacingMs?: number
  /**
   * Share of sessions logged by a RANDOMIZED policy instead of the rules
   * router: each of their turns draws its action uniformly, with propensity
   * 1/|actions|.
   *
   * This is the difference between a promotion gate that can decide and one
   * that can only refuse. A replay comparison of two policies on a log is
   * identifiable exactly when the log carries randomization; with every sample
   * logged deterministically, both arms collapse onto the same rows and the
   * gate answers `DETERMINISTIC_LOGGING` instead of a verdict. The simulated
   * set therefore contains an exploration slice, which is also what real
   * traffic will need before anything is promoted on its evidence.
   */
  explorationRate?: number
  /** `createdAt` / `expiresAt` of the produced rows. */
  now?: number
}

export const DEFAULT_SIMULATED_SAMPLE_OPTIONS = {
  sessionCount: 200,
  sessionSpacingMs: 15 * 60_000,
  explorationRate: 0.5,
  /** 2026-01-01T00:00:00Z — fixed, so a default run is reproducible to the millisecond. */
  startedAt: Date.UTC(2026, 0, 1),
} as const

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))]
}

function simulatedFeatures(random: () => number): RoutingFeatures {
  const ambiguity = pick(random, AMBIGUITIES)
  const scope = pick(random, SCOPES)
  const toolNeed = pick(random, TOOL_NEEDS)
  const failedAttempts = random() < 0.15 ? 1 + Math.floor(random() * 2) : 0
  const verificationKinds = random() < 0.4 ? ["json_schema"] : []
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    // A synthetic goal of a plausible length: only its token estimate is
    // encoded, and no simulated row ever reaches a model.
    goal: "simulated routing request ".repeat(1 + Math.floor(random() * 6)).trim(),
    task: pick(random, TASK_KINDS),
    phase: pick(random, PHASES),
    language: pick(random, LANGUAGES),
    missing_information: random() < 0.1 ? ["scope"] : [],
    ambiguity,
    tool_need: toolNeed,
    scope,
    failed_attempts: failedAttempts,
    verification_kinds: verificationKinds,
    source_revision: random() < 0.3 ? "rev-simulated" : null,
    feature_version: FEATURE_VERSION,
    context_truncated: random() < 0.08,
  }
}

/** The latent acceptance probability. Not the model being fitted — the thing it has to find. */
function acceptanceProbability(features: RoutingFeatures, action: SimulatedAction): number {
  const logOdds =
    0.55 +
    action.qualityOffset -
    AMBIGUITY_PENALTY[features.ambiguity as (typeof AMBIGUITIES)[number]] -
    SCOPE_PENALTY[features.scope as (typeof SCOPES)[number]] -
    0.35 * features.failed_attempts -
    (features.context_truncated ? 0.6 : 0) +
    (features.verification_kinds.length > 0 ? 0.3 : 0)
  return logisticSigmoid(logOdds)
}

/**
 * A deterministic simulated sample set. The same seed and options always give
 * the same rows, in `sampleId` order.
 */
export function simulatedRoutingSamples(options: SimulatedSampleOptions): FusionRoutingSampleRow[] {
  if (!Number.isInteger(options.seed)) {
    throw new Error(`simulated routing samples need an integer seed, got ${options.seed}`)
  }
  const sessionCount = options.sessionCount ?? DEFAULT_SIMULATED_SAMPLE_OPTIONS.sessionCount
  if (!Number.isInteger(sessionCount) || sessionCount < 1) {
    throw new Error(`sessionCount must be a positive integer, got ${sessionCount}`)
  }
  const spacing = options.sessionSpacingMs ?? DEFAULT_SIMULATED_SAMPLE_OPTIONS.sessionSpacingMs
  const startedAt = options.startedAt ?? DEFAULT_SIMULATED_SAMPLE_OPTIONS.startedAt
  const explorationRate =
    options.explorationRate ?? DEFAULT_SIMULATED_SAMPLE_OPTIONS.explorationRate
  if (!(explorationRate >= 0 && explorationRate <= 1)) {
    throw new Error(`explorationRate must be within [0, 1], got ${explorationRate}`)
  }
  const now = options.now ?? startedAt + sessionCount * spacing
  const random = createSeededRandom(options.seed)
  const rows: FusionRoutingSampleRow[] = []

  for (let session = 0; session < sessionCount; session += 1) {
    // The rules policy is deterministic per request; the session's topic is
    // what decides it, so every turn of a session shares one baseline action.
    const baseline = SIMULATED_ACTIONS[session % SIMULATED_ACTIONS.length]
    const groupId = uuidFromName(`simulated-session|${options.seed}|${session}`)
    const exploring = random() < explorationRate
    const turns = 2 + Math.floor(random() * 3)
    for (let turn = 0; turn < turns; turn += 1) {
      const action = exploring ? pick(random, SIMULATED_ACTIONS) : baseline
      const features = simulatedFeatures(random)
      const accepted = random() < acceptanceProbability(features, action)
      const decidedAt = startedAt + session * spacing + turn * 45_000
      const runId = uuidFromName(`simulated-run|${options.seed}|${session}|${turn}`)
      const jitter = 0.7 + random() * 0.6
      rows.push({
        sampleId: uuidFromName(`simulated-sample|${options.seed}|${session}|${turn}`),
        runId,
        groupId,
        actionId: action.actionId,
        actionHash: action.actionHash,
        mode: action.mode,
        ruleId: action.ruleId,
        baselineActionId: baseline.actionId,
        featuresVersion: ROUTING_FEATURES_VERSION,
        features: encodeRoutingFeatures(features),
        // The rules router is deterministic: the action it took was taken with
        // probability 1. An exploration turn drew uniformly over the catalog.
        propensity: exploring ? 1 / SIMULATED_ACTIONS.length : 1,
        origin: "simulated",
        costMicrousd: Math.round(action.baseCostMicrousd * jitter),
        costStatus: "actual",
        accepted,
        qualityStatus: accepted ? "accepted" : "degraded",
        runStatus: "succeeded",
        decidedAt,
        createdAt: now,
        expiresAt: routingSampleExpiry(now),
      })
    }
  }
  rows.sort((left, right) => left.sampleId.localeCompare(right.sampleId))
  return rows
}
