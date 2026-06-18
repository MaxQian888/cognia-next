// resolveProviderAdapter's models.dev-derived fallback is defensive: every
// current built-in provider has a static adapter, so the branch only fires for
// future models.dev-only providers. We exercise it here by forcing the static
// adapter lookup to miss.

jest.mock("@/types/provider/built-in-provider-catalog", () => {
  const actual = jest.requireActual("@/types/provider/built-in-provider-catalog")
  return { ...actual, getBuiltInProviderAdapter: jest.fn(() => undefined) }
})

import { getBuiltInProviderAdapter } from "@/types/provider/built-in-provider-catalog"
import {
  resolveProviderAdapter,
  primeModelsDevCatalogCache,
  getCachedModelsDevCatalog,
  __resetModelsDevCatalogCacheForTesting,
} from "./models-dev-sync"
import type { ModelsDevCatalogRow } from "@/lib/db/schema"

const mockGetAdapter = getBuiltInProviderAdapter as jest.MockedFunction<
  typeof getBuiltInProviderAdapter
>

function prime(providers: ModelsDevCatalogRow["providers"]) {
  primeModelsDevCatalogCache({ id: "singleton", fetchedAt: 1, source: "remote", providers })
}

beforeEach(() => {
  __resetModelsDevCatalogCacheForTesting()
  mockGetAdapter.mockReturnValue(undefined)
})

describe("resolveProviderAdapter — models.dev-derived fallback", () => {
  it("derives from the provider npm when static adapter is absent", () => {
    prime({
      anthropic: {
        modelsDevId: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        models: [],
      },
    })
    expect(resolveProviderAdapter("anthropic")).toBe("anthropic")
  })

  it("falls back to a cached model-level adapter hint", () => {
    prime({
      anthropic: {
        modelsDevId: "anthropic",
        name: "Anthropic",
        models: [{ id: "m1", adapter: "openrouter" }],
      },
    })
    expect(resolveProviderAdapter("anthropic")).toBe("openrouter")
  })

  it("returns openai-compatible when nothing else resolves", () => {
    expect(resolveProviderAdapter("anthropic")).toBe("openai-compatible")
  })
})

describe("getCachedModelsDevCatalog", () => {
  it("reflects the primed cache and reset", () => {
    expect(getCachedModelsDevCatalog()).toBeNull()
    prime({})
    expect(getCachedModelsDevCatalog()?.id).toBe("singleton")
    __resetModelsDevCatalogCacheForTesting()
    expect(getCachedModelsDevCatalog()).toBeNull()
  })
})
