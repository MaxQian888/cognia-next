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
    cost: 0,
    latency: 0,
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
