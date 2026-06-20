// Re-export shim: canonical source moved to @cognia/provider-types (Stage 1).
//
// NOTE: this must use *explicit* named re-exports, not `export *`. The repo is
// CommonJS (no root `"type": "module"`), so under the CLI's tsx runtime a
// `export *`-only module is transpiled to a form `cjs-module-lexer` cannot see
// through — downstream named imports then link to `undefined` and the CLI fails
// to boot ("does not provide an export named ..."). Explicit re-exports are
// statically detectable, so they survive every runtime (Next, Jest, tsx).
export {
  BUILT_IN_PROVIDER_IDS,
  buildDefaultBuiltInProviderSettings,
  buildQuickAddProviderPresets,
  getBuiltInProviderAdapter,
  getBuiltInProviderCatalog,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderCodingPackage,
  getBuiltInProviderCodingPackageBundle,
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  getBuiltInProviderFamily,
  getBuiltInProviderPlaceholderApiKey,
  getBuiltInProviderProtocol,
  getBuiltInProviderSettingsBaseURL,
  getQuickAddProviderCatalogEntries,
  isBuiltInProviderId,
} from "@cognia/provider-types/built-in-provider-catalog"
export type {
  BuiltInProviderAdapterId,
  BuiltInProviderCatalogEntry,
  BuiltInProviderCategory,
  BuiltInProviderCodingPackage,
  BuiltInProviderCodingPackageMcpBundle,
  BuiltInProviderCodingPackageMcpCredentialBinding,
  BuiltInProviderCodingPackageMcpTransport,
  BuiltInProviderCompatibilityRule,
  BuiltInProviderFamily,
  BuiltInProviderId,
  BuiltInProviderModelEntry,
  BuiltInProviderModelPricing,
  BuiltInProviderOAuthConfig,
  BuiltInProviderProtocol,
  BuiltInProviderQuickAddCategory,
  BuiltInProviderQuickAddMetadata,
  BuiltInProviderQuickAddMode,
  BuiltInProviderQuickAddPreset,
  BuiltInProviderType,
  ProviderUseCase,
} from "@cognia/provider-types/built-in-provider-catalog"
