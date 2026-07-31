/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { EvalExperimentManifest, EvalProject, EvalTask } from "@cognia/eval-core"
import {
  completeEvalTask,
  createEvalExperiment,
  deleteExpiredEvalArtifacts,
  getEvalExperiment,
  getLatestEvalConfigurationApply,
  listEvalExperiments,
  listEvalProjects,
  markEvalAssetCleared,
  recoverInterruptedEvalWork,
  saveEvalAsset,
  saveEvalProject,
} from "./eval-lab"
import { __resetDbForTesting, getDb } from "./schema"

const project: EvalProject = {
  id: "project-1",
  name: "Selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 1,
    digest: "sha256:data",
    caseIds: ["case-1"],
    holdoutCaseIds: ["case-1"],
    requiredModalities: ["text"],
  },
  variants: [],
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 1, confirmed: true },
  judgePolicy: {
    enabled: false,
    calibrated: false,
    anchorCount: 0,
    kappa: 0,
    accuracy: 0,
  },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
}

const manifest: EvalExperimentManifest = {
  id: "experiment-1",
  projectId: project.id,
  projectRevision: "sha256:project",
  dataset: project.dataset,
  variants: [],
  mode: "model",
  appVersion: "1.0.0",
  scorerVersions: { exact: "1" },
  privacyPolicy: project.privacyPolicy,
  randomSeed: 42,
  budget: project.budget,
  judgePolicy: project.judgePolicy,
  decisionPolicy: project.decisionPolicy,
  retentionDays: 90,
  adaptiveRepetitions: { stageOne: 1, maximum: 3 },
  environmentCompatibility: {
    checkedAt: 1,
    runtimeByVariant: { a: { available: true }, b: { available: true } },
    storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
  },
  createdAt: 2,
}

describe("evaluation lab persistence", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterAll(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("opens every v137 evaluation table and persists projects", async () => {
    await saveEvalProject(project)

    expect((await listEvalProjects()).map((item) => item.id)).toEqual([project.id])
    expect(getDb().verno).toBeGreaterThanOrEqual(137)
    expect(getDb().tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "evalProjects",
        "evalExperiments",
        "evalTasks",
        "evalSamples",
        "evalScores",
        "evalReviewVotes",
        "evalAssets",
      ])
    )
  })

  it("keeps experiment manifests immutable", async () => {
    await createEvalExperiment(manifest)
    await expect(createEvalExperiment({ ...manifest, randomSeed: 7 })).rejects.toThrow(/exists/i)
    await expect(getEvalExperiment(manifest.id)).resolves.toMatchObject({
      manifest,
      state: "draft",
      spentCost: 0,
      reservedCost: 0,
    })
  })

  it("persists the encrypted sample and scores before completing its task", async () => {
    await createEvalExperiment(manifest)
    const task: EvalTask = {
      id: "task-1",
      experimentId: manifest.id,
      variantId: "variant-1",
      caseId: "case-1",
      repetition: 1,
      state: "running",
      attempt: 1,
      reservedCost: 0.2,
      updatedAt: 3,
    }
    await getDb().evalTasks.add(task)

    await completeEvalTask({
      task,
      sample: {
        id: "sample-1",
        experimentId: manifest.id,
        taskId: task.id,
        variantId: task.variantId,
        caseId: task.caseId,
        repetition: 1,
        encryptedArtifact: {
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        },
        latencyMs: 10,
        actualCost: 0.1,
        createdAt: 4,
        expiresAt: 5,
      },
      scores: [
        {
          id: "score-1",
          experimentId: manifest.id,
          sampleId: "sample-1",
          scorerId: "exact",
          scorerVersion: "1",
          value: 1,
          passed: true,
          createdAt: 4,
        },
      ],
    })

    await expect(getDb().evalSamples.get("sample-1")).resolves.toBeDefined()
    await expect(getDb().evalScores.get("score-1")).resolves.toBeDefined()
    await expect(getDb().evalTasks.get(task.id)).resolves.toMatchObject({
      state: "completed",
      reservedCost: 0,
    })
    await expect(getEvalExperiment(manifest.id)).resolves.toMatchObject({
      spentCost: 0.1,
      reservedCost: 0,
    })
  })

  it("marks ambiguous in-flight work interrupted on recovery", async () => {
    await createEvalExperiment(manifest)
    await getDb().evalExperiments.update(manifest.id, { state: "running" })
    await getDb().evalTasks.bulkAdd([
      {
        id: "ambiguous",
        experimentId: manifest.id,
        variantId: "v1",
        caseId: "c1",
        repetition: 1,
        state: "running",
        attempt: 1,
        reservedCost: 0.2,
        updatedAt: 4,
      },
      {
        id: "safe",
        experimentId: manifest.id,
        variantId: "v1",
        caseId: "c2",
        repetition: 1,
        state: "running",
        attempt: 1,
        reservedCost: 0.2,
        idempotencyKey: "verified-provider-key",
        updatedAt: 4,
      },
    ])

    const recovered = await recoverInterruptedEvalWork(manifest.id)

    expect(recovered).toEqual({ interruptedTaskIds: ["ambiguous"], requeuedTaskIds: ["safe"] })
    await expect(getDb().evalTasks.get("ambiguous")).resolves.toMatchObject({
      state: "interrupted",
      reservedCost: 0,
      interruptionSpendAmbiguous: true,
    })
    await expect(getDb().evalTasks.get("safe")).resolves.toMatchObject({
      state: "queued",
      reservedCost: 0,
    })
    await expect(getEvalExperiment(manifest.id)).resolves.toMatchObject({
      state: "interrupted",
      reservedCost: 0,
    })
  })

  it("requeues only verified-idempotent in-flight work without requiring ambiguity review", async () => {
    await createEvalExperiment(manifest)
    await getDb().evalExperiments.update(manifest.id, { state: "running", reservedCost: 0.2 })
    await getDb().evalTasks.add({
      id: "safe-only",
      experimentId: manifest.id,
      variantId: "v1",
      caseId: "c1",
      repetition: 1,
      state: "running",
      attempt: 1,
      reservedCost: 0.2,
      idempotencyKey: "verified-provider-key",
      updatedAt: 4,
    })

    await recoverInterruptedEvalWork(manifest.id)

    await expect(getEvalExperiment(manifest.id)).resolves.toMatchObject({
      state: "queued",
      reservedCost: 0,
    })
  })

  it("lists project experiments and restores the latest apply record", async () => {
    await createEvalExperiment(manifest)
    await getDb().evalConfigurationApplies.bulkAdd([
      {
        id: "apply-old",
        experimentId: manifest.id,
        targetType: "default-model",
        targetId: "global",
        previousConfiguration: {},
        appliedConfiguration: { modelId: "old" },
        appliedAt: 3,
      },
      {
        id: "apply-new",
        experimentId: manifest.id,
        targetType: "default-model",
        targetId: "global",
        previousConfiguration: {},
        appliedConfiguration: { modelId: "new" },
        appliedAt: 4,
      },
    ])

    await expect(listEvalExperiments(project.id)).resolves.toEqual([
      expect.objectContaining({ id: manifest.id }),
    ])
    await expect(getLatestEvalConfigurationApply(manifest.id)).resolves.toMatchObject({
      id: "apply-new",
    })
  })

  it("deletes expired samples and only unreferenced expired assets", async () => {
    await getDb().evalSamples.add({
      id: "expired-sample",
      experimentId: manifest.id,
      taskId: "task",
      variantId: "variant",
      caseId: "case",
      repetition: 1,
      encryptedArtifact: {
        version: "cognia-eval-encrypted/v1",
        algorithm: "AES-GCM",
        iv: "iv",
        ciphertext: "ciphertext",
      },
      latencyMs: 1,
      actualCost: 0,
      createdAt: 1,
      expiresAt: 5,
    })
    const encryptedBytes = {
      version: "cognia-eval-encrypted/v1" as const,
      algorithm: "AES-GCM" as const,
      iv: "iv",
      ciphertext: "ciphertext",
    }
    await getDb().evalAssets.bulkAdd([
      {
        digest: "expired-unused",
        mediaType: "image/png",
        size: 1,
        encryptedBytes,
        referenceCount: 0,
        createdAt: 1,
        expiresAt: 5,
      },
      {
        digest: "expired-referenced",
        mediaType: "image/png",
        size: 1,
        encryptedBytes,
        referenceCount: 1,
        createdAt: 1,
        expiresAt: 5,
      },
    ])

    await expect(deleteExpiredEvalArtifacts(5)).resolves.toEqual({
      samplesDeleted: 1,
      assetsDeleted: 1,
    })
    await expect(getDb().evalAssets.get("expired-referenced")).resolves.toBeDefined()
  })

  it("binds scan or identified manual clearance to the content digest", async () => {
    await getDb().evalAssets.add({
      digest: "sha256:media",
      mediaType: "image/png",
      size: 1,
      encryptedBytes: {
        version: "cognia-eval-encrypted/v1",
        algorithm: "AES-GCM",
        iv: "iv",
        ciphertext: "ciphertext",
      },
      referenceCount: 1,
      createdAt: 1,
      expiresAt: 10,
    })

    await expect(
      markEvalAssetCleared("sha256:media", { method: "manual" } as never, 5)
    ).rejects.toThrow(/identity/i)
    await markEvalAssetCleared("sha256:media", { method: "manual", actorId: "reviewer-1" }, 6)
    await expect(getDb().evalAssets.get("sha256:media")).resolves.toMatchObject({
      clearance: {
        method: "manual",
        actorId: "reviewer-1",
        clearedAt: 6,
        contentDigest: "sha256:media",
      },
    })

    await expect(
      markEvalAssetCleared(
        "sha256:media",
        { method: "scan", scannerId: "scanner-1", evidenceDigest: "sha256:evidence" },
        7
      )
    ).resolves.toBeUndefined()
    await expect(getDb().evalAssets.get("sha256:media")).resolves.toMatchObject({
      clearance: {
        method: "scan",
        scannerId: "scanner-1",
        evidenceDigest: "sha256:evidence",
        clearedAt: 7,
      },
    })
  })

  it("deduplicates stored assets while rejecting digest metadata mismatches", async () => {
    const asset = {
      digest: "sha256:deduplicated",
      mediaType: "image/png",
      size: 1,
      encryptedBytes: {
        version: "cognia-eval-encrypted/v1" as const,
        algorithm: "AES-GCM" as const,
        iv: "iv",
        ciphertext: "ciphertext",
      },
      referenceCount: 0,
      createdAt: 1,
      expiresAt: 10,
    }
    await saveEvalAsset(asset)
    await saveEvalAsset({ ...asset, expiresAt: 20 })
    await expect(getDb().evalAssets.get(asset.digest)).resolves.toMatchObject({ expiresAt: 20 })
    await expect(saveEvalAsset({ ...asset, size: 2 })).rejects.toThrow(/metadata/i)
  })
})
