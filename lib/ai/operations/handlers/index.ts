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
import { ACCOUNT_HANDLERS } from "./account"
import { capabilitiesReadHandler } from "./capabilities"
import { DISCOVERY_HANDLERS } from "./discovery"
import { HEALTH_HANDLERS } from "./health"
import { LANGUAGE_HANDLERS } from "./language"
import { MEDIA_HANDLERS } from "./media"
import { MODERATION_HANDLERS } from "./moderation"
import { RETRIEVAL_HANDLERS } from "./retrieval"
import { TOKENS_HANDLERS } from "./tokens"

/** Every built-in handler, in registration order. Extended batch by batch. */
export const BUILT_IN_PROVIDER_OPERATION_HANDLERS: readonly ProviderOperationHandlerRegistration[] =
  [
    capabilitiesReadHandler,
    ...DISCOVERY_HANDLERS,
    ...HEALTH_HANDLERS,
    ...LANGUAGE_HANDLERS,
    ...TOKENS_HANDLERS,
    ...MODERATION_HANDLERS,
    ...RETRIEVAL_HANDLERS,
    ...MEDIA_HANDLERS,
    ...ACCOUNT_HANDLERS,
  ] as ProviderOperationHandlerRegistration[]

const registered = new WeakSet<ProviderOperationHandlerRegistry>()

export function registerBuiltInProviderOperationHandlers(
  registry: ProviderOperationHandlerRegistry = providerOperationHandlerRegistry
): void {
  if (registered.has(registry)) return
  registered.add(registry)
  for (const handler of BUILT_IN_PROVIDER_OPERATION_HANDLERS) registry.register(handler)
}
