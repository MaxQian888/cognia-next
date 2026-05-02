/**
 * Plugin Package - Package management exports
 */

export { buildExtensionCatalogEntry } from "./catalog-entry"

export {
  PluginMarketplace,
  LocalPluginSource,
  getPluginMarketplace,
  resetPluginMarketplace,
  usePluginMarketplace,
  type PluginRegistryEntry,
  type PluginSearchOptions,
  type PluginSearchResult,
  type PluginVersionInfo,
  type PluginDependency,
  type DependencyResolutionResult,
  type InstallationProgress,
  type MarketplaceConfig,
} from "./marketplace"

export {
  DependencyResolver,
  getDependencyResolver,
  resetDependencyResolver,
  parseVersion,
  compareVersions,
  parseConstraint,
  satisfiesConstraint,
  type Dependency,
  type ResolvedDependency,
  type DependencyNode,
  type ResolutionResult,
  type DependencyConflict,
} from "./dependency-resolver"

export {
  ConflictDetector,
  getConflictDetector,
  resetConflictDetector,
  type PluginConflict,
  type ConflictType,
  type ConflictSeverity,
  type ConflictDetectionResult,
  type ConflictResolution,
} from "./conflict-detector"
