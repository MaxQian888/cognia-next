/** @jest-environment jsdom */

import {
  getProviderCatalogFeatureFlags,
  PROVIDER_CATALOG_FLAGS_STORAGE_KEY,
} from "./provider-catalog-feature-flags"

beforeEach(() => {
  window.localStorage.clear()
})

describe("provider catalog rollout flags", () => {
  it("enables the catalog and dynamic directory while gating multimodal runtime consumption", () => {
    expect(getProviderCatalogFeatureFlags()).toEqual({
      providerCatalogV2: true,
      dynamicLongTail: true,
      multimodalConsumption: false,
    })
  })

  it("accepts boolean local rollout overrides and ignores malformed values", () => {
    window.localStorage.setItem(
      PROVIDER_CATALOG_FLAGS_STORAGE_KEY,
      JSON.stringify({
        providerCatalogV2: false,
        dynamicLongTail: false,
        multimodalConsumption: true,
        unknown: true,
      })
    )
    expect(getProviderCatalogFeatureFlags()).toEqual({
      providerCatalogV2: false,
      dynamicLongTail: false,
      multimodalConsumption: true,
    })

    window.localStorage.setItem(PROVIDER_CATALOG_FLAGS_STORAGE_KEY, "{broken")
    expect(getProviderCatalogFeatureFlags().providerCatalogV2).toBe(true)
  })
})
