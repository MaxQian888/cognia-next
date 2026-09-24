/**
 * routing-experiment — accepted cost (EVAL-03), the learned routing choice,
 * the replay promotion gate and the end-to-end experiment report (EVAL-04).
 */

import {
  acceptedCost,
  createSeededRandom,
  loadRoutingPredictor,
  type RoutingPrediction,
  type RoutingPredictionAction,
  type RoutingPredictor,
} from "@cognia/eval-core"
import { fixtureFeatures } from "@cognia/router-fusion"

import type { FusionRoutingSampleRow } from "../db/types"
import {
  actionCostTable,
  learnedRoutingChoice,
  LIVE_ROUTING_DISCLAIMER,
  replayPromotionObservations,
  ROUTING_EXPERIMENT_SCHEMA,
  routingDisclaimerFor,
  routingPromotionGate,
  runRoutingExperiment,
  SIMULATED_ROUTING_DISCLAIMER,
  type ActionCostRow,
} from "./routing-experiment"
import {
  encodeRoutingFeatures,
  ROUTING_FEATURE_NAMES,
  ROUTING_FEATURES_VERSION,
} from "./routing-sample"
import { SIMULATED_ACTIONS, simulatedRoutingSamples } from "./simulated-samples"

const CREATED_AT = "2026-09-25T00:00:00.000Z"
const START = Date.UTC(2026, 0, 1)
const LOW = encodeRoutingFeatures(fixtureFeatures({ ambiguity: "low" }))
const HIGH = encodeRoutingFeatures(fixtureFeatures({ ambiguity: "high" }))

function row(sampleId: string, overrides: Partial<FusionRoutingSampleRow> = {}) {
  const sample: FusionRoutingSampleRow = {
    sampleId,
    runId: `run-${sampleId}`,
    groupId: `group-${sampleId}`,
    actionId: "pricey",
    actionHash: "hash-pricey",
    mode: "panel",
    ruleId: null,
    baselineActionId: "pricey",
    featuresVersion: ROUTING_FEATURES_VERSION,
    features: LOW,
    propensity: 0.5,
    origin: "recorded",
    costMicrousd: 10_000,
    costStatus: "actual",
    accepted: true,
    qualityStatus: "accepted",
    runStatus: "succeeded",
    decidedAt: START,
    createdAt: START,
    expiresAt: START + 1,
    ...overrides,
  }
  return sample
}

function cheap(sampleId: string, overrides: Partial<FusionRoutingSampleRow> = {}) {
  return row(sampleId, {
    actionId: "cheap_good",
    actionHash: "hash-cheap",
    mode: "direct",
    costMicrousd: 1_000,
    ...overrides,
  })
}

type StubPrediction = { pPass: number; inDistribution?: boolean } | null

/**
 * A hand-written predictor: the experiment only ever talks to the
 * `RoutingPredictor` interface, so a fixed answer per action hash is enough to
 * drive every branch of the choice deterministically.
 */
function stubPredictor(
  predictions: Record<string, StubPrediction>
): RoutingPredictor & { predict: jest.Mock } {
  const predict = jest.fn(
    (action: RoutingPredictionAction, _features: readonly number[]): RoutingPrediction | null => {
      const prediction = predictions[action.actionHash]
      if (!prediction) return null
      return {
        actionId: action.actionId,
        actionHash: action.actionHash,
        pPass: prediction.pPass,
        rawProbability: prediction.pPass,
        supportCount: 100,
        inDistribution: prediction.inDistribution ?? true,
        predictorVersion: "stub@1",
      }
    }
  )
  return {
    version: "stub@1",
    manifestSha256: "stub",
    featuresVersion: ROUTING_FEATURES_VERSION,
    featureNames: ROUTING_FEATURE_NAMES,
    actionHashes: Object.keys(predictions),
    predict,
  }
}

function costs(...rows: ActionCostRow[]): Map<string, ActionCostRow> {
  return new Map(rows.map((entry) => [entry.actionHash, entry]))
}

const CHEAP_COST: ActionCostRow = {
  actionId: "cheap_good",
  actionHash: "hash-cheap",
  meanCostMicrousd: 1_000,
  sampleCount: 10,
}
const PRICEY_COST: ActionCostRow = {
  actionId: "pricey",
  actionHash: "hash-pricey",
  meanCostMicrousd: 10_000,
  sampleCount: 10,
}

/**
 * A recorded, randomized log in which the cheap action is ALSO the better one:
 * the only kind of evidence on which the gate can honestly pass.
 */
function liveRows(seed: number, sessions: number): FusionRoutingSampleRow[] {
  const random = createSeededRandom(seed)
  const rows: FusionRoutingSampleRow[] = []
  for (let session = 0; session < sessions; session += 1) {
    for (let turn = 0; turn < 4; turn += 1) {
      const isCheap = turn % 2 === 0
      const ambiguous = random() < 0.5
      const pAccept = isCheap ? (ambiguous ? 0.6 : 0.95) : ambiguous ? 0.3 : 0.7
      const accepted = random() < pAccept
      const id = `s-${String(session).padStart(4, "0")}-${turn}`
      const overrides: Partial<FusionRoutingSampleRow> = {
        groupId: `g-${session}`,
        features: ambiguous ? HIGH : LOW,
        propensity: 0.5,
        accepted,
        qualityStatus: accepted ? "accepted" : "degraded",
        decidedAt: START + session * 60_000 + turn * 1_000,
      }
      rows.push(isCheap ? cheap(id, overrides) : row(id, overrides))
    }
  }
  return rows
}

describe("routingDisclaimerFor", () => {
  it("names the label a report carries", () => {
    expect(routingDisclaimerFor("simulated")).toBe(SIMULATED_ROUTING_DISCLAIMER)
    expect(routingDisclaimerFor("live")).toBe(LIVE_ROUTING_DISCLAIMER)
    expect(SIMULATED_ROUTING_DISCLAIMER).toMatch(/^SIMULATED: .*no claim.*\(EVAL-04\)\.$/)
    expect(LIVE_ROUTING_DISCLAIMER).toMatch(/^LIVE: /)
  })
})

describe("actionCostTable", () => {
  it("is empty for no samples", () => {
    expect(actionCostTable([]).size).toBe(0)
  })

  it("averages the observed spend per action hash, rounded to whole microusd", () => {
    const table = actionCostTable([
      cheap("a", { costMicrousd: 1_000 }),
      cheap("b", { costMicrousd: 1_001 }),
      row("c", { costMicrousd: 9_000, accepted: false }),
      row("d", { costMicrousd: 12_000 }),
      row("e", { costMicrousd: 0, runStatus: "failed", accepted: false }),
    ])
    expect(table.size).toBe(2)
    expect(table.get("hash-cheap")).toEqual({
      actionId: "cheap_good",
      actionHash: "hash-cheap",
      meanCostMicrousd: 1_001,
      sampleCount: 2,
    })
    expect(table.get("hash-pricey")).toEqual({
      actionId: "pricey",
      actionHash: "hash-pricey",
      meanCostMicrousd: 7_000,
      sampleCount: 3,
    })
  })

  it("keys by hash, so a changed action is priced separately and keeps its first id", () => {
    const table = actionCostTable([
      row("a", { actionHash: "hash-v1", costMicrousd: 100 }),
      row("b", { actionHash: "hash-v2", costMicrousd: 300 }),
      row("c", { actionHash: "hash-v1", actionId: "renamed", costMicrousd: 300 }),
    ])
    expect(table.get("hash-v1")).toMatchObject({ actionId: "pricey", meanCostMicrousd: 200 })
    expect(table.get("hash-v2")).toMatchObject({ actionId: "pricey", meanCostMicrousd: 300 })
  })
})

describe("learnedRoutingChoice", () => {
  it("chooses the lowest predicted cost per accepted run", () => {
    const predictor = stubPredictor({
      "hash-cheap": { pPass: 0.5 },
      "hash-pricey": { pPass: 0.9 },
    })
    expect(learnedRoutingChoice(predictor, LOW, costs(CHEAP_COST, PRICEY_COST))).toEqual({
      actionId: "cheap_good",
      actionHash: "hash-cheap",
      pPass: 0.5,
      expectedCostPerAcceptedMicrousd: 2_000,
      inDistribution: true,
    })
    expect(predictor.predict).toHaveBeenCalledWith(
      { actionId: "cheap_good", actionHash: "hash-cheap" },
      LOW
    )
    expect(predictor.predict).toHaveBeenCalledWith(
      { actionId: "pricey", actionHash: "hash-pricey" },
      LOW
    )
  })

  it("lets an unlikely-to-pass cheap action price itself out", () => {
    const predictor = stubPredictor({
      "hash-cheap": { pPass: 0.05 },
      "hash-pricey": { pPass: 0.9 },
    })
    const choice = learnedRoutingChoice(predictor, LOW, costs(CHEAP_COST, PRICEY_COST))
    expect(choice?.actionId).toBe("pricey")
    expect(choice?.expectedCostPerAcceptedMicrousd).toBeCloseTo(10_000 / 0.9)
  })

  it("skips actions it cannot price or predict, out-of-distribution ones and zero-pass ones", () => {
    expect(
      learnedRoutingChoice(stubPredictor({ "hash-cheap": { pPass: 0.9 } }), LOW, costs(PRICEY_COST))
    ).toBeNull()
    expect(
      learnedRoutingChoice(stubPredictor({ "hash-cheap": null }), LOW, costs(CHEAP_COST))
    ).toBeNull()
    expect(
      learnedRoutingChoice(
        stubPredictor({ "hash-cheap": { pPass: 0.9, inDistribution: false } }),
        LOW,
        costs(CHEAP_COST)
      )
    ).toBeNull()
    expect(
      learnedRoutingChoice(stubPredictor({ "hash-cheap": { pPass: 0 } }), LOW, costs(CHEAP_COST))
    ).toBeNull()

    // The cheap action is out of distribution, so the costlier one is the only opinion.
    const choice = learnedRoutingChoice(
      stubPredictor({
        "hash-cheap": { pPass: 0.99, inDistribution: false },
        "hash-pricey": { pPass: 0.5 },
      }),
      LOW,
      costs(CHEAP_COST, PRICEY_COST)
    )
    expect(choice?.actionId).toBe("pricey")
  })

  it("breaks an exact tie by action id, whatever the hash order", () => {
    const tie = costs(
      { actionId: "b_action", actionHash: "hash-1", meanCostMicrousd: 500, sampleCount: 1 },
      { actionId: "a_action", actionHash: "hash-2", meanCostMicrousd: 500, sampleCount: 1 }
    )
    const predictor = stubPredictor({ "hash-2": { pPass: 0.5 }, "hash-1": { pPass: 0.5 } })
    expect(learnedRoutingChoice(predictor, LOW, tie)?.actionId).toBe("a_action")
  })
})

describe("replayPromotionObservations", () => {
  it("keeps, per policy, only the logged samples that policy would itself have chosen", () => {
    // The learned policy always prefers the cheap action.
    const predictor = stubPredictor({
      "hash-cheap": { pPass: 0.9 },
      "hash-pricey": { pPass: 0.9 },
    })
    const table = costs(CHEAP_COST, PRICEY_COST)
    const rows = [
      row("rules-only", { groupId: "g1" }),
      cheap("learned-only", { groupId: "g1", accepted: false }),
      cheap("both", { groupId: "g2", baselineActionId: "cheap_good" }),
      row("neither", { groupId: "g3", baselineActionId: "cheap_good" }),
    ]
    const replay = replayPromotionObservations(rows, predictor, table)
    expect(replay.baselineMatched).toBe(2)
    expect(replay.candidateMatched).toBe(2)
    expect(replay.observations).toEqual([
      { groupId: "g1", arm: "baseline", costMicrousd: 10_000, accepted: true },
      { groupId: "g1", arm: "candidate", costMicrousd: 1_000, accepted: false },
      { groupId: "g2", arm: "baseline", costMicrousd: 1_000, accepted: true },
      { groupId: "g2", arm: "candidate", costMicrousd: 1_000, accepted: true },
    ])
  })

  it("adds no candidate observation when the learned router has no opinion", () => {
    const replay = replayPromotionObservations(
      [cheap("a", { baselineActionId: "pricey" })],
      stubPredictor({}),
      costs(CHEAP_COST)
    )
    expect(replay).toEqual({ observations: [], candidateMatched: 0, baselineMatched: 0 })
  })
})

describe("routingPromotionGate", () => {
  const preferCheap = () =>
    stubPredictor({ "hash-cheap": { pPass: 0.9 }, "hash-pricey": { pPass: 0.9 } })

  function pairedGroups(
    count: number,
    candidateAccepted: (index: number) => boolean
  ): FusionRoutingSampleRow[] {
    return Array.from({ length: count }, (_, index) => [
      row(`base-${index}`, { groupId: `g-${index}` }),
      cheap(`cand-${index}`, { groupId: `g-${index}`, accepted: candidateAccepted(index) }),
    ]).flat()
  }

  it("refuses without a predictor, still counting the deterministic samples", () => {
    const result = routingPromotionGate(
      [row("a", { propensity: 1 }), row("b")],
      null,
      costs(PRICEY_COST),
      { seed: 1 }
    )
    expect(result).toEqual({
      gate: null,
      passed: false,
      refusals: ["NO_PREDICTOR"],
      candidateMatched: 0,
      baselineMatched: 0,
      deterministicSamples: 1,
    })
  })

  it("refuses a log with no randomization instead of estimating an artefact", () => {
    const rows = pairedGroups(40, () => true).map((sample) => ({ ...sample, propensity: 1 }))
    expect(
      routingPromotionGate(rows, preferCheap(), costs(CHEAP_COST, PRICEY_COST), { seed: 1 })
    ).toEqual({
      gate: null,
      passed: false,
      refusals: ["DETERMINISTIC_LOGGING"],
      candidateMatched: 0,
      baselineMatched: 0,
      deterministicSamples: 80,
    })
  })

  it("runs the bootstrap on an empty window and answers inconclusive", () => {
    const result = routingPromotionGate([], preferCheap(), costs(CHEAP_COST, PRICEY_COST), {
      seed: 1,
      iterations: 50,
    })
    expect(result.refusals).toEqual([])
    expect(result.passed).toBe(false)
    expect(result.gate?.verdict).toBe("inconclusive")
    expect(result.gate?.reasons).toContain("INSUFFICIENT_GROUPS")
    expect(result.deterministicSamples).toBe(0)
  })

  it("replays only the randomized samples", () => {
    const randomized = pairedGroups(5, () => true)
    const deterministic = pairedGroups(5, () => true).map((sample) => ({
      ...sample,
      sampleId: `det-${sample.sampleId}`,
      propensity: 1,
    }))
    const result = routingPromotionGate(
      [...deterministic, ...randomized],
      preferCheap(),
      costs(CHEAP_COST, PRICEY_COST),
      { seed: 1, iterations: 50 }
    )
    expect(result.deterministicSamples).toBe(10)
    expect(result.baselineMatched).toBe(5)
    expect(result.candidateMatched).toBe(5)
    expect(result.gate?.pairedGroupCount).toBe(5)
  })

  it("passes a cheaper candidate that is no worse, and forwards every option", () => {
    const result = routingPromotionGate(
      pairedGroups(40, () => true),
      preferCheap(),
      costs(CHEAP_COST, PRICEY_COST),
      {
        seed: 11,
        iterations: 200,
        confidenceLevel: 0.9,
        minGroups: 20,
        maxCostPerAcceptedDeltaMicrousd: -100,
        minPassRateDelta: -0.05,
      }
    )
    expect(result.refusals).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.gate).toMatchObject({
      verdict: "pass",
      seed: 11,
      iterations: 200,
      confidenceLevel: 0.9,
      pairedGroupCount: 40,
      thresholds: { maxCostPerAcceptedDeltaMicrousd: -100, minPassRateDelta: -0.05 },
    })
    expect(result.gate?.costPerAcceptedDeltaMicrousd.estimate).toBe(-9_000)
  })

  it("fails a cheaper candidate whose pass rate falls below the margin", () => {
    const result = routingPromotionGate(
      pairedGroups(40, (index) => index % 2 === 0),
      preferCheap(),
      costs(CHEAP_COST, PRICEY_COST),
      { seed: 5, iterations: 200 }
    )
    expect(result.passed).toBe(false)
    expect(result.gate?.verdict).toBe("fail")
    expect(result.gate?.reasons).toContain("PASS_RATE_BELOW_MARGIN")
    expect(result.gate?.reasons).not.toContain("COST_NOT_REDUCED")
  })

  it("stays inconclusive below the configured group count", () => {
    const result = routingPromotionGate(
      pairedGroups(40, () => true),
      preferCheap(),
      costs(CHEAP_COST, PRICEY_COST),
      { seed: 1, iterations: 50, minGroups: 41 }
    )
    expect(result.passed).toBe(false)
    expect(result.gate?.verdict).toBe("inconclusive")
    expect(result.gate?.reasons).toContain("INSUFFICIENT_GROUPS")
  })
})

describe("runRoutingExperiment", () => {
  const options = { createdAt: CREATED_AT, seed: 1, iterations: 200 }

  it("refuses an empty sample set", async () => {
    await expect(runRoutingExperiment([], options)).rejects.toThrow(
      "a routing experiment needs at least one sample"
    )
  })

  it("refuses a set that mixes recorded and simulated rows", async () => {
    await expect(
      runRoutingExperiment([row("a"), row("b", { origin: "simulated" })], options)
    ).rejects.toThrow(/mixes recorded and simulated rows/)
  })

  it("refuses a set spanning feature versions, or encoded by another build", async () => {
    await expect(
      runRoutingExperiment([row("a"), row("b", { featuresVersion: "legacy/0" })], options)
    ).rejects.toThrow(
      `sample set spans feature versions legacy/0, ${ROUTING_FEATURES_VERSION}; train on one encoding`
    )
    await expect(
      runRoutingExperiment([row("a", { featuresVersion: "legacy/0" })], options)
    ).rejects.toThrow(`samples encode legacy/0; this build encodes ${ROUTING_FEATURES_VERSION}`)
  })

  it("reports a simulated set as simulated and claims nothing (EVAL-04)", async () => {
    const rows = simulatedRoutingSamples({ seed: 1 })
    const { report, trainingManifest, publishedManifest } = await runRoutingExperiment(
      rows,
      options
    )

    expect(report.schema).toBe(ROUTING_EXPERIMENT_SCHEMA)
    expect(report.version).toBe(1)
    expect(report.label).toBe("simulated")
    expect(report.disclaimer).toBe(SIMULATED_ROUTING_DISCLAIMER)
    expect(report.claims).toEqual({ quality: null, costSavingMicrousd: null })
    expect(report.caveats[0]).toBe(SIMULATED_ROUTING_DISCLAIMER)
    expect(report.createdAt).toBe(CREATED_AT)
    expect(report.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
    expect(report.sampleCount).toBe(rows.length)

    expect(trainingManifest.kind).toBe("training")
    expect(report.training.manifestSha256).toBe(trainingManifest.sha256)
    expect(report.split).toEqual(trainingManifest.split)
    expect(publishedManifest).not.toBeNull()
    expect(publishedManifest?.kind).toBe("published")
    expect(publishedManifest?.sourceManifestSha256).toBe(trainingManifest.sha256)
    expect(report.publication).toEqual({
      status: "published",
      manifestSha256: publishedManifest?.sha256,
      withheldHeads: publishedManifest?.withheldHeads,
    })

    expect(report.heads.map((head) => head.actionId)).toEqual(
      SIMULATED_ACTIONS.map((action) => action.actionId).sort()
    )
    for (const head of report.heads) {
      const trained = trainingManifest.heads.find((entry) => entry.actionHash === head.actionHash)
      expect(trained).toBeDefined()
      expect(head.trainingSamples).toBe(trained?.counts.training.samples)
      expect(head.calibrationSamples).toBe(trained?.counts.calibration.samples)
      expect(head.testSamples).toBe(trained?.counts.test.samples)
      expect(head.publishable).toBe(trained?.publishable)
      if (head.publishable) {
        expect(head.testBrier).toEqual(expect.any(Number))
        expect(head.testExpectedCalibrationError).toEqual(expect.any(Number))
      }
    }

    // The gate judged the test window only (EVAL-01).
    const testSamples = trainingManifest.split.partitions.test.samples
    expect(testSamples).toBeGreaterThan(0)
    expect(testSamples).toBeLessThan(rows.length)
    expect(report.gate.deterministicSamples).toBeLessThanOrEqual(testSamples)
    expect(report.gate.deterministicSamples).toBeLessThan(
      rows.filter((sample) => sample.propensity >= 1).length
    )
  })

  it("puts every sample's cost in the numerator and only accepted ones in the denominator (EVAL-03)", async () => {
    const rows = simulatedRoutingSamples({ seed: 4, sessionCount: 80 }).map((sample, index) =>
      index % 7 === 0
        ? { ...sample, runStatus: "failed" as const, accepted: false, qualityStatus: null }
        : sample
    )
    const { report } = await runRoutingExperiment(rows, options)
    const totalCost = rows.reduce((sum, sample) => sum + sample.costMicrousd, 0)
    const acceptedCount = rows.filter((sample) => sample.accepted).length
    expect(report.acceptedCost).toEqual({
      runCount: rows.length,
      acceptedCount,
      totalCostMicrousd: totalCost,
      costPerAcceptedMicrousd: totalCost / acceptedCount,
      passRate: acceptedCount / rows.length,
    })
    expect(report.byAction.map((entry) => entry.actionId)).toEqual(
      [...new Set(rows.map((sample) => sample.actionId))].sort()
    )
    for (const entry of report.byAction) {
      const mine = rows.filter((sample) => sample.actionHash === entry.actionHash)
      expect(entry).toEqual({
        actionId: mine[0].actionId,
        actionHash: entry.actionHash,
        ...acceptedCost(mine.map(({ costMicrousd, accepted }) => ({ costMicrousd, accepted }))),
      })
    }
    expect(report.byAction.reduce((sum, entry) => sum + entry.runCount, 0)).toBe(rows.length)
    expect(report.byAction.reduce((sum, entry) => sum + entry.totalCostMicrousd, 0)).toBe(totalCost)
  })

  it("is a pure function of the rows, the timestamp and the seed", async () => {
    const rows = simulatedRoutingSamples({ seed: 2, sessionCount: 60 })
    const first = await runRoutingExperiment(rows, options)
    const second = await runRoutingExperiment([...rows].reverse(), options)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it("refuses to promote on a deterministic log and says why", async () => {
    const rows = simulatedRoutingSamples({ seed: 1, explorationRate: 0 })
    const { report } = await runRoutingExperiment(rows, options)
    expect(report.publication.status).toBe("published")
    expect(report.gate).toMatchObject({
      gate: null,
      passed: false,
      refusals: ["DETERMINISTIC_LOGGING"],
    })
    expect(report.caveats).toContainEqual(
      expect.stringMatching(/propensity 1.*nothing can be promoted/)
    )
    expect(report.claims).toEqual({ quality: null, costSavingMicrousd: null })
  })

  it("reports a refused publication when no head can be calibrated", async () => {
    const rows = simulatedRoutingSamples({ seed: 1, sessionCount: 5 })
    const { report, publishedManifest } = await runRoutingExperiment(rows, options)
    expect(publishedManifest).toBeNull()
    expect(report.publication).toMatchObject({
      status: "refused",
      reason: "NO_PUBLISHABLE_HEADS",
      problems: [expect.stringMatching(/no head is calibrated/)],
    })
    if (report.publication.status !== "refused") throw new Error("expected a refusal")
    expect(report.publication.withheldHeads).toHaveLength(report.heads.length)
    expect(report.heads.every((head) => !head.publishable && head.withheldReasons.length > 0)).toBe(
      true
    )
    expect(report.heads.every((head) => head.testBrier === null)).toBe(true)
    expect(report.gate.refusals).toEqual(["NO_PREDICTOR"])
    expect(report.caveats).toContain(
      "No head could be published, so there was no candidate router to compare against."
    )
  })

  it("makes a claim only for a live set whose gate passed", async () => {
    const rows = liveRows(7, 200)
    const { report, publishedManifest } = await runRoutingExperiment(rows, options)
    expect(report.label).toBe("live")
    expect(report.disclaimer).toBe(LIVE_ROUTING_DISCLAIMER)
    expect(report.gate.passed).toBe(true)
    expect(report.gate.gate?.verdict).toBe("pass")
    expect(report.gate.gate?.iterations).toBe(200)
    expect(report.gate.candidateMatched).toBeGreaterThan(0)
    expect(report.gate.baselineMatched).toBeGreaterThan(0)
    expect(report.caveats).toEqual([])

    const high = report.gate.gate?.costPerAcceptedDeltaMicrousd.high
    expect(typeof high).toBe("number")
    expect(report.claims).toEqual({
      quality: "pass rate non-inferior to the rules router at the configured confidence",
      costSavingMicrousd: -(high as number),
    })
    expect(report.claims.costSavingMicrousd).toBeGreaterThan(0)

    // The published predictor really does prefer the cheap, better action.
    if (!publishedManifest) throw new Error("expected a published manifest")
    const loaded = await loadRoutingPredictor(publishedManifest, {
      featuresVersion: ROUTING_FEATURES_VERSION,
      featureNames: ROUTING_FEATURE_NAMES,
    })
    if (loaded.status !== "loaded") throw new Error(loaded.problems.join("; "))
    const table = actionCostTable(rows)
    const choice = learnedRoutingChoice(loaded.predictor, LOW, table)
    expect(choice?.actionId).toBe("cheap_good")
    const prediction = loaded.predictor.predict(
      { actionId: "cheap_good", actionHash: "hash-cheap" },
      LOW
    )
    expect(choice?.pPass).toBe(prediction?.pPass)
    expect(choice?.expectedCostPerAcceptedMicrousd).toBeCloseTo(
      (table.get("hash-cheap")?.meanCostMicrousd ?? Number.NaN) / (prediction?.pPass ?? Number.NaN)
    )
  })

  it("never claims for a simulated set, even when its gate passed (EVAL-04)", async () => {
    const rows = liveRows(7, 200).map((sample) => ({ ...sample, origin: "simulated" as const }))
    const { report } = await runRoutingExperiment(rows, options)
    expect(report.label).toBe("simulated")
    expect(report.gate.passed).toBe(true)
    expect(report.claims).toEqual({ quality: null, costSavingMicrousd: null })
    expect(report.caveats).toEqual([SIMULATED_ROUTING_DISCLAIMER])
  })

  it("claims nothing for a live set the gate could not decide, and says why", async () => {
    const rows = liveRows(7, 200)
    const { report } = await runRoutingExperiment(rows, {
      ...options,
      gate: { minGroups: 1_000, iterations: 60 },
    })
    expect(report.gate.gate?.verdict).toBe("inconclusive")
    expect(report.gate.gate?.iterations).toBe(60)
    expect(report.claims).toEqual({ quality: null, costSavingMicrousd: null })
    expect(report.caveats).toEqual([
      "The bootstrap was inconclusive (INSUFFICIENT_GROUPS); the learned router stays off.",
    ])
  })

  it("flags estimated bills as estimates in the numerator", async () => {
    const rows = liveRows(7, 200).map((sample, index) =>
      index === 0 ? { ...sample, costStatus: "estimated" as const } : sample
    )
    const { report } = await runRoutingExperiment(rows, options)
    expect(report.caveats).toContain(
      "Some samples carry an estimated rather than a settled bill; their cost is an estimate in the numerator."
    )
  })
})
