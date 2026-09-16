/**
 * Semantic interceptors (ADR-0189) — host entry point.
 *
 * Import the dispatch functions from here rather than reaching into the
 * submodules, so call sites depend on the contract and not on the layout.
 */

export * from "./types"
export {
  CANONICAL_INTERCEPTOR_POINTS,
  getInterceptorPoint,
  isInterceptorPoint,
  isInterceptorPointLive,
  listInterceptorPoints,
  requireInterceptorPoint,
  type CanonicalInterceptorPoint,
} from "./points"
export { resolveInterceptorOrder, type InterceptorOrderResult } from "./order"
export {
  getInterceptor,
  hasInterceptors,
  listInterceptorPointsInUse,
  listInterceptorsForPoint,
  registerInterceptor,
  resolveInterceptorChain,
  subscribeInterceptorDiagnostics,
  unregisterInterceptor,
  unregisterInterceptorGeneration,
  unregisterInterceptorsForPlugin,
  unregisterInterceptorsForPluginSource,
  __resetInterceptorRegistryForTesting,
} from "./registry"
export {
  dispatchAround,
  dispatchGuard,
  dispatchObserve,
  dispatchTransform,
  requireGuardPass,
  InterceptorInvariantError,
  InterceptorShortCircuitError,
  __resetInterceptorDispatchForTesting,
  type InterceptorDispatchContext,
  type InterceptorFailure,
  type InterceptorOutcomeSink,
  type InterceptorRunReport,
  type OperationCompletedPayload,
  type InterceptorSkip,
  type TransformDispatchOptions,
} from "./dispatch"
export {
  registerDeclaredInterceptors,
  splitActivationContributions,
  type ActivationContributions,
  type ContributionOutcome,
  type ContributionRejection,
} from "./contributions"
export {
  createInterceptorRegistration,
  interceptorFromChatMiddleware,
  interceptorsFromLegacyHooks,
  legacyHookPointId,
  NORMALIZED_LEGACY_HOOKS,
  type ChatMiddlewareLike,
  type CreateInterceptorRegistrationInput,
  type NormalizedLegacyHook,
  type ToolResultProjectValue,
} from "./normalize"
export {
  resolveInterceptorIdentity,
  setInterceptorIdentityResolver,
  __resetInterceptorIdentityForTesting,
  type InterceptorIdentity,
  type InterceptorIdentityResolver,
} from "./identity"
export { resolveInterceptorTrustTier, trustTierForSource } from "./trust"
