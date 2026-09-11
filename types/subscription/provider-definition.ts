import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"

/** Optional fields retain "unknown" until the provider supplies real metadata. */
export type SubscriptionModelDefinition = Omit<
  ProviderModelDiscoveryEntry,
  "provider" | "knownFields"
>

/** Standard endpoints, relative to the provider's protocol base. No arbitrary fetch callbacks. */
export interface SubscriptionModelApi {
  list: boolean
  retrieve?: boolean
}

/** Host-owned account setup metadata. It never contains credentials or executable callbacks. */
export interface SubscriptionProviderDefinition {
  id: string
  name: string
  authMode: "anthropic-oauth" | "codex-oauth" | "api-key"
  baseUrl?: string
  protocol?: "openai" | "anthropic"
  apiFlavor?: "chat" | "responses"
  models?: string[]
  modelMetadata?: SubscriptionModelDefinition[]
  modelApi?: SubscriptionModelApi
  apiKeyUrl?: string
  usageUrl?: string
  docsUrl?: string
  description?: string
  source: "builtin" | "custom" | "plugin" | "unavailable"
  pluginId?: string
  available?: boolean
  legacyCredentialKind?: "opencode" | "commandcode"
  plans?: Array<{ id: string; name: string; baseUrl: string; chatProviderId: string }>
}

/** JSON manifest contribution; ids are namespaced by the host on plugin activation. */
export interface PluginSubscriptionProviderDefinition {
  id: string
  name: string
  baseUrl: string
  protocol: "openai" | "anthropic"
  apiFlavor?: "chat" | "responses"
  models: Array<string | SubscriptionModelDefinition>
  modelApi?: SubscriptionModelApi
  apiKeyUrl?: string
  usageUrl?: string
  docsUrl?: string
  description?: string
}
