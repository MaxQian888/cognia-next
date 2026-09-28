import { isValidSubscriptionProviderId } from "./credential"
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

export function validateSubscriptionProvider(
  definition: PluginSubscriptionProviderDefinition
): void {
  const fields = new Set([
    "id",
    "name",
    "baseUrl",
    "protocol",
    "apiFlavor",
    "models",
    "modelApi",
    "apiKeyUrl",
    "usageUrl",
    "docsUrl",
    "description",
  ])
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    Object.keys(definition).some((key) => !fields.has(key))
  )
    throw new Error("Subscription provider must contain only declarative setup fields")
  if (typeof definition.id !== "string" || !isValidSubscriptionProviderId(definition.id))
    throw new Error("Invalid subscription provider id")
  if (
    typeof definition.name !== "string" ||
    !definition.name.trim() ||
    definition.name.length > 120
  )
    throw new Error("Invalid subscription provider name")
  if (!["openai", "anthropic"].includes(definition.protocol))
    throw new Error("Unsupported subscription protocol")
  if (
    definition.apiFlavor !== undefined &&
    (definition.protocol !== "openai" || !["chat", "responses"].includes(definition.apiFlavor))
  )
    throw new Error("API flavor is supported only for OpenAI Chat or Responses")
  if (definition.modelApi !== undefined) {
    const api = definition.modelApi
    if (
      !api ||
      typeof api !== "object" ||
      Array.isArray(api) ||
      Object.keys(api).some((field) => !["list", "retrieve"].includes(field)) ||
      typeof api.list !== "boolean" ||
      (api.retrieve !== undefined && typeof api.retrieve !== "boolean")
    ) {
      throw new Error("Invalid subscription model API declaration")
    }
  }
  if (typeof definition.baseUrl !== "string" || !definition.baseUrl)
    throw new Error("Subscription endpoint is required")
  for (const [field, value] of Object.entries({
    baseUrl: definition.baseUrl,
    apiKeyUrl: definition.apiKeyUrl,
    usageUrl: definition.usageUrl,
    docsUrl: definition.docsUrl,
  })) {
    if (value === undefined) continue
    if (typeof value !== "string") throw new Error("Invalid subscription endpoint")
    const url = new URL(value)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (field === "baseUrl" && (url.hash || url.search))
    )
      throw new Error("Invalid subscription endpoint")
  }
  if (
    definition.description !== undefined &&
    (typeof definition.description !== "string" || definition.description.length > 2000)
  )
    throw new Error("Invalid subscription description")
  if (
    !Array.isArray(definition.models) ||
    definition.models.length === 0 ||
    definition.models.length > 500
  )
    throw new Error("At least one valid model is required")
  const ids = new Set<string>()
  for (const model of definition.models) {
    const entry = typeof model === "string" ? { id: model } : model
    validateModelDefinition(entry)
    if (ids.has(entry.id)) throw new Error("Duplicate subscription model id")
    ids.add(entry.id)
  }
}

const MODEL_BOOLEAN_FIELDS = [
  "supportsTools",
  "supportsVision",
  "supportsAudio",
  "supportsVideo",
  "supportsStreaming",
  "supportsReasoning",
  "supportsImageGeneration",
  "supportsEmbedding",
  "supportsStructuredOutput",
] as const

function validateModelDefinition(model: SubscriptionModelDefinition): void {
  const fields = new Set([
    "id",
    "name",
    "contextLength",
    "maxOutputTokens",
    "maxInputTokens",
    "pricing",
    ...MODEL_BOOLEAN_FIELDS,
  ])
  if (
    !model ||
    typeof model !== "object" ||
    Array.isArray(model) ||
    Object.keys(model).some((field) => !fields.has(field)) ||
    typeof model.id !== "string" ||
    !model.id.trim() ||
    model.id !== model.id.trim() ||
    model.id.length > 256 ||
    /[\r\n\u0000]/.test(model.id)
  )
    throw new Error("Invalid subscription model")
  if (
    model.name !== undefined &&
    (typeof model.name !== "string" || !model.name.trim() || model.name.length > 256)
  )
    throw new Error("Invalid subscription model name")
  for (const field of ["contextLength", "maxInputTokens", "maxOutputTokens"] as const) {
    if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field]! <= 0))
      throw new Error("Model token limits must be positive integers")
  }
  for (const field of MODEL_BOOLEAN_FIELDS) {
    if (model[field] !== undefined && typeof model[field] !== "boolean")
      throw new Error("Invalid model capability")
  }
  if (model.pricing !== undefined) {
    const pricingFields = new Set([
      "promptPer1M",
      "completionPer1M",
      "cachedInputPer1M",
      "cacheCreationPer1M",
      "batchInputPer1M",
      "batchOutputPer1M",
      "audioInputPer1M",
      "audioOutputPer1M",
      "perPageUsd",
      "perCharUsd",
      "perContainerHourUsd",
      "freeContainerHoursPerMonth",
      "perRequestUsd",
      "currency",
    ])
    if (!model.pricing || typeof model.pricing !== "object" || Array.isArray(model.pricing))
      throw new Error("Invalid model pricing")
    for (const [key, value] of Object.entries(model.pricing)) {
      if (!pricingFields.has(key)) throw new Error("Invalid model pricing field")
      if (key === "currency") {
        if (value !== "USD" && value !== "CNY") throw new Error("Invalid pricing currency")
      } else if (key === "perRequestUsd") {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.values(value).some(
            (cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0
          )
        )
          throw new Error("Invalid request pricing")
      } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new Error("Invalid model price")
    }
  }
}
