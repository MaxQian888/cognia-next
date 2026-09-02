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
import { BATCHES_HANDLERS } from "./batches"
import { capabilitiesReadHandler } from "./capabilities"
import { DISCOVERY_HANDLERS } from "./discovery"
import { FILES_HANDLERS } from "./files"
import { FINE_TUNING_HANDLERS } from "./fine-tuning"
import { HEALTH_HANDLERS } from "./health"
import { IMAGE_EDIT_HANDLERS } from "./image-edit"
import { LANGUAGE_HANDLERS } from "./language"
import { MEDIA_HANDLERS } from "./media"
import { MODERATION_HANDLERS } from "./moderation"
import { REALTIME_HANDLERS } from "./realtime"
import { RETRIEVAL_HANDLERS } from "./retrieval"
import { TOKENS_HANDLERS } from "./tokens"
import { TRANSLATION_HANDLERS } from "./translation"
import { VECTOR_STORES_HANDLERS } from "./vector-stores"
import { VIDEO_JOBS_HANDLERS } from "./video-jobs"

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
    ...FILES_HANDLERS,
    ...VECTOR_STORES_HANDLERS,
    ...BATCHES_HANDLERS,
    ...FINE_TUNING_HANDLERS,
    ...VIDEO_JOBS_HANDLERS,
    ...IMAGE_EDIT_HANDLERS,
    ...TRANSLATION_HANDLERS,
    ...REALTIME_HANDLERS,
  ] as ProviderOperationHandlerRegistration[]

const registered = new WeakSet<ProviderOperationHandlerRegistry>()

export function registerBuiltInProviderOperationHandlers(
  registry: ProviderOperationHandlerRegistry = providerOperationHandlerRegistry
): void {
  if (registered.has(registry)) return
  registered.add(registry)
  for (const handler of BUILT_IN_PROVIDER_OPERATION_HANDLERS) registry.register(handler)
}
