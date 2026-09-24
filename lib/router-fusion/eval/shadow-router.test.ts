/**
 * shadow-router — the learned router predicts beside the rules router and never
 * acts (ADR-0188 D28, B6).
 *
 * The database-backed half runs on a real `FusionDB` (fake-indexeddb) with a
 * real published manifest trained by `runRoutingExperiment` over the
 * deterministic simulated sample set. The pure half uses a hand-written
 * `RoutingPredictor` so each branch (agreement, no opinion, out of
 * distribution, no head for the action that ran) is reached on purpose.
 *
 * The last block pins ROLE 7 dormancy (see `promotion.ts`): nothing on a
 * routing path imports `lib/router-fusion/eval/`, so an active manifest changes
 * no routing decision.
 */

import "fake-indexeddb/auto"

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { RoutingPredictor, RoutingPredictorManifest } from "@cognia/eval-core"

import { FusionDB } from "../db/fusion-db"
import type { FusionRoutingSampleRow, FusionShadowDecisionRow } from "../db/types"
import {
  actionCostTable,
  runRoutingExperiment,
  type ActionCostRow,
  type RoutingExperimentResult,
} from "./routing-experiment"
import { ROUTING_FEATURE_NAMES, ROUTING_FEATURES_VERSION, shadowIdFor } from "./routing-sample"
import {
  activatePredictorManifest,
  deactivatePredictor,
  putRoutingSamples,
  routingSampleExpiry,
  sealPredictorManifest,
} from "./routing-store"
import {
  activeShadowPredictor,
  recordShadowDecisions,
  shadowAgreementSummary,
  shadowDecisionsFor,
} from "./shadow-router"
import { SIMULATED_ACTIONS, simulatedRoutingSamples } from "./simulated-samples"

// ---------------------------------------------------------------------------
// Pure half: a hand-written predictor
// ---------------------------------------------------------------------------

const SHA = "c".repeat(64)
const OTHER_SHA = "d".repeat(64)
const HASH_ECONOMY = "1".repeat(64)
const HASH_PANEL = "2".repeat(64)
const HASH_UNPRICED = "3".repeat(64)
const HASH_HEADLESS = "4".repeat(64)
const WIDTH = ROUTING_FEATURE_NAMES.length

interface Opinion {
  pPass: number
  inDistribution: boolean
}

function fakePredictor(
  opinions: Record<string, Opinion>,
  calls: Array<{ actionId: string; actionHash: string; features: readonly number[] }> = []
): RoutingPredictor {
  return {
    version: "fake-predictor@1",
    manifestSha256: SHA,
    featuresVersion: ROUTING_FEATURES_VERSION,
    featureNames: ROUTING_FEATURE_NAMES,
    actionHashes: Object.keys(opinions),
    predict(action, features) {
      calls.push({ ...action, features })
      const opinion = opinions[action.actionHash]
      if (!opinion) return null
      return {
        actionId: action.actionId,
        actionHash: action.actionHash,
        pPass: opinion.pPass,
        rawProbability: opinion.pPass,
        supportCount: 40,
        inDistribution: opinion.inDistribution,
        predictorVersion: "fake-predictor@1",
      }
    },
  }
}

function cost(actionId: string, actionHash: string, meanCostMicrousd: number): ActionCostRow {
  return { actionId, actionHash, meanCostMicrousd, sampleCount: 5 }
}

/** Economy costs 1_000 / 0.5 = 2_000 per accepted run; panel 10_000 / 0.9 ≈ 11_111. */
const COSTS: ReadonlyMap<string, ActionCostRow> = new Map([
  [HASH_ECONOMY, cost("economy", HASH_ECONOMY, 1_000)],
  [HASH_PANEL, cost("panel", HASH_PANEL, 10_000)],
  [HASH_HEADLESS, cost("headless", HASH_HEADLESS, 500)],
])

const BOTH_IN_RANGE: Record<string, Opinion> = {
  [HASH_ECONOMY]: { pPass: 0.5, inDistribution: true },
  [HASH_PANEL]: { pPass: 0.9, inDistribution: true },
}

function sampleRow(
  overrides: Partial<FusionRoutingSampleRow> &
    Pick<FusionRoutingSampleRow, "sampleId" | "actionId" | "actionHash">
): FusionRoutingSampleRow {
  return {
    runId: `run-${overrides.sampleId}`,
    groupId: "group-1",
    mode: "direct",
    ruleId: null,
    baselineActionId: overrides.actionId,
    featuresVersion: ROUTING_FEATURES_VERSION,
    features: Array.from({ length: WIDTH }, (_, index) => (index === 0 ? 1 : 0)),
    propensity: 1,
    origin: "recorded",
    costMicrousd: 1_000,
    costStatus: "actual",
    accepted: true,
    qualityStatus: "accepted",
    runStatus: "succeeded",
    decidedAt: 1_000,
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  }
}

const NOW = Date.UTC(2026, 1, 1)

describe("shadowDecisionsFor", () => {
  it("records agreement when the predictor would have run the same action", () => {
    const row = sampleRow({ sampleId: "s-1", actionId: "economy", actionHash: HASH_ECONOMY })
    const [decision] = shadowDecisionsFor([row], fakePredictor(BOTH_IN_RANGE), SHA, COSTS, {
      now: NOW,
    })
    expect(decision).toEqual({
      shadowId: shadowIdFor("s-1", SHA),
      sampleId: "s-1",
      runId: "run-s-1",
      manifestSha256: SHA,
      predictorVersion: "fake-predictor@1",
      actualActionId: "economy",
      shadowActionId: "economy",
      shadowPPass: 0.5,
      actualPPass: 0.5,
      agreed: true,
      inDistribution: true,
      createdAt: NOW,
      expiresAt: routingSampleExpiry(NOW),
    })
  })

  it("records the cheaper-per-accepted choice and the p_pass of what really ran", () => {
    const row = sampleRow({ sampleId: "s-2", actionId: "panel", actionHash: HASH_PANEL })
    const calls: Array<{ actionId: string; actionHash: string; features: readonly number[] }> = []
    const [decision] = shadowDecisionsFor([row], fakePredictor(BOTH_IN_RANGE, calls), SHA, COSTS, {
      now: NOW,
    })
    expect(decision).toMatchObject({
      actualActionId: "panel",
      shadowActionId: "economy",
      shadowPPass: 0.5,
      actualPPass: 0.9,
      agreed: false,
      inDistribution: true,
    })
    // The action that ran is scored on the sample's own feature vector.
    expect(calls).toContainEqual({
      actionId: "panel",
      actionHash: HASH_PANEL,
      features: row.features,
    })
  })

  it("marks the decision out of distribution when the action that ran is outside its head's range", () => {
    const row = sampleRow({ sampleId: "s-3", actionId: "panel", actionHash: HASH_PANEL })
    const predictor = fakePredictor({
      [HASH_ECONOMY]: { pPass: 0.5, inDistribution: true },
      [HASH_PANEL]: { pPass: 0.9, inDistribution: false },
    })
    const [decision] = shadowDecisionsFor([row], predictor, SHA, COSTS, { now: NOW })
    expect(decision).toMatchObject({
      shadowActionId: "economy",
      actualPPass: 0.9,
      agreed: false,
      inDistribution: false,
    })
  })

  it("records no opinion when every head is out of range", () => {
    const row = sampleRow({ sampleId: "s-4", actionId: "economy", actionHash: HASH_ECONOMY })
    const predictor = fakePredictor({
      [HASH_ECONOMY]: { pPass: 0.5, inDistribution: false },
      [HASH_PANEL]: { pPass: 0.9, inDistribution: false },
    })
    const [decision] = shadowDecisionsFor([row], predictor, SHA, COSTS, { now: NOW })
    expect(decision).toMatchObject({
      shadowActionId: null,
      shadowPPass: null,
      actualPPass: 0.5,
      agreed: false,
      inDistribution: false,
    })
  })

  it("records no opinion when every head predicts certain failure", () => {
    const row = sampleRow({ sampleId: "s-5", actionId: "economy", actionHash: HASH_ECONOMY })
    const predictor = fakePredictor({
      [HASH_ECONOMY]: { pPass: 0, inDistribution: true },
      [HASH_PANEL]: { pPass: 0, inDistribution: true },
    })
    const [decision] = shadowDecisionsFor([row], predictor, SHA, COSTS, { now: NOW })
    expect(decision).toMatchObject({
      shadowActionId: null,
      shadowPPass: null,
      actualPPass: 0,
      agreed: false,
      inDistribution: false,
    })
  })

  it("has no actual p_pass for an action the cost table does not price", () => {
    const row = sampleRow({ sampleId: "s-6", actionId: "unpriced", actionHash: HASH_UNPRICED })
    const predictor = fakePredictor({
      ...BOTH_IN_RANGE,
      [HASH_UNPRICED]: { pPass: 0.99, inDistribution: true },
    })
    const [decision] = shadowDecisionsFor([row], predictor, SHA, COSTS, { now: NOW })
    expect(decision).toMatchObject({
      actualActionId: "unpriced",
      shadowActionId: "economy",
      actualPPass: null,
      agreed: false,
      inDistribution: false,
    })
  })

  it("has no actual p_pass for an action the predictor has no head for", () => {
    const row = sampleRow({ sampleId: "s-7", actionId: "headless", actionHash: HASH_HEADLESS })
    const [decision] = shadowDecisionsFor([row], fakePredictor(BOTH_IN_RANGE), SHA, COSTS, {
      now: NOW,
    })
    expect(decision).toMatchObject({
      actualActionId: "headless",
      shadowActionId: "economy",
      actualPPass: null,
      agreed: false,
      inDistribution: false,
    })
  })

  it("keys one shadow row per (sample, predictor), deterministically", () => {
    const rows = [
      sampleRow({ sampleId: "s-8", actionId: "economy", actionHash: HASH_ECONOMY }),
      sampleRow({ sampleId: "s-9", actionId: "panel", actionHash: HASH_PANEL }),
    ]
    const predictor = fakePredictor(BOTH_IN_RANGE)
    const once = shadowDecisionsFor(rows, predictor, SHA, COSTS, { now: NOW })
    const again = shadowDecisionsFor(rows, predictor, SHA, COSTS, { now: NOW + 1 })
    const other = shadowDecisionsFor(rows, predictor, OTHER_SHA, COSTS, { now: NOW })
    expect(once.map((row) => row.shadowId)).toEqual(again.map((row) => row.shadowId))
    expect(new Set(once.map((row) => row.shadowId)).size).toBe(2)
    for (const [index, row] of other.entries()) {
      expect(row.shadowId).not.toBe(once[index].shadowId)
      expect(row.manifestSha256).toBe(OTHER_SHA)
    }
  })

  it("maps an empty sample list to no decisions", () => {
    expect(shadowDecisionsFor([], fakePredictor(BOTH_IN_RANGE), SHA, COSTS, { now: NOW })).toEqual(
      []
    )
  })
})

function decisionRow(overrides: Partial<FusionShadowDecisionRow>): FusionShadowDecisionRow {
  return {
    shadowId: "shadow",
    sampleId: "sample",
    runId: "run",
    manifestSha256: SHA,
    predictorVersion: "fake-predictor@1",
    actualActionId: "economy",
    shadowActionId: "economy",
    shadowPPass: 0.5,
    actualPPass: 0.5,
    agreed: true,
    inDistribution: true,
    createdAt: NOW,
    expiresAt: NOW,
    ...overrides,
  }
}

describe("shadowAgreementSummary", () => {
  it("answers a null rate, not zero, when nothing was evaluated", () => {
    expect(shadowAgreementSummary([])).toEqual({
      evaluated: 0,
      agreed: 0,
      agreementRate: null,
      noOpinion: 0,
      outOfDistribution: 0,
      shadowActionCounts: {},
    })
  })

  it("counts agreement, missing opinions, out-of-distribution rows and the actions it would have run", () => {
    const summary = shadowAgreementSummary([
      decisionRow({ shadowId: "1" }),
      decisionRow({ shadowId: "2", actualActionId: "panel", agreed: false }),
      decisionRow({
        shadowId: "3",
        actualActionId: "panel",
        shadowActionId: "panel",
        shadowPPass: 0.9,
        actualPPass: 0.9,
      }),
      decisionRow({
        shadowId: "4",
        shadowActionId: null,
        shadowPPass: null,
        agreed: false,
        inDistribution: false,
      }),
    ])
    expect(summary).toEqual({
      evaluated: 4,
      agreed: 2,
      agreementRate: 0.5,
      noOpinion: 1,
      outOfDistribution: 1,
      // A missing opinion is not an action: there is no "null" bucket.
      shadowActionCounts: { economy: 2, panel: 1 },
    })
  })
})

// ---------------------------------------------------------------------------
// Database half: a real published manifest in a real registry
// ---------------------------------------------------------------------------

const CREATED_AT = "2026-02-01T00:00:00.000Z"

let samples: FusionRoutingSampleRow[]
let first: RoutingExperimentResult
let second: RoutingExperimentResult

function publishedOf(result: RoutingExperimentResult): RoutingPredictorManifest {
  if (!result.publishedManifest) throw new Error("fixture experiment published no manifest")
  return result.publishedManifest
}

beforeAll(async () => {
  samples = simulatedRoutingSamples({ seed: 1, sessionCount: 200 })
  first = await runRoutingExperiment(samples, { createdAt: CREATED_AT, seed: 1, iterations: 50 })
  second = await runRoutingExperiment(simulatedRoutingSamples({ seed: 3, sessionCount: 200 }), {
    createdAt: CREATED_AT,
    seed: 3,
    iterations: 50,
  })
})

let seq = 0
let db: FusionDB

beforeEach(() => {
  seq += 1
  db = new FusionDB(`shadow-router-test-${seq}`)
})

afterEach(async () => {
  await db.delete()
})

async function sealAndActivate(
  manifest: RoutingPredictorManifest,
  options: { body?: Record<string, unknown>; now?: number } = {}
): Promise<void> {
  await sealPredictorManifest(db, {
    manifestSha256: manifest.sha256,
    kind: "published",
    featuresVersion: ROUTING_FEATURES_VERSION,
    manifest: options.body ?? (manifest as unknown as Record<string, unknown>),
    label: "simulated",
    gateVerdict: null,
    gateReasons: [],
    now: options.now ?? 1_000,
  })
  await activatePredictorManifest(db, manifest.sha256, { now: options.now ?? 1_000 })
}

describe("activeShadowPredictor", () => {
  it("is null while no manifest is promoted", async () => {
    await expect(activeShadowPredictor(db)).resolves.toBeNull()
  })

  it("is null for a sealed manifest that was never activated", async () => {
    await sealPredictorManifest(db, {
      manifestSha256: publishedOf(first).sha256,
      kind: "published",
      featuresVersion: ROUTING_FEATURES_VERSION,
      manifest: publishedOf(first) as unknown as Record<string, unknown>,
      label: "simulated",
      gateVerdict: null,
      gateReasons: [],
      now: 1_000,
    })
    await expect(activeShadowPredictor(db)).resolves.toBeNull()
  })

  it("is null again once the learned router is switched off", async () => {
    await sealAndActivate(publishedOf(first))
    await deactivatePredictor(db, { now: 2_000 })
    await expect(activeShadowPredictor(db)).resolves.toBeNull()
  })

  it("loads the active manifest into a predictor over this build's encoding", async () => {
    const manifest = publishedOf(first)
    await sealAndActivate(manifest)
    const active = await activeShadowPredictor(db)
    expect(active).not.toBeNull()
    if (!active || "refused" in active) throw new Error("expected a loaded predictor")
    expect(active.manifestSha256).toBe(manifest.sha256)
    expect(active.predictor.manifestSha256).toBe(manifest.sha256)
    expect(active.predictor.version).toBe(`logistic-platt-1@${manifest.sha256.slice(0, 16)}`)
    expect(active.predictor.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
    expect([...active.predictor.featureNames]).toEqual([...ROUTING_FEATURE_NAMES])
    expect([...active.predictor.actionHashes].sort()).toEqual(
      manifest.heads.map((head) => head.actionHash).sort()
    )
  })

  it("refuses a manifest whose seal no longer verifies", async () => {
    const manifest = publishedOf(first)
    await sealAndActivate(manifest, {
      body: { ...manifest, createdAt: "2020-01-01T00:00:00.000Z" },
    })
    const active = await activeShadowPredictor(db)
    expect(active).toEqual({
      refused: expect.arrayContaining(["sha256 does not match the manifest content"]),
    })
  })

  it("refuses a manifest whose body encodes another feature version", async () => {
    const manifest = publishedOf(first)
    await sealAndActivate(manifest, {
      body: { ...manifest, featuresVersion: "router-fusion-features/0" },
    })
    const active = await activeShadowPredictor(db)
    expect(active).not.toBeNull()
    if (!active || !("refused" in active)) throw new Error("expected a refusal")
    expect(active.refused).toContain(
      `features version router-fusion-features/0 does not match the host's ${ROUTING_FEATURES_VERSION}`
    )
  })
})

describe("recordShadowDecisions", () => {
  it("does nothing while no learned router is active", async () => {
    await putRoutingSamples(db, samples)
    await expect(recordShadowDecisions(db, { now: NOW })).resolves.toEqual({
      status: "no_predictor",
    })
    expect(await db.fusionShadowDecisions.count()).toBe(0)
  })

  it("reports a refused predictor and records nothing from it", async () => {
    const manifest = publishedOf(first)
    await sealAndActivate(manifest, { body: { ...manifest, sampleCount: 1 } })
    await putRoutingSamples(db, samples)
    const outcome = await recordShadowDecisions(db, { now: NOW })
    expect(outcome.status).toBe("predictor_refused")
    if (outcome.status !== "predictor_refused") return
    expect(outcome.problems).toContain("sha256 does not match the manifest content")
    expect(await db.fusionShadowDecisions.count()).toBe(0)
  })

  it("answers no_samples when there is nothing to shadow", async () => {
    await sealAndActivate(publishedOf(first))
    await expect(recordShadowDecisions(db, { now: NOW })).resolves.toEqual({
      status: "no_samples",
      manifestSha256: publishedOf(first).sha256,
    })
  })

  it("ignores samples of another feature encoding", async () => {
    await sealAndActivate(publishedOf(first))
    await putRoutingSamples(
      db,
      samples.slice(0, 5).map((row) => ({ ...row, featuresVersion: "router-fusion-features/0" }))
    )
    await expect(recordShadowDecisions(db, { now: NOW })).resolves.toMatchObject({
      status: "no_samples",
    })
    expect(await db.fusionShadowDecisions.count()).toBe(0)
  })

  it("records one shadow decision per stored sample and summarizes them", async () => {
    const manifest = publishedOf(first)
    await sealAndActivate(manifest)
    await putRoutingSamples(db, samples)
    const outcome = await recordShadowDecisions(db, { now: NOW })
    expect(outcome).toMatchObject({
      status: "recorded",
      manifestSha256: manifest.sha256,
      predictorVersion: `logistic-platt-1@${manifest.sha256.slice(0, 16)}`,
      stored: samples.length,
    })
    if (outcome.status !== "recorded") return

    const stored = await db.fusionShadowDecisions.toArray()
    expect(stored).toHaveLength(samples.length)
    const bySample = new Map(samples.map((row) => [row.sampleId, row]))
    const actionIds = new Set(SIMULATED_ACTIONS.map((action) => action.actionId))
    for (const decision of stored) {
      const sample = bySample.get(decision.sampleId)
      expect(sample).toBeDefined()
      expect(decision.shadowId).toBe(shadowIdFor(decision.sampleId, manifest.sha256))
      expect(decision.runId).toBe(sample?.runId)
      expect(decision.actualActionId).toBe(sample?.actionId)
      expect(decision.manifestSha256).toBe(manifest.sha256)
      expect(decision.agreed).toBe(
        decision.shadowActionId !== null && decision.shadowActionId === decision.actualActionId
      )
      if (decision.shadowActionId !== null)
        expect(actionIds.has(decision.shadowActionId)).toBe(true)
      expect(decision.createdAt).toBe(NOW)
      expect(decision.expiresAt).toBe(routingSampleExpiry(NOW))
    }

    // The summary describes exactly what was stored.
    expect(outcome.summary).toEqual(shadowAgreementSummary(stored))
    expect(outcome.summary.evaluated).toBe(samples.length)
    // A trained predictor has an opinion on its own training distribution.
    expect(outcome.summary.noOpinion).toBeLessThan(samples.length)
    expect(outcome.summary.agreed).toBeGreaterThan(0)

    // The stored rows are what the pure step computes from the same rows and costs.
    const active = await activeShadowPredictor(db)
    if (!active || "refused" in active) throw new Error("expected a loaded predictor")
    const expected = shadowDecisionsFor(
      [...samples].sort((left, right) => left.sampleId.localeCompare(right.sampleId)),
      active.predictor,
      manifest.sha256,
      actionCostTable(samples),
      { now: NOW }
    )
    const sortById = (rows: FusionShadowDecisionRow[]) =>
      [...rows].sort((left, right) => left.shadowId.localeCompare(right.shadowId))
    expect(sortById(stored)).toEqual(sortById(expected))
  })

  it("is idempotent: a second pass rewrites the same rows", async () => {
    const subset = samples.slice(0, 60)
    await sealAndActivate(publishedOf(first))
    await putRoutingSamples(db, subset)
    await recordShadowDecisions(db, { now: NOW })
    const again = await recordShadowDecisions(db, { now: NOW + 60_000 })
    expect(again).toMatchObject({ status: "recorded", stored: subset.length })
    expect(await db.fusionShadowDecisions.count()).toBe(subset.length)
    const createdAt = new Set(
      (await db.fusionShadowDecisions.toArray()).map((row) => row.createdAt)
    )
    expect([...createdAt]).toEqual([NOW + 60_000])
  })

  it("keeps a separate row per predictor after another manifest is promoted", async () => {
    const subset = samples.slice(0, 40)
    await putRoutingSamples(db, subset)
    await sealAndActivate(publishedOf(first))
    await recordShadowDecisions(db, { now: NOW })
    await sealAndActivate(publishedOf(second), { now: 2_000 })
    const outcome = await recordShadowDecisions(db, { now: NOW + 1 })
    expect(outcome).toMatchObject({
      status: "recorded",
      manifestSha256: publishedOf(second).sha256,
      stored: subset.length,
    })
    expect(await db.fusionShadowDecisions.count()).toBe(subset.length * 2)
    expect(
      await db.fusionShadowDecisions
        .where("manifestSha256")
        .equals(publishedOf(first).sha256)
        .count()
    ).toBe(subset.length)
  })

  it("honours limit, taking samples in sampleId order", async () => {
    await sealAndActivate(publishedOf(first))
    await putRoutingSamples(db, samples)
    const outcome = await recordShadowDecisions(db, { now: NOW, limit: 10 })
    expect(outcome).toMatchObject({ status: "recorded", stored: 10 })
    const expectedIds = samples
      .map((row) => row.sampleId)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 10)
    const storedIds = (await db.fusionShadowDecisions.toArray()).map((row) => row.sampleId).sort()
    expect(storedIds).toEqual([...expectedIds].sort())
  })

  it("honours since, shadowing only samples decided at or after it", async () => {
    await sealAndActivate(publishedOf(first))
    await putRoutingSamples(db, samples)
    const times = samples.map((row) => row.decidedAt).sort((left, right) => left - right)
    const since = times[Math.floor(times.length / 2)]
    const eligible = samples.filter((row) => row.decidedAt >= since)
    const outcome = await recordShadowDecisions(db, { now: NOW, since })
    expect(outcome).toMatchObject({ status: "recorded", stored: eligible.length })
    expect(eligible.length).toBeLessThan(samples.length)
    const storedIds = new Set((await db.fusionShadowDecisions.toArray()).map((row) => row.sampleId))
    expect(storedIds).toEqual(new Set(eligible.map((row) => row.sampleId)))
  })
})

// ---------------------------------------------------------------------------
// ROLE 7 dormancy: the learned router only ever shadows
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "../../..")
const ROUTER_FUSION_DIR = path.join(REPO_ROOT, "lib/router-fusion")
const EVAL_DIR = path.join(ROUTER_FUSION_DIR, "eval")

/** Files a routed turn runs through, named explicitly so a rename fails loudly. */
const NAMED_ROUTING_PATH = [
  "lib/router-fusion/routing/run-route.ts",
  "lib/router-fusion/runtime/orchestrator-host.ts",
  "lib/router-fusion/host.ts",
  "lib/router-fusion/gate/chat-send.ts",
  // The chat send seam: every caller of `prepareRouterFusionSend`.
  "hooks/chat/use-claude-chat-controller.ts",
  "lib/claude/routing-fallback.ts",
  "lib/work-submission/stored-chat-dispatch.ts",
]
/** Every non-test module under these Router + Fusion directories is on a routing path. */
const ROUTING_PATH_DIRS = ["routing", "runtime", "chat", "gate"]

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function routingPathFiles(): string[] {
  const files = new Set(NAMED_ROUTING_PATH.map((file) => path.join(REPO_ROOT, file)))
  for (const dir of ROUTING_PATH_DIRS) {
    for (const file of sourceFilesUnder(path.join(ROUTER_FUSION_DIR, dir))) files.add(file)
  }
  return [...files].sort()
}

const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bjest\.mock\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(MODULE_SPECIFIER)].map((match) => match[1])
}

/** Does this import reach the learned-router engine? */
function reachesEval(fromFile: string, specifier: string): boolean {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(fromFile), specifier)
    return resolved === EVAL_DIR || resolved.startsWith(`${EVAL_DIR}${path.sep}`)
  }
  return (
    /(^|\/)lib\/router-fusion\/eval(\/|$)/.test(specifier) ||
    // The eval host seam dynamically loads the whole engine.
    specifier === "@/lib/ai/eval/routing-experiment"
  )
}

describe("the learned router never acts (ROLE 7 dormancy)", () => {
  it("detects every way a routing-path file could reach the engine", () => {
    const runRoute = path.join(ROUTER_FUSION_DIR, "routing/run-route.ts")
    expect(reachesEval(runRoute, "../eval/shadow-router")).toBe(true)
    expect(reachesEval(runRoute, "../eval")).toBe(true)
    expect(reachesEval(runRoute, "@/lib/router-fusion/eval/promotion")).toBe(true)
    expect(reachesEval(runRoute, "@/lib/ai/eval/routing-experiment")).toBe(true)
    expect(reachesEval(runRoute, "../gate/guard")).toBe(false)
    expect(reachesEval(runRoute, "@cognia/router-fusion")).toBe(false)
    expect(
      moduleSpecifiers(
        [
          'import { a } from "../eval/a"',
          'export { b } from "../eval/b"',
          'const c = await import("../eval/c")',
          'import "../eval/d"',
          "const e = require('../eval/e')",
        ].join("\n")
      )
    ).toEqual(["../eval/a", "../eval/b", "../eval/c", "../eval/d", "../eval/e"])
  })

  it("scans a routing path that really exists", () => {
    const files = routingPathFiles()
    // readFileSync throws for a renamed or deleted named file.
    for (const file of NAMED_ROUTING_PATH) {
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8").length).toBeGreaterThan(0)
    }
    expect(files.length).toBeGreaterThan(NAMED_ROUTING_PATH.length)
  })

  it("no routing-path module imports anything under lib/router-fusion/eval/", () => {
    const offenders: string[] = []
    for (const file of routingPathFiles()) {
      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (reachesEval(file, specifier)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("no routing-path module loads a learned predictor", () => {
    const offenders = routingPathFiles()
      .filter((file) => /\bloadRoutingPredictor\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file))
    expect(offenders).toEqual([])
  })
})
