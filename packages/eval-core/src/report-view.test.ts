import {
  buildEvalReportView,
  filterEvalReportCases,
  type EvalReportInput,
  type EvalReportCaseInput,
} from "./report-view"
import type { EvalExperimentManifest } from "./types"

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

const evidenceCase: EvalReportCaseInput = {
  case: {
    id: "case",
    datasetId: "dataset",
    input: "question",
    capability: "chat.qa",
    source: "handwritten",
    split: "test",
    tags: ["release"],
    createdAt: 1,
    updatedAt: 1,
  },
  sample: {
    output: "answer",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.02,
    latencyMs: 100,
    stepCount: 1,
    degraded: false,
  },
  variantId: "variant",
  repetition: 1,
  sampleId: "sample",
  taskId: "task",
  scores: [
    {
      id: "score",
      scorerId: "exact",
      scorerVersion: "1",
      value: 1,
      passed: true,
      reasoning: "matched",
    },
  ],
}
function input(): EvalReportInput {
  return {
    experiment: {
      id: manifest.id,
      projectId: manifest.projectId,
      manifest,
      state: "completed",
      createdAt: 1,
      updatedAt: 2,
    },
    tasks: [
      { id: "task", estimatedWorstCaseCost: 0.5, providerId: "provider", lastError: "retried" },
      { id: "unpriced" },
    ],
    samples: [
      { id: "sample", variantId: "variant", caseId: "case", actualCost: 0.02, latencyMs: 100 },
    ],
    scores: [{ sampleId: "sample", scorerId: "exact", value: 1, passed: true }],
    recommendations: [],
    cases: [evidenceCase],
  }
}

test("projects costs, errors and public fields without returning persistence internals", () => {
  const source = input()
  const experiment = { ...source.experiment, reservedCost: 42, budgetCap: 3 }
  const score = {
    ...evidenceCase.scores[0],
    encryptedReasoning: { ciphertext: "secret" },
    metadata: { private: true },
  }
  const view = buildEvalReportView({
    ...source,
    experiment,
    cases: [{ ...evidenceCase, scores: [score] }],
  })
  expect(view.cost).toEqual({ actual: 0.02, estimatedWorstCase: 0.5, hardCap: 3 })
  expect(buildEvalReportView(source).cost.hardCap).toBe(2)
  expect(view.providerErrors).toEqual([
    { taskId: "task", providerId: "provider", error: "retried" },
  ])
  expect(view.experiment).not.toHaveProperty("reservedCost")
  expect(view.cases[0].scores[0]).toMatchObject({ reasoning: "matched", scorerId: "exact" })
  expect(view.cases[0].scores[0]).not.toHaveProperty("metadata")
  expect(JSON.stringify(view)).not.toContain("ciphertext")
  expect(view.evidence[0].metrics.quality).toBe(1)
})

test("selects the newest recommendation without reordering input", () => {
  const source = input()
  const result = {
    status: "no_conclusion" as const,
    reason: "review_pending" as const,
    paretoVariantIds: [],
    utilityByVariant: {},
    excluded: [],
  }
  const first = {
    id: "old",
    result,
    evidenceDigest: "old",
    createdAt: 1,
    experimentId: "private-db-link",
  }
  const latest = { ...first, id: "new", createdAt: 2 }
  const recommendations = [first, latest]
  const view = buildEvalReportView({ ...source, recommendations })
  expect(view.recommendation?.id).toBe("new")
  expect(view.recommendation?.result.reason).toBe("review_pending")
  expect(view.recommendation).not.toHaveProperty("experimentId")
  expect(recommendations.map((item) => item.id)).toEqual(["old", "new"])
  expect(buildEvalReportView(source).recommendation).toBeUndefined()
})

test("preserves legacy-score, ungraded, failed and errored case statuses", () => {
  const source = input()
  const score = evidenceCase.scores[0]
  const cases: EvalReportCaseInput[] = [
    evidenceCase,
    { ...evidenceCase, scores: [{ ...score, passed: false, status: "scored" }] },
    { ...evidenceCase, scores: [{ ...score, status: "measurement" }] },
    { ...evidenceCase, scores: [] },
    { ...evidenceCase, sample: { ...evidenceCase.sample, error: "provider error" } },
    { ...evidenceCase, scores: [{ ...score, status: "errored" }] },
  ]
  expect(buildEvalReportView({ ...source, cases }).cases.map((item) => item.status)).toEqual([
    "passed",
    "failed",
    "failed",
    "failed",
    "errored",
    "errored",
  ])
})

test("filters every report dimension with combined AND semantics", () => {
  const cases = buildEvalReportView(input()).cases
  expect(
    filterEvalReportCases(cases, {
      split: "test",
      tag: "release",
      variantId: "variant",
      scorerId: "exact",
      status: "passed",
    })
  ).toEqual(cases)
  for (const filters of [
    { split: "train" },
    { tag: "other" },
    { variantId: "other" },
    { scorerId: "other" },
    { status: "failed" as const },
  ]) {
    expect(filterEvalReportCases(cases, filters)).toEqual([])
  }
})
