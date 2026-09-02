/**
 * Public face of the provider operation plane (ADR-0163).
 *
 * `getProviderOperationExecutor()` is the process-wide executor wired to the
 * live settings store and this host's surfaces, with every built-in handler
 * registered. Callers that need isolation (tests, plugins) build their own
 * with `createProviderOperationExecutor`.
 */

import { createProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"

import { createProviderOperationExecutor, type ProviderOperationExecutor } from "./executor"
import { registerBuiltInProviderOperationHandlers } from "./handlers"
import { detectHostSurfaces } from "./host-surfaces"
import { providerOperationHandlerRegistry } from "./registry"

export { createProviderOperationExecutor, routeProfileForGroup } from "./executor"
export type {
  ProviderOperationExecutor,
  ProviderOperationExecutorDeps,
  ProviderOperationExecuteOptions,
} from "./executor"
export {
  getProviderOperationDescriptor,
  listProviderOperationDescriptors,
  listProviderOperationDescriptorsByGroup,
  PROVIDER_OPERATION_MANIFEST,
} from "./manifest"
export {
  ProviderOperationHandlerRegistry,
  providerOperationHandlerRegistry,
  registerProviderOperationHandler,
} from "./registry"
export type {
  ProviderOperationHandler,
  ProviderOperationHandlerContext,
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "./registry"
export { registerBuiltInProviderOperationHandlers } from "./handlers"
export { detectHostSurfaces } from "./host-surfaces"
export { credentialAffinityOf } from "./credential-affinity"
export {
  ProviderOperationFailureError,
  ProviderOperationPiiGateError,
  toProviderDiagnosticFailure,
} from "./failure"

let shared: ProviderOperationExecutor | undefined

/**
 * Reads the settings store lazily on every execution, so a provider edited
 * in Settings is picked up by the next call without a rebuild.
 */
export function getProviderOperationExecutor(): ProviderOperationExecutor {
  if (shared) return shared
  registerBuiltInProviderOperationHandlers(providerOperationHandlerRegistry)
  shared = createProviderOperationExecutor({
    registry: providerOperationHandlerRegistry,
    hostSurfaces: detectHostSurfaces(),
    getSettingsSnapshot: () => {
      // Dynamic require keeps the store (and its Dexie graph) out of the
      // module graph of callers that only need the types or the registry.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useSettingsStore } =
        require("@/stores/settings") as typeof import("@/stores/settings")
      const live = useSettingsStore.getState().settings
      return createProviderSettingsSnapshot({
        defaultProvider: live?.defaultProvider,
        providerSettings: live?.providerSettings,
        customProviders: live?.customProviders,
      })
    },
  })
  return shared
}

/** Test seam: drop the shared executor so the next call rebuilds it. */
export function __resetProviderOperationExecutorForTests(): void {
  shared = undefined
}
