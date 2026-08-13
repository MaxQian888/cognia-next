import {
  assessCaptureComparisonEligibility,
  compareMetricSeries,
  evaluateBudget,
  type CaptureComparisonDescriptor,
  type PerfBudgetSnapshot,
} from "./comparison"

describe("performance comparison", () => {
  it("uses median, type-7 p95, MAD, absolute delta, and N/A percent for a zero baseline", () => {
    const result = compareMetricSeries([0, 0, 0, 0], [1, 2, 3, 4])
    expect(result.baseline).toMatchObject({ median: 0, p95: 0, mad: 0 })
    expect(result.candidate.median).toBe(2.5)
    expect(result.candidate.p95).toBeCloseTo(3.85)
    expect(result.absoluteDelta).toBe(2.5)
    expect(result.percentDelta).toBeNull()
  })

  it("excludes invalid, reset, missed, and missing intervals", () => {
    const result = compareMetricSeries(
      [
        { value: 10, valid: true },
        { value: 0, valid: false },
        { value: null, valid: true },
      ],
      [{ value: 12, valid: true }]
    )
    expect(result.baseline.count).toBe(1)
    expect(result.candidate.count).toBe(1)
  })

  it("requires data quality and immutable matching budget metadata for a verdict", () => {
    const budget: PerfBudgetSnapshot = {
      id: "budget-1",
      version: 2,
      immutable: true,
      metricId: "renderer.long-task.p95",
      metricDefinitionVersion: 1,
      unit: "ms",
      sourceKind: "renderer",
      metricSchemaVersion: 1,
      requestedCadenceMs: 1000,
      direction: "lower",
      warningThreshold: 40,
      failureThreshold: 50,
      comparisonWindow: "interval",
    }
    expect(
      evaluateBudget({
        value: 55,
        validIntervals: 9,
        expectedIntervals: 10,
        continuousIncarnation: true,
        metadataMatches: true,
        environmentMatches: true,
        environmentMismatchAccepted: false,
        budget,
      })
    ).toEqual({ verdict: "insufficient-data", reason: "minimum-valid-intervals" })

    expect(
      evaluateBudget({
        value: 55,
        validIntervals: 18,
        expectedIntervals: 20,
        continuousIncarnation: true,
        metadataMatches: true,
        environmentMatches: true,
        environmentMismatchAccepted: false,
        budget,
      })
    ).toEqual({ verdict: "fail", reason: null })
  })
})

describe("capture comparison eligibility", () => {
  const descriptor: CaptureComparisonDescriptor = {
    metricId: "process.main.cpuPct",
    metricDefinitionVersion: 1,
    unit: "%",
    sourceKind: "host",
    metricSchemaVersion: 1,
    requestedCadenceMs: 1000,
    validIntervals: 10,
    expectedIntervals: 11,
    samplingSessionIds: ["session-a"],
    incarnationIds: ["process-a"],
    environmentFingerprint: "environment-a",
  }

  it("requires matching metadata, 90% coverage, and continuous incarnations", () => {
    expect(assessCaptureComparisonEligibility(descriptor, { ...descriptor })).toMatchObject({
      eligible: true,
      reasons: [],
    })
    const rejected = assessCaptureComparisonEligibility(descriptor, {
      ...descriptor,
      requestedCadenceMs: 2000,
      validIntervals: 9,
      samplingSessionIds: ["session-a", "session-b"],
    })
    expect(rejected.eligible).toBe(false)
    expect(rejected.reasons).toEqual(
      expect.arrayContaining([
        "minimum-valid-intervals",
        "minimum-coverage",
        "requested-cadence-mismatch",
        "discontinuous-incarnation",
      ])
    )
  })

  it("records an explicit environment override without bypassing other requirements", () => {
    const overridden = assessCaptureComparisonEligibility(
      descriptor,
      { ...descriptor, environmentFingerprint: "environment-b" },
      { environmentMismatchAccepted: true }
    )
    expect(overridden).toMatchObject({ eligible: true, environmentMismatchAccepted: true })
    expect(
      assessCaptureComparisonEligibility(
        descriptor,
        { ...descriptor, metricSchemaVersion: 2, environmentFingerprint: "environment-b" },
        { environmentMismatchAccepted: true }
      ).reasons
    ).toContain("metric-schema-mismatch")
  })
})
