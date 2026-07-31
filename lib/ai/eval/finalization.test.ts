/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { EvalExperimentManifest } from "@cognia/eval-core"
import type { EvalSampleRow, EvalScoreRow } from "@/lib/db/eval-lab"
import { createEvalExperiment } from "@/lib/db/eval-lab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  buildEvalCandidateEvidence,
  buildPairedQualityComparisons,
  planAdaptiveStage,
  prepareNextEvalStage,
} from "./finalization"

const manifest: EvalExperimentManifest = {
  id: "experiment",
  projectId: "project",
  projectRevision: "sha256:project",
  dataset: {
    datasetId: "dataset",
    version: 1,
    digest: "sha256:dataset",
    caseIds: Array.from({ length: 30 }, (_, index) => `case-${index}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, index) => `case-${index}`),
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: false,
    price: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  mode: "model",
  appVersion: "test",
  scorerVersions: { exact: "1" },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "scanned" },
  randomSeed: 9,
  budget: { currency: "USD", hardCap: 10, confirmed: true },
  judgePolicy: {
    enabled: false,
    calibrated: false,
    anchorCount: 0,
    kappa: 0,
    accuracy: 0,
  },
  decisionPolicy: {
    formal: false,
    dimensions: [
      { metric: "quality", direction: "maximize", weight: 0.8 },
      { metric: "cost", direction: "minimize", weight: 0.2 },
    ],
    constraints: [{ metric: "quality", operator: "gte", value: 0.8 }],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  retentionDays: 90,
  adaptiveRepetitions: { stageOne: 1, maximum: 3 },
  environmentCompatibility: {
    checkedAt: 1,
    runtimeByVariant: { a: { available: true }, b: { available: true } },
    storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
  },
  createdAt: 1,
}

function rows(qualityA: number, qualityB: number) {
  const samples: EvalSampleRow[] = []
  const scores: EvalScoreRow[] = []
  for (const variantId of ["a", "b"]) {
    for (let index = 0; index < 30; index++) {
      const id = `${variantId}-${index}`
      const value = variantId === "a" ? qualityA : qualityB
      samples.push({
        id,
        experimentId: manifest.id,
        taskId: `task-${id}`,
        variantId,
        caseId: `case-${index}`,
        repetition: 1,
        encryptedArtifact: {
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        },
        latencyMs: variantId === "a" ? 100 : 200,
        actualCost: variantId === "a" ? 0.01 : 0.02,
        createdAt: 1,
        expiresAt: 2,
      })
      scores.push({
        id: `score-${id}`,
        experimentId: manifest.id,
        sampleId: id,
        scorerId: "exact",
        scorerVersion: "1",
        status: "scored",
        dimension: "response-quality",
        value,
        passed: value >= 0.8,
        createdAt: 1,
      })
    }
  }
  return { samples, scores }
}

describe("evaluation experiment finalization", () => {
  it("builds normalized quality/reliability/cost/latency evidence with seeded intervals", () => {
    const evidence = buildEvalCandidateEvidence(manifest, rows(1, 0.5))

    expect(evidence).toHaveLength(2)
    expect(evidence[0]).toMatchObject({
      variantId: "a",
      effectiveCases: 30,
      metrics: { quality: 1, reliability: 1, cost: 0.5, latency: 0.5 },
      calibrationPassed: true,
    })
    expect(evidence[1]).toMatchObject({
      variantId: "b",
      metrics: { quality: 0.5, reliability: 0, cost: 1, latency: 1 },
    })
    expect(buildEvalCandidateEvidence(manifest, rows(1, 0.5))).toEqual(evidence)
  })

  it("adds repetitions only for candidates near a constraint or ranking boundary", () => {
    const near = buildEvalCandidateEvidence(manifest, rows(0.8, 0.8))
    const separated = buildEvalCandidateEvidence(manifest, rows(1, 0.5))

    expect(
      planAdaptiveStage(manifest, near, 1)
        .map((item) => item.variantId)
        .sort()
    ).toEqual(["a", "b"])
    expect(planAdaptiveStage(manifest, separated, 1)).toEqual([])
    expect(planAdaptiveStage(manifest, near, 3)).toEqual([])
  })

  it("uses seeded paired bootstrap over the common case denominator", () => {
    const comparison = buildPairedQualityComparisons(manifest, rows(1, 0.5))[0]

    expect(comparison).toMatchObject({
      leftVariantId: "a",
      rightVariantId: "b",
      metric: "quality",
      result: { sampleSize: 30, separated: true, meanDifference: 0.5 },
    })
    expect(buildPairedQualityComparisons(manifest, rows(1, 0.5))[0]).toEqual(comparison)
  })

  describe("persisted stage transition", () => {
    beforeEach(async () => {
      await getDb().delete()
      __resetDbForTesting()
      getDb()
      await whenSeeded()
      await createEvalExperiment(manifest)
    }, 30_000)

    afterAll(async () => {
      await getDb().delete()
      __resetDbForTesting()
    })

    async function persistStage(qualityA: number, qualityB: number) {
      const evidenceRows = rows(qualityA, qualityB)
      await getDb().evalSamples.bulkAdd(evidenceRows.samples)
      await getDb().evalScores.bulkAdd(evidenceRows.scores)
      await getDb().evalTasks.bulkAdd(
        evidenceRows.samples.map((sample) => ({
          id: sample.taskId,
          experimentId: manifest.id,
          variantId: sample.variantId,
          caseId: sample.caseId,
          repetition: 1 as const,
          state: "completed" as const,
          attempt: 1,
          reservedCost: 0,
          estimatedWorstCaseCost: 0.1,
          providerId: `provider-${sample.variantId}`,
          updatedAt: 1,
        }))
      )
    }

    it("persists adaptive repetition tasks before allowing completion", async () => {
      await persistStage(0.8, 0.8)

      await expect(prepareNextEvalStage(manifest.id)).resolves.toBe(true)
      const repetitions = await getDb()
        .evalTasks.where("experimentId")
        .equals(manifest.id)
        .toArray()
      expect(repetitions.filter((task) => task.repetition === 2)).toHaveLength(60)
      expect(await getDb().evalExperiments.get(manifest.id)).toMatchObject({ state: "queued" })
    })

    it("persists the recommendation and paired comparisons when evidence is separated", async () => {
      await persistStage(1, 0.5)

      await expect(prepareNextEvalStage(manifest.id)).resolves.toBe(false)
      const recommendation = await getDb()
        .evalRecommendations.where("experimentId")
        .equals(manifest.id)
        .first()
      expect(recommendation).toMatchObject({
        result: { status: "recommended", recommendedVariantId: "a" },
        pairedComparisons: [expect.objectContaining({ leftVariantId: "a", rightVariantId: "b" })],
      })
      await expect(prepareNextEvalStage(manifest.id)).resolves.toBe(false)
      expect(
        await getDb().evalRecommendations.where("experimentId").equals(manifest.id).count()
      ).toBe(1)
    })

    it("returns no conclusion until formal blinded pairwise review is resolved", async () => {
      const formalManifest: EvalExperimentManifest = {
        ...manifest,
        judgePolicy: {
          enabled: true,
          providerId: "judge",
          modelId: "judge-model",
          isLocal: true,
          calibrated: true,
          anchorCount: 30,
          kappa: 0.7,
          accuracy: 0.9,
        },
        decisionPolicy: { ...manifest.decisionPolicy, formal: true },
      }
      await getDb().evalExperiments.update(manifest.id, { manifest: formalManifest })
      await persistStage(1, 0.5)

      await expect(prepareNextEvalStage(manifest.id)).resolves.toBe(false)

      await expect(
        getDb().evalRecommendations.where("experimentId").equals(manifest.id).first()
      ).resolves.toMatchObject({
        result: { status: "no_conclusion", reason: "review_pending" },
      })
    })

    it("rejects finalization for an unknown experiment", async () => {
      await expect(prepareNextEvalStage("missing")).rejects.toThrow("not found")
    })
  })
})
