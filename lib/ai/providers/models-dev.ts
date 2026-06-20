// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  MODELS_DEV_API_URL,
  REASONING_VARIANT_TIERS,
  computeModelVariants,
  deriveAdapterFromNpm,
  expandModelModes,
  fetchModelsDevApi,
  mapModelsDevModel,
  normalizeModelsDevApi,
} from "@cognia/provider-core/providers/models-dev"
export type {
  ModelsDevApi,
  ModelsDevCatalogModel,
  ModelsDevCost,
  ModelsDevExperimentalMode,
  ModelsDevLimit,
  ModelsDevModalities,
  ModelsDevMode,
  ModelsDevModel,
  ModelsDevProvider,
  ModelsDevProviderOverride,
  NormalizedModelsDevCatalog,
  NormalizedModelsDevProvider,
} from "@cognia/provider-core/providers/models-dev"
