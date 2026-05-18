import { OCR_PROVIDER_CAPABILITIES } from "./capabilities"
import {
  OCR_USE_CASES,
  RECOMMENDATION_MAP,
  validateRecommendationMap,
} from "./provider-recommendations"

describe("RECOMMENDATION_MAP", () => {
  it("covers all enumerated use-cases", () => {
    expect(OCR_USE_CASES).toEqual(
      expect.arrayContaining([
        "chineseReceipts",
        "handwriting",
        "formulas",
        "scannedContracts",
        "webScreenshots",
        "mixed",
      ])
    )
  })

  it("recommends only providers that have capability rows", () => {
    for (const preset of Object.values(RECOMMENDATION_MAP)) {
      expect(preset.providers.length).toBeGreaterThan(0)
      for (const providerId of preset.providers) {
        expect(OCR_PROVIDER_CAPABILITIES[providerId]).toBeDefined()
      }
    }
  })

  it("validateRecommendationMap throws when a recommended provider is missing", () => {
    expect(() => validateRecommendationMap()).not.toThrow()
  })

  it("matches each use-case to a strong provider", () => {
    // Math use-case must lead with a math-capable provider.
    const formulasDefault = RECOMMENDATION_MAP.formulas.providers[0]
    expect(OCR_PROVIDER_CAPABILITIES[formulasDefault].math).toBe("yes")

    // CJK / Chinese receipts must lead with a CJK-strong provider.
    const cjkDefault = RECOMMENDATION_MAP.chineseReceipts.providers[0]
    expect(OCR_PROVIDER_CAPABILITIES[cjkDefault].cjk).toBe("yes")

    // Scanned contracts must lead with a tables-strong provider.
    const contractsDefault = RECOMMENDATION_MAP.scannedContracts.providers[0]
    expect(OCR_PROVIDER_CAPABILITIES[contractsDefault].tables).toBe("yes")
  })
})
