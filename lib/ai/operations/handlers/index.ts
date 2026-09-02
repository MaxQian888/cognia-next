/**
 * Registration of every built-in provider operation handler. Importing this
 * module is the wiring step: the executor's default registry is empty until
 * something calls `registerBuiltInProviderOperationHandlers`. Idempotent per
 * registry.
 */

import {
  providerOperationHandlerRegistry,
  type ProviderOperationHandlerRegistration,
  type ProviderOperationHandlerRegistry,
} from "../registry"
import { capabilitiesReadHandler } from "./capabilities"

/** Every built-in handler, in registration order. Extended batch by batch. */
export const BUILT_IN_PROVIDER_OPERATION_HANDLERS: readonly ProviderOperationHandlerRegistration[] =
  [capabilitiesReadHandler as ProviderOperationHandlerRegistration]

const registered = new WeakSet<ProviderOperationHandlerRegistry>()

export function registerBuiltInProviderOperationHandlers(
  registry: ProviderOperationHandlerRegistry = providerOperationHandlerRegistry
): void {
  if (registered.has(registry)) return
  registered.add(registry)
  for (const handler of BUILT_IN_PROVIDER_OPERATION_HANDLERS) registry.register(handler)
}
