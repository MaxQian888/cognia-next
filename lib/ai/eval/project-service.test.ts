/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { EvalEnvironmentCompatibility, EvalProject } from "@cognia/eval-core"
import { EvalProjectService } from "./project-service"
import { saveEvalProject } from "@/lib/db/eval-lab"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

const project = (): EvalProject => ({
  id: "project-1",
  name: "Selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 2,
    digest: "sha256:dataset",
    caseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: true,
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 10, confirmed: true },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

const environment: EvalEnvironmentCompatibility = {
  checkedAt: 50,
  runtimeByVariant: { a: { available: true }, b: { available: true } },
  storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
}

describe("EvalProjectService v2", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await saveEvalProject(project())
  })

  afterAll(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("preflights and atomically queues every stage-one variant × holdout case", async () => {
    let id = 0
    const service = new EvalProjectService({ now: () => 100, newId: () => `id-${id++}` })

    await expect(service.preflight("project-1", environment)).resolves.toMatchObject({ ok: true })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: { exact: "1" },
      randomSeed: 42,
      environmentCompatibility: environment,
    })

    expect(experiment.state).toBe("queued")
    expect(experiment.manifest.adaptiveRepetitions).toEqual({ stageOne: 1, maximum: 3 })
    expect(experiment.manifest.retentionDays).toBe(90)
    expect(experiment.manifest.environmentCompatibility).toEqual(environment)
    expect(await getDb().evalTasks.where("experimentId").equals(experiment.id).count()).toBe(60)
    expect(
      await getDb().evalTasks.where("experimentId").equals(experiment.id).first()
    ).toMatchObject({
      repetition: 1,
      state: "queued",
    })
  })

  it("reserves cloud judge calls even when the evaluated target runs locally", async () => {
    const formal = project()
    formal.decisionPolicy.formal = true
    formal.judgePolicy = {
      enabled: true,
      providerId: "judge-provider",
      modelId: "judge-model",
      isLocal: false,
      price: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
      maxOutputTokens: 300,
      secondJudgeProviderId: "second-judge-provider",
      secondJudgeModelId: "second-judge-model",
      secondJudgeIsLocal: false,
      secondJudgePrice: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
      calibrated: true,
      anchorCount: 30,
      kappa: 0.7,
      accuracy: 0.9,
    }
    await saveEvalProject(formal)
    const service = new EvalProjectService({ now: () => 100, newId: () => crypto.randomUUID() })

    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    const firstTask = await getDb().evalTasks.where("experimentId").equals(experiment.id).first()
    expect(firstTask?.estimatedWorstCaseCost).toBeGreaterThan(0)
  })

  it("runs the concrete environment adapter before returning verified preflight", async () => {
    const checkEnvironment = jest.fn(async () => environment)
    const service = new EvalProjectService({ checkEnvironment })

    await expect(service.environment("project-1")).resolves.toEqual(environment)
    await expect(service.verifiedPreflight("project-1")).resolves.toMatchObject({
      environmentCompatibility: environment,
      result: { ok: true },
    })
    expect(checkEnvironment).toHaveBeenCalledTimes(2)
  })

  it("persists pause/resume/cancel states and exposes report evidence", async () => {
    const service = new EvalProjectService({ now: () => 100, newId: () => crypto.randomUUID() })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    await service.pause(experiment.id)
    await expect(service.status(experiment.id)).resolves.toMatchObject({
      experiment: { state: "paused" },
    })
    await service.resume(experiment.id)
    await expect(service.status(experiment.id)).resolves.toMatchObject({
      experiment: { state: "queued" },
    })
    await service.cancel(experiment.id)
    await expect(service.report(experiment.id)).resolves.toMatchObject({
      experiment: { state: "cancelled" },
      tasks: { cancelled: 60 },
      recommendations: [],
    })
  })

  it("extends the active budget without mutating the immutable manifest", async () => {
    const service = new EvalProjectService({ now: () => 250, newId: () => crypto.randomUUID() })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    await service.extendBudget(experiment.id, 15)
    const updated = await getDb().evalExperiments.get(experiment.id)

    expect(updated).toMatchObject({
      budgetCap: 15,
      budgetExtensions: [{ previousCap: 10, nextCap: 15, createdAt: 250 }],
    })
    expect(updated?.manifest.budget.hardCap).toBe(10)
    await expect(service.extendBudget(experiment.id, 15)).rejects.toThrow("greater")
  })
})
