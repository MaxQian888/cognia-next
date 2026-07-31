jest.mock("@cognia/provider-core/providers/models-dev-catalog-db", () => ({
  setModelsDevCatalogDb: jest.fn(),
  setModelsDevSnapshotLoader: jest.fn(),
}))
jest.mock("@cognia/provider-core/providers/models-dev-sync", () => ({
  setProviderCatalogRepository: jest.fn(),
  setProviderCatalogRollout: jest.fn(),
  ensureUnifiedProviderCatalog: jest.fn(),
  refreshModelsDevCatalogIfStale: jest.fn(),
}))
jest.mock("@/lib/db/models-dev-catalog", () => ({
  getModelsDevCatalog: jest.fn(),
  saveModelsDevCatalog: jest.fn(),
  isModelsDevCatalogStale: jest.fn(),
}))
jest.mock("@/lib/db/provider-catalog", () => ({
  providerCatalogRepository: { hydrate: jest.fn() },
}))
jest.mock("./provider-catalog-feature-flags", () => ({
  getProviderCatalogFeatureFlags: jest.fn(),
}))
jest.mock("@cognia/provider-core/providers/built-in-presets", () => ({
  setPresetCatalogRepository: jest.fn(),
}))
jest.mock("@cognia/provider-routing/default-mappings", () => ({
  setDefaultMappingCatalogRepository: jest.fn(),
}))
jest.mock("./models-dev-shard-loader", () => ({
  loadBundledModelsDevShards: jest.fn(),
}))

import {
  ensureUnifiedProviderCatalog,
  refreshModelsDevCatalogIfStale,
  setProviderCatalogRepository,
  setProviderCatalogRollout,
} from "@cognia/provider-core/providers/models-dev-sync"
import { providerCatalogRepository } from "@/lib/db/provider-catalog"
import { getProviderCatalogFeatureFlags } from "./provider-catalog-feature-flags"
import { setPresetCatalogRepository } from "@cognia/provider-core/providers/built-in-presets"
import { setDefaultMappingCatalogRepository } from "@cognia/provider-routing/default-mappings"
import { initializeProviderCatalog } from "./models-dev-sync"

const mockSetProviderCatalogRepository = jest.mocked(setProviderCatalogRepository)
const mockSetProviderCatalogRollout = jest.mocked(setProviderCatalogRollout)
const mockEnsureUnifiedProviderCatalog = jest.mocked(ensureUnifiedProviderCatalog)
const mockRefreshModelsDevCatalogIfStale = jest.mocked(refreshModelsDevCatalogIfStale)
const mockHydrate = jest.mocked(providerCatalogRepository.hydrate)
const mockSetPresetCatalogRepository = jest.mocked(setPresetCatalogRepository)
const mockSetDefaultMappingCatalogRepository = jest.mocked(setDefaultMappingCatalogRepository)
const mockGetProviderCatalogFeatureFlags = jest.mocked(getProviderCatalogFeatureFlags)

beforeEach(() => {
  for (const mock of [
    mockSetProviderCatalogRepository,
    mockSetProviderCatalogRollout,
    mockEnsureUnifiedProviderCatalog,
    mockRefreshModelsDevCatalogIfStale,
    mockHydrate,
    mockSetPresetCatalogRepository,
    mockSetDefaultMappingCatalogRepository,
    mockGetProviderCatalogFeatureFlags,
  ]) {
    mock.mockClear()
  }
  mockGetProviderCatalogFeatureFlags.mockReturnValue({
    providerCatalogV2: true,
    dynamicLongTail: true,
    multimodalConsumption: false,
  })
})

it("hydrates and publishes Catalog v2 before the stale refresh", async () => {
  await initializeProviderCatalog()

  expect(mockSetProviderCatalogRepository).toHaveBeenCalledWith(providerCatalogRepository)
  expect(mockSetProviderCatalogRollout).toHaveBeenCalledWith({
    includeExperimentalProviders: true,
  })
  expect(mockHydrate).toHaveBeenCalledTimes(1)
  expect(mockEnsureUnifiedProviderCatalog).toHaveBeenCalledTimes(1)
  expect(mockSetPresetCatalogRepository).toHaveBeenCalledWith(providerCatalogRepository)
  expect(mockSetDefaultMappingCatalogRepository).toHaveBeenCalledWith(providerCatalogRepository)
  expect(mockRefreshModelsDevCatalogIfStale).toHaveBeenCalledTimes(1)
  expect(mockHydrate.mock.invocationCallOrder[0]).toBeLessThan(
    mockRefreshModelsDevCatalogIfStale.mock.invocationCallOrder[0]
  )
})

it("keeps the legacy read path when Catalog v2 is disabled", async () => {
  mockGetProviderCatalogFeatureFlags.mockReturnValue({
    providerCatalogV2: false,
    dynamicLongTail: false,
    multimodalConsumption: false,
  })

  await initializeProviderCatalog()

  expect(mockSetProviderCatalogRepository).toHaveBeenCalledWith(null)
  expect(mockSetProviderCatalogRollout).toHaveBeenCalledWith({
    includeExperimentalProviders: false,
  })
  expect(mockHydrate).not.toHaveBeenCalled()
  expect(mockEnsureUnifiedProviderCatalog).not.toHaveBeenCalled()
  expect(mockRefreshModelsDevCatalogIfStale).toHaveBeenCalledTimes(1)
})
