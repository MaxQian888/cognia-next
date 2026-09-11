import type { CustomProviderSettings } from "@cognia/provider-types/provider"
import {
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  isBuiltInProviderId,
} from "@cognia/provider-types"
import {
  registerProviderDefinition,
  unregisterProvider,
} from "@cognia/provider-core/providers/provider-loader"
import { createOverlayRegistry } from "@/lib/plugin/registries/createOverlayRegistry"
import type {
  PluginSubscriptionProviderDefinition,
  SubscriptionProviderDefinition,
  SubscriptionModelDefinition,
} from "@/types/subscription/provider-definition"
import { notifySubscriptionChanged } from "./subscription-events"
import { isValidSubscriptionProviderId } from "@/types/subscription/credential"

export type {
  PluginSubscriptionProviderDefinition,
  SubscriptionProviderDefinition,
} from "@/types/subscription/provider-definition"

const builtins: readonly SubscriptionProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", authMode: "anthropic-oauth", source: "builtin" },
  { id: "codex", name: "Codex", authMode: "codex-oauth", source: "builtin" },
  {
    id: "opencode",
    name: "OpenCode",
    authMode: "api-key",
    source: "builtin",
    legacyCredentialKind: "opencode",
    protocol: "openai",
    baseUrl: getBuiltInProviderDefaultBaseURL("opencode"),
    apiKeyUrl: "https://opencode.ai/auth",
    plans: [
      {
        id: "zen",
        name: "Zen",
        baseUrl: getBuiltInProviderDefaultBaseURL("opencode")!,
        chatProviderId: "opencode",
      },
      {
        id: "go",
        name: "Go",
        baseUrl: getBuiltInProviderDefaultBaseURL("opencode-go")!,
        chatProviderId: "opencode-go",
      },
    ],
  },
  {
    id: "commandcode",
    name: "CommandCode",
    authMode: "api-key",
    source: "builtin",
    legacyCredentialKind: "commandcode",
    protocol: "openai",
    baseUrl: getBuiltInProviderDefaultBaseURL("commandcode"),
    models: [getBuiltInProviderDefaultModel("commandcode")!, "claude-sonnet-5"],
    apiKeyUrl: "https://commandcode.ai/settings/keys",
    usageUrl: "https://commandcode.ai/studio",
    docsUrl: "https://commandcode.ai/docs/provider",
  },
]

const plugins = createOverlayRegistry<SubscriptionProviderDefinition>({
  name: "subscription-provider",
  conflictPolicy: "first-wins-cross-plugin",
})
const listeners = new Set<() => void>()
export function subscribeSubscriptionProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function changed() {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* Keep other registry consumers up to date. */
    }
  }
  notifySubscriptionChanged()
}

export { isValidSubscriptionProviderId } from "@/types/subscription/credential"

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

/** Preserve the existing ID-only host surface while retaining declared model information. */
export function subscriptionModelMetadata(
  definition: Pick<PluginSubscriptionProviderDefinition, "models">
): SubscriptionModelDefinition[] {
  return definition.models.map((model) =>
    typeof model === "string" ? { id: model } : structuredClone(model)
  )
}

export function listSubscriptionProviders(
  customProviders: readonly CustomProviderSettings[] = []
): SubscriptionProviderDefinition[] {
  const pluginDefinitions = plugins.entries().map(({ entry }) => entry)
  const reservedIds = new Set([
    ...builtins.flatMap((provider) => [
      provider.id,
      ...(provider.plans?.map((plan) => plan.chatProviderId) ?? []),
    ]),
    ...pluginDefinitions.map((provider) => provider.id),
  ])
  const metadataFields = new Set(["apiKeyUrl", "usageUrl", "docsUrl", "description", "modelApi"])
  const custom = customProviders.flatMap((provider): SubscriptionProviderDefinition[] => {
    const metadata = provider.subscription
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some((field) => !metadataFields.has(field))
    )
      return []
    const definition: PluginSubscriptionProviderDefinition = {
      id: provider.id,
      name: provider.customName,
      baseUrl: provider.baseURL!,
      protocol: provider.apiProtocol as "openai" | "anthropic",
      ...(provider.apiFlavor && provider.apiFlavor !== "auto"
        ? { apiFlavor: provider.apiFlavor }
        : {}),
      models: provider.customModels.map((id) => {
        const { capabilities, ...model } = provider.customModelMetadata?.[id] ?? { id }
        return {
          ...model,
          id,
          supportsTools: model.supportsTools ?? capabilities?.functionCalling,
          supportsVision: model.supportsVision ?? capabilities?.vision,
          supportsStreaming: model.supportsStreaming ?? capabilities?.streaming,
        }
      }),
      modelApi: metadata.modelApi,
      apiKeyUrl: metadata.apiKeyUrl,
      usageUrl: metadata.usageUrl,
      docsUrl: metadata.docsUrl,
      description: metadata.description,
    }
    try {
      validateSubscriptionProvider(definition)
      if (
        isBuiltInProviderId(definition.id) ||
        reservedIds.has(definition.id) ||
        definition.id.includes(":")
      )
        return []
      reservedIds.add(definition.id)
      return [
        {
          ...definition,
          models: provider.customModels,
          modelMetadata: subscriptionModelMetadata(definition),
          authMode: "api-key",
          source: "custom",
        },
      ]
    } catch {
      return []
    }
  })
  return [...builtins, ...custom, ...pluginDefinitions]
}

export function getSubscriptionProvider(
  id: string,
  customProviders: readonly CustomProviderSettings[] = []
): SubscriptionProviderDefinition | undefined {
  return listSubscriptionProviders(customProviders).find(
    (provider) => provider.id === id || provider.plans?.some((plan) => plan.chatProviderId === id)
  )
}

export function registerPluginSubscriptionProvider(
  definition: PluginSubscriptionProviderDefinition,
  pluginId: string
): string {
  validateSubscriptionProvider(definition)
  const id = `${pluginId}:${definition.id}`
  if (!isValidSubscriptionProviderId(id))
    throw new Error("Invalid namespaced subscription provider id")
  const registered: SubscriptionProviderDefinition = {
    ...definition,
    models: definition.models.map((model) => (typeof model === "string" ? model : model.id)),
    modelMetadata: subscriptionModelMetadata(definition),
    ...(definition.protocol === "openai" ? { apiFlavor: definition.apiFlavor ?? "chat" } : {}),
    id,
    authMode: "api-key",
    source: "plugin",
    pluginId,
  }
  plugins.register(id, registered, { pluginId })
  registerProviderDefinition(
    {
      id,
      name: definition.name,
      type: "cloud",
      protocol: definition.protocol,
      ...(definition.protocol === "openai" ? { apiFlavor: definition.apiFlavor ?? "chat" } : {}),
      defaultBaseURL: definition.baseUrl,
      apiKeyRequired: true,
      baseURLRequired: false,
      defaultModel: registered.models![0],
      defaultEnabled: false,
      category: "specialized",
      description: definition.description,
      models: registered.modelMetadata!.map((model) => ({
        name: model.name ?? model.id,
        contextLength: 0,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
        ...model,
        knownFields: Object.keys(model).filter(
          (field) => model[field as keyof typeof model] !== undefined
        ),
      })),
    },
    "plugin"
  )
  changed()
  return id
}

export function unregisterSubscriptionProvidersByPlugin(pluginId: string): number {
  const owned = plugins.entries().filter((entry) => entry.pluginId === pluginId)
  for (const { id } of owned) unregisterProvider(id)
  const removed = plugins.unregisterByPlugin(pluginId)
  if (removed) changed()
  return removed
}

export async function saveCustomSubscriptionProvider(
  input: Omit<PluginSubscriptionProviderDefinition, "id">
): Promise<SubscriptionProviderDefinition> {
  const { uuidv7 } = await import("./uuidv7")
  const definition = { ...input, id: `custom-${uuidv7()}` }
  validateSubscriptionProvider(definition)
  const modelMetadata = subscriptionModelMetadata(definition)
  const models = modelMetadata.map((model) => model.id)
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  await useSettingsStore.getState().upsertCustomProvider({
    id: definition.id,
    providerId: definition.id,
    isCustom: true,
    name: definition.name,
    customName: definition.name,
    baseURL: definition.baseUrl,
    apiProtocol: definition.protocol,
    apiFlavor: definition.apiFlavor,
    customModels: models,
    models,
    customModelMetadata: Object.fromEntries(modelMetadata.map((model) => [model.id, model])),
    defaultModel: models[0],
    enabled: true,
    subscription: {
      apiKeyUrl: definition.apiKeyUrl,
      usageUrl: definition.usageUrl,
      docsUrl: definition.docsUrl,
      description: definition.description,
      modelApi: definition.modelApi,
    },
  })
  changed()
  return { ...definition, models, modelMetadata, authMode: "api-key", source: "custom" }
}
