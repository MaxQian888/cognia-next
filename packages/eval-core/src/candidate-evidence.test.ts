import {
  buildEvalCandidateEvidence,
  buildPairedQualityComparisons,
  type EvalEvidenceInput,
  type EvalEvidenceManifest,
} from "./candidate-evidence"

const manifest: EvalEvidenceManifest = {
  randomSeed: 9,
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model",
    providerId: id,
    modelId: id,
    runtimeTarget: "web",
    isLocal: false,
    price: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
    capabilities: ["text"],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 1,
  },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
}

function rows(): EvalEvidenceInput {
  return {
    samples: [
      { id: "a1", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 10 },
      { id: "a2", variantId: "a", caseId: "two", actualCost: 1, latencyMs: 10 },
      { id: "b1", variantId: "b", caseId: "one", actualCost: 2, latencyMs: 20 },
    ],
    scores: [
      { sampleId: "a1", scorerId: "exact", value: 1, passed: true },
      { sampleId: "a2", scorerId: "exact", value: 1, passed: true, status: "scored" },
      { sampleId: "b1", scorerId: "exact", value: 0.5, passed: false, status: "scored" },
    ],
  }
}

test("normalizes metrics with deterministic intervals from persistence-free observations", () => {
  const evidence = buildEvalCandidateEvidence(manifest, rows())
  expect(evidence[0]).toMatchObject({
    variantId: "a",
    effectiveCases: 2,
    metrics: { quality: 1, reliability: 1, cost: 0.5, latency: 0.5 },
    calibrationPassed: true,
  })
  expect(evidence[1]).toMatchObject({
    variantId: "b",
    effectiveCases: 1,
    metrics: { quality: 0.5, reliability: 0, cost: 1, latency: 1 },
  })
  expect(buildEvalCandidateEvidence(manifest, rows())).toEqual(evidence)
})

test("does not count measurement or nonapplicable scores as grading", () => {
  const input = rows()
  input.scores = [
    { sampleId: "a1", scorerId: "cost", status: "measurement", value: 1, passed: true },
    { sampleId: "b1", scorerId: "exact", status: "not-applicable", value: 1, passed: true },
  ]
  expect(buildEvalCandidateEvidence(manifest, input).map((item) => item.effectiveCases)).toEqual([
    0, 0,
  ])
  expect(buildEvalCandidateEvidence(manifest, input)[0].metrics).toEqual({
    quality: 0,
    reliability: 0,
    attemptReliability: 0,
    allRepeatReliability: 0,
    cost: 0.5,
    latency: 0.5,
  })
})

test("requires formal calibration and rejects errored judge evidence", () => {
  const formal = { ...manifest, decisionPolicy: { ...manifest.decisionPolicy, formal: true } }
  expect(buildEvalCandidateEvidence(formal, rows())[0].calibrationPassed).toBe(false)
  formal.judgePolicy = {
    ...manifest.judgePolicy,
    calibrated: true,
    anchorCount: 30,
    kappa: 0.6,
    accuracy: 0.8,
  }
  expect(buildEvalCandidateEvidence(formal, rows())[0].calibrationPassed).toBe(true)
  const input = rows()
  input.scores = [
    ...input.scores,
    { sampleId: "a1", scorerId: "judge-rubric", value: 0, passed: false, status: "errored" },
  ]
  expect(buildEvalCandidateEvidence(formal, input)[0].calibrationPassed).toBe(false)
  expect(buildEvalCandidateEvidence(formal, input)[1].calibrationPassed).toBe(true)
})

test("pairs only common cases and averages repetitions before comparison", () => {
  const input = rows()
  input.samples = [
    ...input.samples,
    { id: "a1-repeat", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 10 },
  ]
  input.scores = [
    ...input.scores,
    { sampleId: "a1-repeat", scorerId: "exact", value: 0.5, passed: false },
  ]
  const comparisons = buildPairedQualityComparisons(manifest, input)
  expect(comparisons[0]).toMatchObject({
    leftVariantId: "a",
    rightVariantId: "b",
    metric: "quality",
    result: { sampleSize: 1, meanDifference: 0.25 },
  })
  expect(buildPairedQualityComparisons(manifest, input)).toEqual(comparisons)
  expect(buildPairedQualityComparisons(manifest, { samples: [], scores: [] })).toEqual([])
})

test("includes wholly ungraded attempts in resource accounting without grading them", () => {
  const input = rows()
  input.samples = [
    { id: "a1", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 100 },
    { id: "a2", variantId: "a", caseId: "two", actualCost: 100, latencyMs: 10_000 },
    { id: "b1", variantId: "b", caseId: "one", actualCost: 2, latencyMs: 200 },
  ]
  input.scores = [
    { sampleId: "a1", scorerId: "oracle", value: 1, passed: true, status: "scored" },
    { sampleId: "a2", scorerId: "oracle", value: 0, passed: false, status: "errored" },
    { sampleId: "b1", scorerId: "oracle", value: 1, passed: true, status: "scored" },
  ]
  const evidence = buildEvalCandidateEvidence(manifest, input)
  expect(evidence[0].metrics.cost).toBe(1)
  expect(evidence[1].metrics.cost).toBeCloseTo(2 / 50.5)
  expect(evidence[0].observationCounts).toMatchObject({ attemptedSamples: 2, gradedSamples: 1 })
  expect(evidence[0].resourceTotals?.costUsd).toBe(101)
})

test("clusters repetitions by case rather than over-weighting repeated easy tasks", () => {
  const input = rows()
  input.samples = [
    { id: "a1", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 1 },
    { id: "a2", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 1 },
    { id: "a3", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 1 },
    { id: "a4", variantId: "a", caseId: "two", actualCost: 1, latencyMs: 1 },
  ]
  input.scores = input.samples.map((item, index) => ({
    sampleId: item.id,
    scorerId: "oracle",
    value: index === 3 ? 1 : 0,
    passed: index === 3,
    status: "scored",
  }))
  const evidence = buildEvalCandidateEvidence(manifest, input)[0]
  expect(evidence.metrics.quality).toBe(0.5)
  expect(evidence.metrics.allRepeatReliability).toBe(0.5)
})

test("execution failure cannot produce positive candidate quality from a passing scorer", () => {
  const input = rows()
  input.samples = [
    {
      id: "a1",
      variantId: "a",
      caseId: "one",
      actualCost: 1,
      latencyMs: 100,
      executionStatus: "failed",
    },
  ]
  input.scores = [{ sampleId: "a1", scorerId: "oracle", value: 1, passed: true, status: "scored" }]
  const candidate = buildEvalCandidateEvidence(manifest, input)[0]
  expect(candidate.metrics.quality).toBe(0)
  expect(candidate.metrics.reliability).toBe(0)
  expect(candidate.observationCounts?.executionFailures).toBe(1)
})

test("marks resource evidence partial instead of treating unknown zero as free", () => {
  const input = rows()
  input.samples = [
    {
      id: "a1",
      variantId: "a",
      caseId: "one",
      actualCost: 0,
      latencyMs: 100,
      metricAvailability: { usage: "unavailable", cost: "unavailable", latency: "known" },
    },
    { id: "b1", variantId: "b", caseId: "one", actualCost: 1, latencyMs: 100 },
  ]
  const candidates = buildEvalCandidateEvidence(manifest, input)
  expect(candidates[0].resourceAvailability?.cost).toBe("unavailable")
  expect(candidates[1].resourceAvailability?.cost).toBe("known")
})

test("does not inflate all-repeat reliability by dropping partially observed case clusters", () => {
  const input = rows()
  input.samples = [
    {
      id: "a1",
      variantId: "a",
      caseId: "one",
      actualCost: 1,
      latencyMs: 1,
      expectedRepetitions: 2,
    },
    {
      id: "a2",
      variantId: "a",
      caseId: "one",
      actualCost: 1,
      latencyMs: 1,
      expectedRepetitions: 2,
    },
    {
      id: "a3",
      variantId: "a",
      caseId: "two",
      actualCost: 1,
      latencyMs: 1,
      expectedRepetitions: 2,
    },
  ]
  input.scores = input.samples.map((item) => ({
    sampleId: item.id,
    scorerId: "oracle",
    value: 1,
    passed: true,
    status: "scored",
  }))
  const candidate = buildEvalCandidateEvidence(manifest, input)[0]
  expect(candidate.metrics.allRepeatReliability).toBe(0.5)
  expect(candidate.observationCounts?.incompleteCases).toBe(1)
})

test("keeps all-attempt resources separate from final-output grading", () => {
  const input = rows()
  input.resourceSamples = [
    {
      id: "task-a",
      variantId: "a",
      caseId: "one",
      actualCost: 100,
      latencyMs: 1000,
      executionStatus: "failed",
      metricAvailability: { usage: "unavailable", cost: "partial", latency: "known" },
    },
    { id: "task-b", variantId: "b", caseId: "one", actualCost: 2, latencyMs: 20 },
  ]
  const candidate = buildEvalCandidateEvidence(manifest, input)[0]
  expect(candidate.resourceTotals?.costUsd).toBe(100)
  expect(candidate.resourceTotals?.latencyMs).toBe(1000)
  expect(candidate.resourceAvailability?.cost).toBe("partial")
  expect(candidate.observationCounts?.executionFailures).toBe(1)
  expect(candidate.effectiveCases).toBe(2)
})

test("keeps a terminal failed case in paired quality even without a final output", () => {
  const input: EvalEvidenceInput = {
    samples: [
      { id: "a1", taskId: "ta1", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 1 },
      { id: "b1", taskId: "tb1", variantId: "b", caseId: "one", actualCost: 1, latencyMs: 1 },
      { id: "b2", taskId: "tb2", variantId: "b", caseId: "two", actualCost: 1, latencyMs: 1 },
    ],
    scores: ["a1", "b1", "b2"].map((id) => ({
      sampleId: id,
      scorerId: "oracle",
      value: 1,
      passed: true,
      status: "scored",
    })),
    resourceSamples: [
      { id: "ra1", taskId: "ta1", variantId: "a", caseId: "one", actualCost: 1, latencyMs: 1 },
      {
        id: "ra2",
        taskId: "ta2",
        variantId: "a",
        caseId: "two",
        actualCost: 2,
        latencyMs: 2,
        executionStatus: "failed",
      },
      { id: "rb1", taskId: "tb1", variantId: "b", caseId: "one", actualCost: 1, latencyMs: 1 },
      { id: "rb2", taskId: "tb2", variantId: "b", caseId: "two", actualCost: 1, latencyMs: 1 },
    ],
  }
  const a = buildEvalCandidateEvidence(manifest, input)[0]
  expect(a.metrics.quality).toBe(0.5)
  expect(a.metrics.allRepeatReliability).toBe(0.5)
  expect(a.effectiveCases).toBe(2)
  expect(buildPairedQualityComparisons(manifest, input)[0]).toMatchObject({
    pairedCaseCount: 2,
    result: { meanDifference: -0.5 },
  })
})
