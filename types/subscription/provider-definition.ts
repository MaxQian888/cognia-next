import { isValidSubscriptionProviderId } from "./credential"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import type { SourceDescriptor } from "./descriptor"

export type SubscriptionBillingMode = "subscription" | "pay-as-you-go"

/** Host-executed usage request. Credentials may appear only in request headers. */
export interface SubscriptionUsageDefinition {
  baseUrl?: string
  request: SourceDescriptor["request"]
  extract: SourceDescriptor["extract"]
}

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
  billingMode?: SubscriptionBillingMode
  brandId?: string
  /** Separate pay-as-you-go provider identities offered alongside this subscription. */
  relatedProviderIds?: string[]
  usage?: SubscriptionUsageDefinition
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
  billingMode?: SubscriptionBillingMode
  brandId?: string
  /** Separate pay-as-you-go provider identities; never subscription relay aliases. */
  relatedProviderIds?: string[]
  usage?: SubscriptionUsageDefinition
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
    "billingMode",
    "brandId",
    "relatedProviderIds",
    "usage",
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
    definition.billingMode !== undefined &&
    !["subscription", "pay-as-you-go"].includes(definition.billingMode)
  )
    throw new Error("Invalid subscription billing mode")
  if (
    definition.brandId !== undefined &&
    (typeof definition.brandId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(definition.brandId))
  )
    throw new Error("Invalid subscription brand id")
  if (
    definition.relatedProviderIds !== undefined &&
    (!Array.isArray(definition.relatedProviderIds) ||
      definition.relatedProviderIds.length > 32 ||
      definition.relatedProviderIds.some(
        (id) => typeof id !== "string" || !isValidSubscriptionProviderId(id)
      ) ||
      new Set(definition.relatedProviderIds).size !== definition.relatedProviderIds.length)
  )
    throw new Error("Invalid related provider ids")
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
      (field === "baseUrl" &&
        definition.billingMode === "subscription" &&
        url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (field === "baseUrl" && (url.hash || url.search))
    )
      throw new Error("Invalid subscription endpoint")
  }
  if (definition.usage !== undefined)
    validateUsageDefinition(definition.usage, definition.billingMode)
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

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"])

function declarativeRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key) || UNSAFE_KEYS.has(key))
  )
    throw new Error("Invalid subscription usage declaration")
  return value as Record<string, unknown>
}

/** Reject callbacks, custom prototypes, accessors, cycles, and oversized manifest payloads. */
function validateUsageJson(value: unknown, depth = 0, budget = { remaining: 2048 }): void {
  if (depth > 12 || --budget.remaining < 0)
    throw new Error("Subscription usage declaration is too large")
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string" && value.length <= 4096) return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (!value || typeof value !== "object")
    throw new Error("Subscription usage must contain only JSON data")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null) {
    // structuredClone and plugin isolation may supply plain objects from another realm.
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    const expectedConstructor = Array.isArray(value) ? Array : Object
    if (
      typeof constructor !== "function" ||
      Function.prototype.toString.call(constructor) !==
        Function.prototype.toString.call(expectedConstructor)
    )
      throw new Error("Invalid subscription usage object")
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue
    if (typeof key !== "string" || UNSAFE_KEYS.has(key))
      throw new Error("Invalid subscription usage property")
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (!property.enumerable || !("value" in property))
      throw new Error("Subscription usage must contain only JSON data")
    validateUsageJson(property.value, depth + 1, budget)
  }
}

function validateUsagePath(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value) ||
    value.split(".").some((key) => UNSAFE_KEYS.has(key))
  )
    throw new Error("Invalid subscription usage extraction path")
}

function validatePositiveScale(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e12)
    throw new Error("Invalid subscription usage scale")
}

function validateUsageDefinition(
  definition: SubscriptionUsageDefinition,
  billingMode: SubscriptionBillingMode | undefined
): void {
  validateUsageJson(definition)
  const usage = declarativeRecord(definition, ["baseUrl", "request", "extract"])
  if (usage.baseUrl !== undefined) {
    if (typeof usage.baseUrl !== "string") throw new Error("Invalid subscription usage endpoint")
    const url = new URL(usage.baseUrl)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (billingMode === "subscription" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[{}\u0000-\u0020\u007f]/.test(usage.baseUrl)
    )
      throw new Error("Invalid subscription usage endpoint")
  }
  const request = declarativeRecord(usage.request, [
    "path",
    "method",
    "useBaseUrlOrigin",
    "headers",
  ])
  if (
    typeof request.path !== "string" ||
    request.path.length > 1024 ||
    !/^\/(?!\/)[A-Za-z0-9_./~-]*$/.test(request.path) ||
    request.path.split("/").some((part) => part === "." || part === "..") ||
    (request.method !== undefined && request.method !== "GET") ||
    (request.useBaseUrlOrigin !== undefined && typeof request.useBaseUrlOrigin !== "boolean")
  )
    throw new Error("Invalid subscription usage request")
  if (request.headers !== undefined) {
    const headers = declarativeRecord(request.headers, Object.keys(request.headers as object))
    if (Object.keys(headers).length > 24) throw new Error("Too many subscription usage headers")
    const seen = new Set<string>()
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (
        name.length > 128 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        [
          "host",
          "cookie",
          "set-cookie",
          "proxy-authorization",
          "connection",
          "content-length",
          "transfer-encoding",
        ].includes(lower) ||
        lower.startsWith("x-cognia-") ||
        seen.has(lower) ||
        typeof value !== "string" ||
        value.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        /[{}]/.test(value.replaceAll("{{token}}", ""))
      )
        throw new Error("Invalid subscription usage header")
      seen.add(lower)
    }
  }
  const extract = declarativeRecord(usage.extract, [
    "kind",
    "windows",
    "totalPath",
    "usedPath",
    "remainingPath",
    "unit",
    "currency",
    "scale",
  ])
  if (extract.kind === "window") {
    if (Object.keys(extract).some((key) => !["kind", "windows"].includes(key)))
      throw new Error("Invalid subscription usage window extraction")
    if (!Array.isArray(extract.windows) || !extract.windows.length || extract.windows.length > 16)
      throw new Error("Invalid subscription usage windows")
    const ids = new Set<string>()
    for (const raw of extract.windows) {
      const window = declarativeRecord(raw, [
        "id",
        "labelKey",
        "usedPctPath",
        "usedPctScale",
        "invert",
        "usedPath",
        "totalPath",
        "remainingPath",
        "select",
        "resetAtPath",
        "resetUnit",
        "windowSecondsPath",
      ])
      if (
        typeof window.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(window.id) ||
        ids.has(window.id)
      )
        throw new Error("Invalid subscription usage window id")
      ids.add(window.id)
      validateUsagePath(window.labelKey)
      for (const field of [
        "usedPctPath",
        "usedPath",
        "totalPath",
        "remainingPath",
        "resetAtPath",
        "windowSecondsPath",
      ]) {
        if (window[field] !== undefined) validateUsagePath(window[field])
      }
      if (!window.usedPctPath && !(window.totalPath && (window.usedPath || window.remainingPath)))
        throw new Error("Subscription usage window requires a utilization expression")
      if (window.usedPctScale !== undefined) {
        validatePositiveScale(window.usedPctScale)
        if (!window.usedPctPath) throw new Error("Usage scale requires a percentage path")
      }
      if (
        window.invert !== undefined &&
        (typeof window.invert !== "boolean" || !window.usedPctPath)
      )
        throw new Error("Invalid subscription usage inversion")
      if (
        window.resetUnit !== undefined &&
        (!window.resetAtPath ||
          !["unix", "ms", "iso", "relativeSeconds"].includes(window.resetUnit as string))
      )
        throw new Error("Invalid subscription usage reset unit")
      if (window.select !== undefined) {
        const select = declarativeRecord(window.select, ["arrayPath", "by", "equals"])
        validateUsagePath(select.arrayPath)
        validateUsagePath(select.by)
        if (!(
          (typeof select.equals === "string" && select.equals.length <= 256) ||
          (typeof select.equals === "number" && Number.isFinite(select.equals))
        ))
          throw new Error("Invalid subscription usage window selector")
      }
    }
  } else if (extract.kind === "balance") {
    if (extract.windows !== undefined) throw new Error("Invalid subscription balance extraction")
    for (const field of ["totalPath", "usedPath", "remainingPath"]) {
      if (extract[field] !== undefined) validateUsagePath(extract[field])
    }
    if (!extract.totalPath && !extract.usedPath && !extract.remainingPath)
      throw new Error("Subscription balance requires an extraction path")
    if (extract.scale !== undefined) validatePositiveScale(extract.scale)
    for (const field of ["unit", "currency"]) {
      const value = extract[field]
      if (
        value !== undefined &&
        (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value))
      )
        throw new Error("Invalid subscription usage unit")
    }
  } else throw new Error("Invalid subscription usage extraction kind")
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
