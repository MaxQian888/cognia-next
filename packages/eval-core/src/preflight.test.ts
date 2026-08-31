import { runProjectPreflight } from "./preflight"
import type { EvalEnvironmentCompatibility, EvalProject } from "./types"

const environment: EvalEnvironmentCompatibility = {
  checkedAt: 1,
  runtimeByVariant: {
    a: { available: true },
    b: { available: true },
  },
  storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
}

const project = (): EvalProject => ({
  id: "project-1",
  name: "Support model selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 3,
    digest: "sha256:dataset",
    caseIds: Array.from({ length: 30 }, (_, index) => `case-${index}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, index) => `case-${index}`),
    requiredModalities: ["text"],
  },
  variants: [
    {
      id: "a",
      name: "A",
      kind: "model",
      providerId: "provider-a",
      modelId: "model-a",
      runtimeTarget: "web",
      isLocal: false,
      price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
      capabilities: ["text"],
      available: true,
      credentialReady: true,
    },
    {
      id: "b",
      name: "B",
      kind: "model",
      providerId: "provider-b",
      modelId: "model-b",
      runtimeTarget: "web",
      isLocal: false,
      price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
      capabilities: ["text"],
      available: true,
      credentialReady: true,
    },
  ],
  decisionPolicy: {
    formal: true,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 10, confirmed: true },
  judgePolicy: {
    enabled: true,
    providerId: "judge-provider",
    modelId: "judge-model",
    price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
    secondJudgeProviderId: "second-judge-provider",
    secondJudgeModelId: "second-judge-model",
    secondJudgePrice: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
    calibrated: true,
    anchorCount: 30,
    kappa: 0.7,
    accuracy: 0.9,
  },
  privacyPolicy: { mediaClearance: "scanned", cloudPiiMode: "redact" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

describe("runProjectPreflight", () => {
  it("returns a compatible common case set when all gates pass", () => {
    const result = runProjectPreflight(project(), environment)
    expect(result.ok).toBe(true)
    expect(result.compatibleVariantIds).toEqual(["a", "b"])
    expect(result.effectiveCaseIds).toHaveLength(30)
  })

  it("blocks missing prices, judge independence, and insufficient holdout evidence", () => {
    const input = project()
    input.dataset.holdoutCaseIds = input.dataset.holdoutCaseIds.slice(0, 12)
    input.variants[0].price = undefined
    input.judgePolicy.providerId = "provider-b"
    input.judgePolicy.modelId = "model-b"
    input.judgePolicy.price = undefined
    input.judgePolicy.secondJudgeProviderId = undefined
    input.judgePolicy.secondJudgeModelId = undefined

    const result = runProjectPreflight(input, environment)
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "PRICE_REQUIRED",
        "JUDGE_PRICE_REQUIRED",
        "HOLDOUT_TOO_SMALL",
        "JUDGE_NOT_INDEPENDENT",
        "SECOND_JUDGE_REQUIRED",
      ])
    )
  })

  it("excludes capability-incompatible variants without changing the denominator", () => {
    const input = project()
    input.dataset.requiredModalities = ["image"]
    input.variants[0].capabilities = ["text", "image"]

    const result = runProjectPreflight(input, environment)
    expect(result.compatibleVariantIds).toEqual(["a"])
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "VARIANT_INCOMPATIBLE", variantId: "b" })
    )
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "TOO_FEW_VARIANTS" }))
  })

  it("uses all selected cases for an exploratory run without a holdout split", () => {
    const input = project()
    input.decisionPolicy.formal = false
    input.dataset.holdoutCaseIds = []
    input.judgePolicy.enabled = false

    const result = runProjectPreflight(input, environment)

    expect(result.ok).toBe(true)
    expect(result.effectiveCaseIds).toEqual(input.dataset.caseIds)
  })

  it("blocks malformed decision-policy numbers before execution", () => {
    const input = project()
    input.decisionPolicy.dimensions[0].weight = -1
    input.decisionPolicy.constraints = [{ metric: "quality", operator: "gte", value: NaN }]
    input.decisionPolicy.confidenceLevel = 1
    input.decisionPolicy.minimumEffectiveCases = 0
    input.retentionDays = 0

    expect(runProjectPreflight(input, environment).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DECISION_WEIGHT_INVALID" }),
        expect.objectContaining({ code: "DECISION_CONSTRAINT_INVALID" }),
        expect.objectContaining({ code: "CONFIDENCE_LEVEL_INVALID" }),
        expect.objectContaining({ code: "MINIMUM_CASES_INVALID" }),
        expect.objectContaining({ code: "RETENTION_INVALID" }),
      ])
    )
  })

  it("requires a concrete provider and model for an enabled formal judge", () => {
    const input = project()
    input.judgePolicy.providerId = undefined
    input.judgePolicy.modelId = undefined

    expect(runProjectPreflight(input, environment).issues).toContainEqual(
      expect.objectContaining({ code: "JUDGE_REQUIRED" })
    )
  })

  it("blocks empty datasets and unavailable runtimes before dispatch", () => {
    const input = project()
    input.decisionPolicy.formal = false
    input.judgePolicy.enabled = false
    input.dataset.caseIds = []
    input.variants[1].runtimeReady = false

    const result = runProjectPreflight(input, environment)

    expect(result.ok).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DATASET_EMPTY" }),
        expect.objectContaining({ code: "RUNTIME_UNAVAILABLE", variantId: "b" }),
      ])
    )
  })

  it("requires an environment check and blocks insufficient storage", () => {
    expect(runProjectPreflight(project()).issues).toContainEqual(
      expect.objectContaining({ code: "ENVIRONMENT_CHECK_REQUIRED" })
    )

    const insufficient: EvalEnvironmentCompatibility = {
      ...environment,
      storage: { status: "insufficient", requiredBytes: 200, availableBytes: 100 },
    }
    expect(runProjectPreflight(project(), insufficient).issues).toContainEqual(
      expect.objectContaining({ code: "DISK_QUOTA_INSUFFICIENT" })
    )
  })

  it("allows an unmeasurable quota with an explicit warning", () => {
    const unknown: EvalEnvironmentCompatibility = {
      ...environment,
      storage: { status: "unknown", requiredBytes: 200 },
    }
    const result = runProjectPreflight(project(), unknown)

    expect(result.ok).toBe(true)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "DISK_QUOTA_UNKNOWN", severity: "warning" })
    )
  })

  it("reports provider readiness and budget failures before reserving work", () => {
    const input = project()
    input.decisionPolicy.formal = false
    input.judgePolicy.enabled = false
    input.variants[0].available = false
    input.variants[1].credentialReady = false
    input.budget.confirmed = false
    input.budget.hardCap = 0

    const result = runProjectPreflight(input, environment)

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "VARIANT_UNAVAILABLE", variantId: "a" }),
        expect.objectContaining({ code: "CREDENTIAL_MISSING", variantId: "b" }),
        expect.objectContaining({ code: "TOO_FEW_VARIANTS" }),
        expect.objectContaining({ code: "BUDGET_CONFIRMATION_REQUIRED" }),
      ])
    )
  })

  it("requires independent calibrated second-judge evidence and cleared cloud media", () => {
    const input = project()
    input.dataset.requiredModalities = ["text", "image"]
    input.variants.forEach((variant) => variant.capabilities.push("image"))
    input.privacyPolicy.mediaClearance = "local-only"
    input.judgePolicy.secondJudgeProviderId = input.judgePolicy.providerId
    input.judgePolicy.secondJudgeModelId = input.judgePolicy.modelId
    input.judgePolicy.secondJudgePrice = undefined
    input.judgePolicy.calibrated = false
    input.judgePolicy.anchorCount = 12
    input.judgePolicy.kappa = 0.2
    input.judgePolicy.accuracy = 0.4

    const result = runProjectPreflight(input, environment)

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SECOND_JUDGE_PRICE_REQUIRED" }),
        expect.objectContaining({ code: "SECOND_JUDGE_NOT_INDEPENDENT" }),
        expect.objectContaining({ code: "JUDGE_CALIBRATION_FAILED" }),
        expect.objectContaining({ code: "MEDIA_CLEARANCE_REQUIRED" }),
      ])
    )
  })

  it("uses pinned dataset media clearance instead of a stale project-level claim", () => {
    const input = project()
    input.dataset.requiredModalities = ["text", "image"]
    input.variants.forEach((variant) => variant.capabilities.push("image"))
    input.privacyPolicy.mediaClearance = "scanned"
    input.dataset.mediaClearance = "local-only"

    expect(runProjectPreflight(input, environment).issues).toContainEqual(
      expect.objectContaining({ code: "MEDIA_CLEARANCE_REQUIRED" })
    )

    input.dataset.mediaClearance = "manual"
    expect(runProjectPreflight(input, environment).issues).not.toContainEqual(
      expect.objectContaining({ code: "MEDIA_CLEARANCE_REQUIRED" })
    )
  })

  it("does not require API prices for confirmed local targets and judges", () => {
    const input = project()
    input.variants.forEach((variant) => {
      variant.isLocal = true
      variant.price = undefined
    })
    input.judgePolicy.isLocal = true
    input.judgePolicy.price = undefined
    input.judgePolicy.secondJudgeIsLocal = true
    input.judgePolicy.secondJudgePrice = undefined

    const result = runProjectPreflight(input, environment)

    expect(result.ok).toBe(true)
    expect(result.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PRICE_REQUIRED" }),
        expect.objectContaining({ code: "JUDGE_PRICE_REQUIRED" }),
        expect.objectContaining({ code: "SECOND_JUDGE_PRICE_REQUIRED" }),
      ])
    )
  })
})
