import { fitLogisticRegression, logisticLogit } from "./logistic"
import { applyPlattCalibration, fitPlattCalibration } from "./platt"
import { createSeededRandom, seededShuffle, verifyGroupedTimeSplit } from "./grouped-split"
import {
  canonicalJson,
  digestSha256Hex,
  loadRoutingPredictor,
  publishRoutingPredictor,
  routingManifestDigest,
  trainRoutingPredictor,
  verifyRoutingPredictorManifest,
  type RoutingPredictorManifest,
  type RoutingTrainingSample,
  type TrainRoutingPredictorOptions,
} from "./manifest"
import * as evalCore from "../index"

const FEATURES = ["difficulty", "task_code", "failed_attempts"]
const FEATURES_VERSION = "routing-encoding-test-1"

const ECONOMY = { actionId: "direct_economy", actionHash: "hash-economy" }
const BASELINE = { actionId: "direct_baseline", actionHash: "hash-baseline" }
const PANEL = { actionId: "panel_review", actionHash: "hash-panel" }

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z))
}

/**
 * A routing log: sessions of 2–5 turns in time order, every turn evaluated
 * with each listed action (paired offline evaluation = repeated sampling of
 * one decision). Economy degrades sharply with difficulty and code tasks;
 * baseline barely does. `panel` (when included) is always accepted.
 */
function routingLog(options: { sessions?: number; seed?: number; withPanel?: boolean } = {}) {
  const random = createSeededRandom(options.seed ?? 17)
  const samples: RoutingTrainingSample[] = []
  const sessions = options.sessions ?? 120
  for (let session = 0; session < sessions; session++) {
    const groupId = `session-${String(session).padStart(3, "0")}`
    const turns = 2 + Math.floor(random() * 4)
    let timestamp = 1_700_000_000_000 + session * 600_000 + Math.floor(random() * 1_000)
    for (let turn = 0; turn < turns; turn++) {
      timestamp += 1_000 + Math.floor(random() * 5_000)
      const difficulty = random()
      const code = random() < 0.4 ? 1 : 0
      const failed = Math.floor(random() * 3)
      const features = [difficulty, code, failed]
      const economyPass = random() < sigmoid(2.5 - 5 * difficulty - code - 0.4 * failed)
      const baselinePass = random() < sigmoid(2.2 - 1.5 * difficulty - 0.2 * failed)
      const base = { groupId, timestamp, features }
      samples.push({ ...base, ...ECONOMY, sampleId: `${groupId}-${turn}-e`, accepted: economyPass })
      samples.push({
        ...base,
        ...BASELINE,
        sampleId: `${groupId}-${turn}-b`,
        accepted: baselinePass,
      })
      if (options.withPanel) {
        samples.push({ ...base, ...PANEL, sampleId: `${groupId}-${turn}-p`, accepted: true })
      }
    }
  }
  return samples
}

function trainOptions(
  overrides: Partial<TrainRoutingPredictorOptions> = {}
): TrainRoutingPredictorOptions {
  return {
    featuresVersion: FEATURES_VERSION,
    featureNames: FEATURES,
    createdAt: "2026-09-19T00:00:00.000Z",
    seed: 42,
    ...overrides,
  }
}

async function publishedFrom(samples = routingLog()) {
  const { manifest } = await trainRoutingPredictor(samples, trainOptions())
  const result = await publishRoutingPredictor(manifest, {
    publishedAt: "2026-09-19T01:00:00.000Z",
  })
  if (result.status !== "published") throw new Error(`expected publication, got ${result.reason}`)
  return { training: manifest, published: result.manifest, result }
}

function head(manifest: RoutingPredictorManifest, actionHash: string) {
  const found = manifest.heads.find((candidate) => candidate.actionHash === actionHash)
  if (!found) throw new Error(`no head for ${actionHash}`)
  return found
}

describe("trainRoutingPredictor", () => {
  it("[ACC:EVAL-01] fits each head on training sessions only and calibrates it on held-out sessions only", async () => {
    const samples = routingLog()
    const { manifest, split } = await trainRoutingPredictor(samples, trainOptions())
    expect(verifyGroupedTimeSplit(split)).toEqual([])
    expect(split.test.length).toBeGreaterThan(0)
    expect(split.calibration.length).toBeGreaterThan(0)

    // The manifest's split report is the split that was used.
    for (const partition of ["train", "calibration", "test", "excluded"] as const) {
      expect(manifest.split.partitions[partition]).toEqual({
        groups: split.groups[partition].length,
        samples: split[partition].length,
      })
      expect(manifest.split.groupsSha256[partition]).toBe(
        await digestSha256Hex(canonicalJson(split.groups[partition]))
      )
    }
    expect(manifest.split.testStartsAt).toBe(split.testStartsAt)

    // Refit from the training partition alone and calibrate on the
    // calibration partition alone: the manifest head is exactly that.
    const economy = head(manifest, ECONOMY.actionHash)
    const train = split.train.filter((sample) => sample.actionHash === ECONOMY.actionHash)
    const calibration = split.calibration.filter(
      (sample) => sample.actionHash === ECONOMY.actionHash
    )
    const refit = fitLogisticRegression(
      train.map((sample) => sample.features),
      train.map((sample) => sample.accepted),
      { featureNames: FEATURES }
    )
    expect(economy.model).toEqual(refit.model)
    const platt = fitPlattCalibration(
      calibration.map((sample) => logisticLogit(refit.model, sample.features)),
      calibration.map((sample) => sample.accepted),
      {
        calibrationGroupIds: calibration.map((sample) => sample.groupId),
        fittingGroupIds: train.map((sample) => sample.groupId),
      },
      { minPerClass: manifest.policy.minCalibrationPerClass }
    )
    expect(platt.calibrated).toBe(true)
    if (platt.calibrated) expect(economy.calibration).toEqual(platt.calibration)
    expect(economy.counts.training.samples).toBe(train.length)
    expect(economy.counts.calibration.samples).toBe(calibration.length)

    // Flipping every test-window label changes the test metrics and nothing
    // the head learned: the test window never feeds fitting or calibration.
    const testIds = new Set(split.test.map((sample) => sample.sampleId))
    const flipped = samples.map((sample) =>
      testIds.has(sample.sampleId) ? { ...sample, accepted: !sample.accepted } : sample
    )
    const again = await trainRoutingPredictor(flipped, trainOptions())
    const flippedEconomy = head(again.manifest, ECONOMY.actionHash)
    expect(flippedEconomy.model).toEqual(economy.model)
    expect(flippedEconomy.calibration).toEqual(economy.calibration)
    expect(flippedEconomy.metrics.test).not.toEqual(economy.metrics.test)
    expect(again.manifest.trainingDataSha256).not.toBe(manifest.trainingDataSha256)
  })

  it("learns the generating structure and reports calibrated test metrics", async () => {
    const { manifest } = await trainRoutingPredictor(routingLog(), trainOptions())
    expect(manifest.heads.map((entry) => entry.actionId)).toEqual([
      "direct_baseline",
      "direct_economy",
    ])
    const economy = head(manifest, ECONOMY.actionHash)
    expect(economy).toMatchObject({ calibrated: true, publishable: true, withheldReasons: [] })
    expect(economy.model?.rawCoefficients[0]).toBeLessThan(0)
    expect(economy.model?.rawCoefficients[1]).toBeLessThan(0)
    expect(economy.training?.converged).toBe(true)
    expect(economy.calibration?.slope).toBeGreaterThan(0)
    expect(economy.metrics.test?.raw.sampleCount).toBe(economy.counts.test.samples)
    expect(economy.metrics.test?.calibrated?.brier).toBeLessThan(0.25)
    expect(economy.metrics.calibration?.sampleCount).toBe(economy.counts.calibration.samples)
    expect(economy.featureRanges?.min).toHaveLength(FEATURES.length)
  })

  it("is deterministic: any sample order and a rerun give the same manifest and sha256", async () => {
    const samples = routingLog()
    const first = await trainRoutingPredictor(samples, trainOptions())
    const rerun = await trainRoutingPredictor(samples, trainOptions())
    const shuffled = await trainRoutingPredictor(seededShuffle(samples, 9), trainOptions())
    const reversed = await trainRoutingPredictor([...samples].reverse(), trainOptions())
    expect(rerun.manifest).toEqual(first.manifest)
    expect(shuffled.manifest.sha256).toBe(first.manifest.sha256)
    expect(reversed.manifest).toEqual(first.manifest)
    expect(canonicalJson(shuffled.manifest)).toBe(canonicalJson(first.manifest))
    expect(first.manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await routingManifestDigest(first.manifest)).toBe(first.manifest.sha256)
    // A different seed may move calibration sessions; the seal follows.
    const reseeded = await trainRoutingPredictor(samples, trainOptions({ seed: 43 }))
    expect(reseeded.manifest.sha256).not.toBe(first.manifest.sha256)
  })

  it("[ACC:EVAL-02] never marks a single-class head calibrated, and publishing withholds it", async () => {
    const samples = routingLog({ withPanel: true })
    const { manifest } = await trainRoutingPredictor(samples, trainOptions())
    const panel = head(manifest, PANEL.actionHash)
    expect(panel).toMatchObject({
      calibrated: false,
      publishable: false,
      model: null,
      calibration: null,
    })
    expect(panel.withheldReasons).toEqual(
      expect.arrayContaining(["SINGLE_CLASS_TRAINING", "SINGLE_CLASS_CALIBRATION"])
    )
    expect(panel.counts.training.negatives).toBe(0)

    const result = await publishRoutingPredictor(manifest, {
      publishedAt: "2026-09-19T01:00:00.000Z",
    })
    expect(result.status).toBe("published")
    if (result.status !== "published") return
    expect(result.manifest.heads.map((entry) => entry.actionHash).sort()).toEqual([
      BASELINE.actionHash,
      ECONOMY.actionHash,
    ])
    expect(result.withheldHeads).toEqual([{ ...PANEL, reasons: panel.withheldReasons }])
    expect(result.manifest.withheldHeads).toEqual(result.withheldHeads)
    expect(result.manifest.sourceManifestSha256).toBe(manifest.sha256)

    const loaded = await loadRoutingPredictor(result.manifest, {
      featuresVersion: FEATURES_VERSION,
    })
    expect(loaded.status).toBe("loaded")
    if (loaded.status !== "loaded") return
    expect(loaded.predictor.predict(PANEL, [0.2, 0, 0])).toBeNull()
    expect(loaded.predictor.predict(ECONOMY, [0.2, 0, 0])).not.toBeNull()
  })

  it("[ACC:EVAL-02] without independent calibration data nothing is calibrated and publication is refused", async () => {
    const { manifest } = await trainRoutingPredictor(
      routingLog(),
      trainOptions({ split: { calibrationFraction: 0 } })
    )
    for (const entry of manifest.heads) {
      expect(entry.calibrated).toBe(false)
      expect(entry.model).not.toBeNull()
      expect(entry.withheldReasons).toEqual(["NO_CALIBRATION_DATA"])
    }
    const result = await publishRoutingPredictor(manifest, {
      publishedAt: "2026-09-19T01:00:00.000Z",
    })
    expect(result).toMatchObject({ status: "refused", reason: "NO_PUBLISHABLE_HEADS" })
    if (result.status === "refused") {
      expect(result.withheldHeads.map((entry) => entry.reasons)).toEqual([
        ["NO_CALIBRATION_DATA"],
        ["NO_CALIBRATION_DATA"],
      ])
    }
  })

  it("[ACC:EVAL-02] the loader refuses a published manifest carrying an uncalibrated head, even re-sealed", async () => {
    const samples = routingLog({ withPanel: true })
    const { manifest: training } = await trainRoutingPredictor(samples, trainOptions())
    const result = await publishRoutingPredictor(training, {
      publishedAt: "2026-09-19T01:00:00.000Z",
    })
    if (result.status !== "published") throw new Error("expected publication")

    const smuggled = {
      ...result.manifest,
      heads: [...result.manifest.heads, head(training, PANEL.actionHash)],
    }
    smuggled.sha256 = await routingManifestDigest(smuggled)
    const refused = await loadRoutingPredictor(smuggled, { featuresVersion: FEATURES_VERSION })
    expect(refused.status).toBe("refused")
    if (refused.status === "refused") {
      expect(refused.problems.join("\n")).toMatch(
        /published manifest carries withheld head panel_review/
      )
    }

    // Flipping the flag alone does not make a head calibrated.
    const forged = {
      ...result.manifest,
      heads: [
        {
          ...head(training, PANEL.actionHash),
          calibrated: true,
          publishable: true,
          withheldReasons: [],
        },
      ],
    }
    forged.sha256 = await routingManifestDigest(forged)
    const forgedResult = await loadRoutingPredictor(forged, { featuresVersion: FEATURES_VERSION })
    expect(forgedResult.status).toBe("refused")
    if (forgedResult.status === "refused") {
      expect(forgedResult.problems.join("\n")).toMatch(/calibrated without a model/)
    }
  })

  it("withholds heads that were never evaluated on a test window", async () => {
    const { manifest } = await trainRoutingPredictor(
      routingLog(),
      trainOptions({ split: { testFraction: 0 } })
    )
    for (const entry of manifest.heads) {
      expect(entry).toMatchObject({
        calibrated: true,
        publishable: false,
        withheldReasons: ["NO_TEST_DATA"],
      })
      expect(entry.metrics.test).toBeNull()
    }
    const result = await publishRoutingPredictor(manifest, {
      publishedAt: "2026-09-19T01:00:00.000Z",
    })
    expect(result).toMatchObject({ status: "refused", reason: "NO_PUBLISHABLE_HEADS" })
  })

  it("withholds heads below the per-class minimum", async () => {
    const { manifest } = await trainRoutingPredictor(
      routingLog({ sessions: 20 }),
      trainOptions({ policy: { minTrainingPerClass: 500 } })
    )
    for (const entry of manifest.heads) {
      expect(entry.calibrated).toBe(false)
      expect(entry.model).toBeNull()
      expect(entry.withheldReasons).toContain("INSUFFICIENT_TRAINING_DATA")
    }
  })

  it("rejects malformed samples and options", async () => {
    const samples = routingLog({ sessions: 5 })
    await expect(
      trainRoutingPredictor([...samples, samples[0]], trainOptions())
    ).rejects.toMatchObject({
      code: "DUPLICATE_ID",
    })
    await expect(
      trainRoutingPredictor(
        [...samples, { ...samples[0], sampleId: "other", actionId: "another_action" }],
        trainOptions()
      )
    ).rejects.toMatchObject({ code: "INVALID_SAMPLE" })
    await expect(
      trainRoutingPredictor([{ ...samples[0], features: [1, 2] }], trainOptions())
    ).rejects.toMatchObject({ code: "DIMENSION_MISMATCH" })
    await expect(
      trainRoutingPredictor(samples, trainOptions({ createdAt: "yesterday" }))
    ).rejects.toMatchObject({
      code: "INVALID_OPTION",
    })
    await expect(
      trainRoutingPredictor(samples, trainOptions({ policy: { minCalibrationPerClass: 0 } }))
    ).rejects.toMatchObject({ code: "INVALID_OPTION" })
    await expect(
      trainRoutingPredictor(samples, trainOptions({ featureNames: ["a", "a", "b"] }))
    ).rejects.toMatchObject({ code: "INVALID_OPTION" })
  })
})

describe("manifest seal and publication", () => {
  it("detects content changed after sealing", async () => {
    const { training, published } = await publishedFrom()
    const tampered = JSON.parse(JSON.stringify(training)) as RoutingPredictorManifest
    const economy = head(tampered, ECONOMY.actionHash)
    if (!economy.model) throw new Error("expected a model")
    economy.model.coefficients[0] += 0.5
    expect(await verifyRoutingPredictorManifest(tampered)).toContain(
      "sha256 does not match the manifest content"
    )
    expect(
      await publishRoutingPredictor(tampered, { publishedAt: "2026-09-19T01:00:00.000Z" })
    ).toMatchObject({
      status: "refused",
      reason: "MANIFEST_INVALID",
    })

    const tamperedPublished = { ...published, featuresVersion: "routing-encoding-test-2" }
    const refused = await loadRoutingPredictor(tamperedPublished, {
      featuresVersion: "routing-encoding-test-2",
    })
    expect(refused.status).toBe("refused")
    expect(await verifyRoutingPredictorManifest(published)).toEqual([])
    expect(await verifyRoutingPredictorManifest(training)).toEqual([])
  })

  it("refuses to republish a published manifest or load a training one", async () => {
    const { training, published } = await publishedFrom()
    expect(
      await publishRoutingPredictor(published, { publishedAt: "2026-09-20T00:00:00.000Z" })
    ).toMatchObject({
      status: "refused",
      reason: "NOT_A_TRAINING_MANIFEST",
    })
    const loaded = await loadRoutingPredictor(training, { featuresVersion: FEATURES_VERSION })
    expect(loaded).toMatchObject({ status: "refused" })
    if (loaded.status === "refused") {
      expect(loaded.problems).toContain("only a published manifest can be loaded")
    }
    await expect(publishRoutingPredictor(training, { publishedAt: "soon" })).rejects.toMatchObject({
      code: "INVALID_OPTION",
    })
  })

  it("refuses a manifest built for another feature encoding", async () => {
    const { published } = await publishedFrom()
    const otherVersion = await loadRoutingPredictor(published, {
      featuresVersion: "routing-encoding-test-2",
    })
    expect(otherVersion.status).toBe("refused")
    const otherNames = await loadRoutingPredictor(published, {
      featuresVersion: FEATURES_VERSION,
      featureNames: ["difficulty", "task_code", "tool_need"],
    })
    expect(otherNames.status).toBe("refused")
  })
})

describe("loadRoutingPredictor", () => {
  it("predicts the calibrated probability of the exact action it was trained for", async () => {
    const { published } = await publishedFrom()
    const loaded = await loadRoutingPredictor(published, {
      featuresVersion: FEATURES_VERSION,
      featureNames: FEATURES,
    })
    if (loaded.status !== "loaded") throw new Error(loaded.problems.join("\n"))
    const { predictor } = loaded
    expect(predictor.version).toBe(`logistic-platt-1@${published.sha256.slice(0, 16)}`)
    expect([...predictor.actionHashes].sort()).toEqual([BASELINE.actionHash, ECONOMY.actionHash])

    const economy = head(published, ECONOMY.actionHash)
    if (!economy.model || !economy.calibration) throw new Error("expected a calibrated head")
    const easy = predictor.predict(ECONOMY, [0.1, 0, 0])
    const hard = predictor.predict(ECONOMY, [0.9, 1, 2])
    expect(easy).toMatchObject({
      ...ECONOMY,
      supportCount: economy.counts.training.samples,
      inDistribution: true,
      predictorVersion: predictor.version,
    })
    expect(easy?.pPass).toBeCloseTo(
      applyPlattCalibration(economy.calibration, logisticLogit(economy.model, [0.1, 0, 0])),
      12
    )
    expect(easy?.pPass as number).toBeGreaterThan(hard?.pPass as number)
    expect(easy?.pPass as number).toBeGreaterThan(0)
    expect(easy?.pPass as number).toBeLessThan(1)

    // Another action's id on this hash, or an unknown hash: no estimate.
    expect(
      predictor.predict(
        { actionId: "direct_baseline", actionHash: ECONOMY.actionHash },
        [0.1, 0, 0]
      )
    ).toBeNull()
    expect(
      predictor.predict({ actionId: "direct_economy", actionHash: "hash-changed" }, [0.1, 0, 0])
    ).toBeNull()
    // Outside the training range: still a probability, flagged out of distribution.
    expect(predictor.predict(ECONOMY, [3, 0, 0])?.inDistribution).toBe(false)
    expect(predictor.predict(ECONOMY, [0.5, 0, 9])?.inDistribution).toBe(false)
    expect(() => predictor.predict(ECONOMY, [0.1, 0])).toThrow(
      expect.objectContaining({ code: "DIMENSION_MISMATCH" })
    )
  })

  it("is isolated from later mutation of the manifest object it was loaded from", async () => {
    const { published } = await publishedFrom()
    const loaded = await loadRoutingPredictor(published, { featuresVersion: FEATURES_VERSION })
    if (loaded.status !== "loaded") throw new Error("expected a predictor")
    const before = loaded.predictor.predict(ECONOMY, [0.4, 1, 1])
    const economy = head(published, ECONOMY.actionHash)
    if (economy.model) economy.model.intercept += 10
    expect(loaded.predictor.predict(ECONOMY, [0.4, 1, 1])).toEqual(before)
  })
})

describe("canonical JSON and digest", () => {
  it("sorts keys, drops undefined members and refuses non-finite numbers", () => {
    expect(
      canonicalJson({ b: 1, a: [1, "x", null, undefined], c: undefined, d: { z: true, y: -0 } })
    ).toBe('{"a":[1,"x",null,null],"b":1,"d":{"y":0,"z":true}}')
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
  })

  it("hashes with SHA-256", async () => {
    expect(await digestSha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })
})

describe("the learned router through the package entry point", () => {
  it("trains, publishes, loads, predicts and gates a promotion from @cognia/eval-core", async () => {
    const samples = routingLog({ withPanel: true })
    const { manifest, split } = await evalCore.trainRoutingPredictor(samples, trainOptions())
    const published = await evalCore.publishRoutingPredictor(manifest, {
      publishedAt: "2026-09-19T01:00:00.000Z",
    })
    if (published.status !== "published") throw new Error(published.reason)
    const loaded = await evalCore.loadRoutingPredictor(published.manifest, {
      featuresVersion: FEATURES_VERSION,
      featureNames: FEATURES,
    })
    if (loaded.status !== "loaded") throw new Error(loaded.problems.join("\n"))
    expect(loaded.predictor.predict(ECONOMY, [0.3, 0, 0])?.pPass).toEqual(expect.any(Number))
    expect(loaded.predictor.predict(PANEL, [0.3, 0, 0])).toBeNull()

    // Replay the test window: the candidate routes to economy whenever the
    // predictor clears 0.8, the baseline always runs direct_baseline.
    const economyCost = 200
    const baselineCost = 1_000
    const byTurn = new Map<
      string,
      { economy?: RoutingTrainingSample; baseline?: RoutingTrainingSample }
    >()
    for (const sample of split.test) {
      const turn = sample.sampleId.slice(0, -2)
      const entry = byTurn.get(turn) ?? {}
      if (sample.actionHash === ECONOMY.actionHash) entry.economy = sample
      if (sample.actionHash === BASELINE.actionHash) entry.baseline = sample
      byTurn.set(turn, entry)
    }
    const observations: evalCore.PromotionObservation[] = []
    for (const { economy, baseline } of byTurn.values()) {
      if (!economy || !baseline) continue
      const estimate = loaded.predictor.predict(ECONOMY, economy.features)
      const choose = estimate !== null && estimate.pPass >= 0.8 ? economy : baseline
      observations.push({
        groupId: choose.groupId,
        arm: "candidate",
        costMicrousd: choose === economy ? economyCost : baselineCost,
        accepted: choose.accepted,
      })
      observations.push({
        groupId: baseline.groupId,
        arm: "baseline",
        costMicrousd: baselineCost,
        accepted: baseline.accepted,
      })
    }
    const gate = evalCore.groupedBootstrapGate(observations, {
      seed: 1,
      iterations: 1_000,
      minGroups: 5,
    })
    expect(["pass", "fail", "inconclusive"]).toContain(gate.verdict)
    expect(gate.pairedGroupCount).toBe(split.groups.test.length)
    expect(gate.candidate.totalCostMicrousd).toBe(
      evalCore.acceptedCost(observations.filter((entry) => entry.arm === "candidate"))
        .totalCostMicrousd
    )
  })
})
