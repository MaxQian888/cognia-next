/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { EvalExperimentManifest } from "@cognia/eval-core"
import type {
  EvalExperimentRow,
  EvalRecommendationRow,
  EvalSampleRow,
  EvalScoreRow,
  EvalTaskRow,
} from "@/lib/db/eval-lab"
import type { EvalCase, EvalSample } from "@/types/eval/eval"
import { encryptEvalArtifact } from "./artifact-crypto"
import { filterEvalReportCases, loadEvalReportView } from "./report-view"
import { createEvalExperiment } from "@/lib/db/eval-lab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

const manifest = {
  id: "experiment",
  projectId: "project",
  projectRevision: "sha256:project",
  dataset: {
    datasetId: "dataset",
    version: 1,
    digest: "sha256:dataset",
    caseIds: ["case"],
    holdoutCaseIds: ["case"],
    requiredModalities: ["text"],
  },
  variants: [
    {
      id: "variant",
      name: "Variant",
      kind: "model",
      providerId: "provider",
      modelId: "model",
      runtimeTarget: "web",
      isLocal: false,
      price: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
      capabilities: ["text"],
      available: true,
      credentialReady: true,
    },
  ],
  mode: "model",
  appVersion: "test",
  scorerVersions: { exact: "1" },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "scanned" },
  randomSeed: 1,
  budget: { currency: "USD", hardCap: 2, confirmed: true },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 1,
  },
  retentionDays: 90,
  adaptiveRepetitions: { stageOne: 1, maximum: 3 },
  environmentCompatibility: {
    checkedAt: 1,
    runtimeByVariant: { a: { available: true }, b: { available: true } },
    storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
  },
  createdAt: 1,
} satisfies EvalExperimentManifest

const envelope = (ciphertext: string) => ({
  version: "cognia-eval-encrypted/v1" as const,
  algorithm: "AES-GCM" as const,
  iv: "iv",
  ciphertext,
})

describe("evaluation report view", () => {
  it("decrypts case evidence and combines recommendation, cost, errors, and provenance", async () => {
    const experiment: EvalExperimentRow = {
      id: manifest.id,
      projectId: manifest.projectId,
      manifest,
      state: "completed",
      spentCost: 0.02,
      reservedCost: 0,
      budgetCap: 2,
      budgetExtensions: [],
      createdAt: 1,
      updatedAt: 2,
    }
    const task: EvalTaskRow = {
      id: "task",
      experimentId: manifest.id,
      variantId: "variant",
      caseId: "case",
      repetition: 1,
      state: "completed",
      attempt: 1,
      reservedCost: 0,
      estimatedWorstCaseCost: 0.5,
      providerId: "provider",
      lastError: "retried once",
      updatedAt: 2,
    }
    const sampleRow: EvalSampleRow = {
      id: "sample",
      experimentId: manifest.id,
      taskId: task.id,
      variantId: "variant",
      caseId: "case",
      repetition: 1,
      encryptedArtifact: envelope("artifact"),
      latencyMs: 100,
      actualCost: 0.02,
      createdAt: 2,
      expiresAt: 3,
    }
    const score: EvalScoreRow = {
      id: "score",
      experimentId: manifest.id,
      sampleId: sampleRow.id,
      scorerId: "exact",
      scorerVersion: "1",
      status: "scored",
      dimension: "response-quality",
      value: 1,
      passed: true,
      encryptedReasoning: envelope("reasoning"),
      createdAt: 2,
    }
    const recommendation: EvalRecommendationRow = {
      id: "recommendation",
      experimentId: manifest.id,
      result: {
        status: "recommended",
        recommendedVariantId: "variant",
        paretoVariantIds: ["variant"],
        utilityByVariant: { variant: 1 },
        excluded: [],
      },
      evidenceDigest: "sha256:evidence",
      createdAt: 3,
    }
    const evalCase: EvalCase = {
      id: "case",
      datasetId: "dataset",
      input: "private",
      capability: "chat.qa",
      source: "handwritten",
      tags: ["release"],
      split: "test",
      createdAt: 1,
      updatedAt: 1,
    }
    const sample: EvalSample = {
      output: "answer",
      toolCalls: [],
      retrievedChunks: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.02,
      latencyMs: 100,
      stepCount: 1,
      degraded: false,
    }

    const view = await loadEvalReportView(manifest.id, new Uint8Array(32), {
      loadExperiment: async () => experiment,
      loadTasks: async () => [task],
      loadSamples: async () => [sampleRow],
      loadScores: async () => [score],
      loadRecommendations: async () => [recommendation],
      decryptArtifact: async <T>(_key: Uint8Array, encrypted: { ciphertext: string }) =>
        (encrypted.ciphertext === "artifact"
          ? { case: evalCase, sample, variantId: "variant", repetition: 1 }
          : { reasoning: "exact match" }) as T,
    })

    expect(view.recommendation?.result.recommendedVariantId).toBe("variant")
    expect(view.cost).toEqual({ actual: 0.02, estimatedWorstCase: 0.5, hardCap: 2 })
    expect(view.providerErrors).toEqual([
      { taskId: "task", providerId: "provider", error: "retried once" },
    ])
    expect(view.cases[0]).toMatchObject({
      case: { input: "private" },
      sample: { output: "answer" },
      scores: [{ scorerId: "exact", reasoning: "exact match" }],
    })
    expect(
      filterEvalReportCases(view.cases, { tag: "release", variantId: "variant" })
    ).toHaveLength(1)
    expect(filterEvalReportCases(view.cases, { status: "failed" })).toHaveLength(0)
  })

  it("rejects unknown experiments and filters every supported evidence dimension", async () => {
    await expect(
      loadEvalReportView("missing", new Uint8Array(32), {
        loadExperiment: async () => undefined,
        loadTasks: async () => [],
        loadSamples: async () => [],
        loadScores: async () => [],
        loadRecommendations: async () => [],
        decryptArtifact: async <T>() => ({}) as T,
      })
    ).rejects.toThrow("not found")

    const cases = [
      {
        case: { split: "test", tags: ["release"] },
        variantId: "a",
        scores: [{ scorerId: "exact" }],
        status: "passed",
      },
    ] as never
    expect(filterEvalReportCases(cases, { split: "train" })).toEqual([])
    expect(filterEvalReportCases(cases, { tag: "missing" })).toEqual([])
    expect(filterEvalReportCases(cases, { variantId: "b" })).toEqual([])
    expect(filterEvalReportCases(cases, { scorerId: "judge" })).toEqual([])
    expect(filterEvalReportCases(cases, { status: "errored" })).toEqual([])
    expect(filterEvalReportCases(cases, { split: "test", scorerId: "exact" })).toHaveLength(1)
  })

  it("loads persisted encrypted evidence through the production Dexie dependencies", async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await createEvalExperiment(manifest)
    await getDb().evalExperiments.update(manifest.id, { state: "completed" })
    const key = crypto.getRandomValues(new Uint8Array(32))
    const persistedCase: EvalCase = {
      id: "case",
      datasetId: "dataset",
      input: "input",
      capability: "chat.qa",
      source: "handwritten",
      split: "test",
      createdAt: 1,
      updatedAt: 1,
    }
    const persistedSample: EvalSample = {
      output: "output",
      toolCalls: [],
      retrievedChunks: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.1,
      latencyMs: 10,
      stepCount: 1,
      degraded: false,
    }
    await getDb().evalTasks.add({
      id: "task-default",
      experimentId: manifest.id,
      variantId: "variant",
      caseId: "case",
      repetition: 1,
      state: "completed",
      attempt: 1,
      reservedCost: 0,
      estimatedWorstCaseCost: 0.2,
      updatedAt: 1,
    })
    await getDb().evalSamples.add({
      id: "sample-default",
      experimentId: manifest.id,
      taskId: "task-default",
      variantId: "variant",
      caseId: "case",
      repetition: 1,
      encryptedArtifact: await encryptEvalArtifact(key, {
        case: persistedCase,
        sample: persistedSample,
        variantId: "variant",
        repetition: 1,
      }),
      latencyMs: 10,
      actualCost: 0.1,
      createdAt: 1,
      expiresAt: 2,
    })
    await getDb().evalScores.bulkAdd([
      {
        id: "score-default",
        experimentId: manifest.id,
        sampleId: "sample-default",
        scorerId: "exact",
        scorerVersion: "1",
        value: 0,
        passed: false,
        status: "errored",
        error: "scorer failed",
        encryptedReasoning: await encryptEvalArtifact(key, { reasoning: "invalid" }),
        createdAt: 1,
      },
    ])

    const view = await loadEvalReportView(manifest.id, key)

    expect(view.cases[0]).toMatchObject({
      status: "errored",
      sample: { output: "output" },
      scores: [{ reasoning: "invalid" }],
    })
    expect(view.cost).toMatchObject({ actual: 0.1, estimatedWorstCase: 0.2, hardCap: 2 })
    await getDb().delete()
    __resetDbForTesting()
  }, 30_000)
})
