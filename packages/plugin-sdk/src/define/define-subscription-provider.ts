import type { PluginSubscriptionProviderDefinition } from "@cognia/plugin-contract/types/subscription/provider-definition"

/** Declare API-key setup metadata. Cognia owns credential entry, storage, and requests. */
export function defineSubscriptionProvider(
  definition: PluginSubscriptionProviderDefinition
): PluginSubscriptionProviderDefinition {
  return definition
}
