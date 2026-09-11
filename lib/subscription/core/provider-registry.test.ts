import { getProviderDefinition } from "@cognia/provider-core/providers/provider-loader"
import { getAllProviders } from "@cognia/provider-types/provider"
import {
  getSubscriptionProvider,
  listSubscriptionProviders,
  registerPluginSubscriptionProvider,
  saveCustomSubscriptionProvider,
  subscribeSubscriptionProviders,
  unregisterSubscriptionProvidersByPlugin,
  validateSubscriptionProvider,
} from "./provider-registry"
const upsert = jest.fn()
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ upsertCustomProvider: upsert }) },
}))
const definition = {
  id: "api",
  name: "Example",
  baseUrl: "https://example.com/v1",
  protocol: "anthropic" as const,
  models: ["test-model"],
}
afterEach(() => {
  unregisterSubscriptionProvidersByPlugin("example")
  jest.clearAllMocks()
})
test("one declaration adds a provider to account and model registries and unload removes its definition", () => {
  const changed = jest.fn()
  const unsubscribe = subscribeSubscriptionProviders(changed)
  const id = registerPluginSubscriptionProvider(definition, "example")
  expect(id).toBe("example:api")
  expect(getSubscriptionProvider(id)).toMatchObject({
    authMode: "api-key",
    source: "plugin",
    protocol: "anthropic",
  })
  expect(getProviderDefinition(id)).toMatchObject({
    defaultBaseURL: definition.baseUrl,
    defaultModel: "test-model",
  })
  expect(unregisterSubscriptionProvidersByPlugin("example")).toBe(1)
  expect(getSubscriptionProvider(id)).toBeUndefined()
  expect(getProviderDefinition(id)).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(2)
  unsubscribe()
})
test("panel-created provider persists metadata without an API key", async () => {
  const saved = await saveCustomSubscriptionProvider(definition)
  expect(saved.id).toMatch(/^custom-/)
  const stored = upsert.mock.calls[0][0]
  expect(stored).toMatchObject({
    subscription: {},
    apiProtocol: "anthropic",
    customModels: ["test-model"],
  })
  expect(stored).not.toHaveProperty("apiKey")
  expect(listSubscriptionProviders([stored])).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: saved.id, source: "custom" })])
  )
})
test.each([
  { id: "../escape" },
  { baseUrl: "javascript:alert(1)" },
  { baseUrl: "https://user:password@example.com" },
  { protocol: "arbitrary-code" },
  { models: [] },
  { apiKey: "must-not-be-in-manifest" },
])("rejects invalid declarations %s", (patch) => {
  expect(() =>
    validateSubscriptionProvider({ ...definition, ...patch } as typeof definition)
  ).toThrow()
})
test("legacy plan aliases resolve through the same registration", () => {
  expect(getSubscriptionProvider("opencode-go")?.id).toBe("opencode")
  expect(listSubscriptionProviders().map((provider) => provider.id)).toEqual([
    "anthropic",
    "codex",
    "opencode",
    "commandcode",
  ])
})

test("rich model metadata and explicit wire flavor survive registration and catalogue projection", () => {
  const model = {
    id: "reasoner",
    name: "Reasoner",
    contextLength: 262144,
    maxOutputTokens: 8192,
    supportsTools: false,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { promptPer1M: 0, completionPer1M: 2, currency: "USD" as const },
  }
  const id = registerPluginSubscriptionProvider(
    {
      ...definition,
      protocol: "openai",
      apiFlavor: "responses",
      models: [model, "legacy-id"],
      modelApi: { list: true, retrieve: true },
    },
    "example"
  )
  expect(getSubscriptionProvider(id)).toMatchObject({
    models: ["reasoner", "legacy-id"],
    modelMetadata: [model, { id: "legacy-id" }],
    apiFlavor: "responses",
    modelApi: { list: true, retrieve: true },
  })
  expect(getAllProviders()[id]).toMatchObject({
    apiFlavor: "responses",
    models: [expect.objectContaining(model), expect.objectContaining({ id: "legacy-id" })],
  })
  model.contextLength = 1
  expect(getSubscriptionProvider(id)?.modelMetadata?.[0].contextLength).toBe(262144)
})

test("custom model metadata, discovery support and Responses flavor round-trip without credentials", async () => {
  const model = { id: "reasoner", name: "Reasoner", contextLength: 8192, supportsReasoning: true }
  const saved = await saveCustomSubscriptionProvider({
    ...definition,
    protocol: "openai",
    apiFlavor: "responses",
    models: [model],
    modelApi: { list: true },
  })
  const stored = upsert.mock.calls[0][0]
  expect(stored.customModels).toEqual(["reasoner"])
  expect(stored).not.toHaveProperty("apiKey")
  expect(
    listSubscriptionProviders([stored]).find((provider) => provider.id === saved.id)
  ).toMatchObject({
    apiFlavor: "responses",
    modelMetadata: [model],
    modelApi: { list: true },
  })
})

test.each([
  { models: ["same", { id: "same" }] },
  { models: [{ id: "bad", contextLength: -1 }] },
  { models: [{ id: "bad", maxOutputTokens: 1.5 }] },
  { models: [{ id: "bad", supportsVision: "true" }] },
  { models: [{ id: "bad", pricing: { promptPer1M: -1 } }] },
  { models: [{ id: "bad", pricing: { secret: "key" } }] },
  { models: [{ id: "bad", headers: { Authorization: "secret" } }] },
  { models: [null] },
  { modelApi: { list: true, url: "https://other.example/models" } },
  { modelApi: { list: "true" } },
  { apiFlavor: "responses" },
])("rejects invalid model and endpoint metadata %s", (patch) => {
  expect(() => validateSubscriptionProvider({ ...definition, ...patch } as never)).toThrow()
})

test("persisted metadata cannot override host identity or smuggle unsupported fields", () => {
  const custom = {
    id: "custom-example",
    customName: "Example",
    baseURL: definition.baseUrl,
    apiProtocol: definition.protocol,
    customModels: definition.models,
  }
  for (const subscription of [
    { source: "plugin" },
    { id: "codex" },
    { authMode: "codex-oauth" },
    { apiKey: "secret" },
    { callback: () => undefined },
    [],
    { docsUrl: { nested: true } },
    { description: 123 },
  ]) {
    expect(
      listSubscriptionProviders([{ ...custom, subscription }] as never).some(
        (provider) => provider.id === custom.id
      )
    ).toBe(false)
  }
  expect(
    listSubscriptionProviders([
      { ...custom, subscription: { description: "Allowed description" } },
    ] as never)
  ).toContainEqual(
    expect.objectContaining({
      id: custom.id,
      source: "custom",
      authMode: "api-key",
      description: "Allowed description",
    })
  )
})

test("custom settings cannot shadow builtins, plan aliases, plugin namespaces, or earlier custom ids", () => {
  const pluginId = registerPluginSubscriptionProvider(definition, "example")
  const custom = (id: string, name = id) => ({
    id,
    customName: name,
    baseURL: definition.baseUrl,
    apiProtocol: definition.protocol,
    customModels: definition.models,
    subscription: {},
  })
  const providers = listSubscriptionProviders([
    custom("openai"),
    custom("codex"),
    custom("opencode-go"),
    custom(pluginId),
    custom("disabled-plugin:api"),
    custom("custom-example", "First"),
    custom("custom-example", "Duplicate"),
  ] as never)
  expect(providers.filter((provider) => provider.source === "custom")).toEqual([
    expect.objectContaining({ id: "custom-example", name: "First" }),
  ])
  expect(providers.filter((provider) => provider.id === pluginId)).toEqual([
    expect.objectContaining({ source: "plugin" }),
  ])
  expect(getSubscriptionProvider("opencode-go", [custom("opencode-go")] as never)?.id).toBe(
    "opencode"
  )
})
