// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  LocalProviderService,
  checkAllProvidersInstallation,
  checkProviderInstallation,
  createLocalProviderService,
  getInstallInstructions,
  getProviderCapabilities,
} from "@cognia/provider-core/providers/local-provider-service"
export type {
  InstallCheckResult,
  LocalProviderCapabilities,
  LocalProviderInstallInfo,
  ModelPullOptions,
} from "@cognia/provider-core/providers/local-provider-service"
export { default } from "@cognia/provider-core/providers/local-provider-service"
