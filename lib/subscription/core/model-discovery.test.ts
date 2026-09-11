import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"
const definition: SubscriptionProviderDefinition = {
  id: "example:kimi",
  name: "Kimi",
  source: "plugin",
  authMode: "api-key",
  protocol: "anthropic",
  baseUrl: "https://api.example/coding",
  models: ["kimi"],
  modelApi: { list: true, retrieve: true },
}
const list = jest.fn()
const detail = jest.fn()
const credential = jest.fn()
const account = jest.fn()
const activeAccount = jest.fn()
let unlockedAccountId = "local"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ unlockedAccountId }) },
}))
const presets = jest.fn()
const defaultPreset = jest.fn()
let registered: SubscriptionProviderDefinition | undefined = definition
jest.mock("@/lib/ai/operations/handlers/discovery", () => ({
  listProviderModels: (...args: unknown[]) => list(...args),
  getProviderModel: (...args: unknown[]) => detail(...args),
}))
jest.mock("./provider-registry", () => ({ getSubscriptionProvider: () => registered }))
jest.mock("./managed-key-credential", () => ({
  resolveManagedSubscriptionCredential: (...args: unknown[]) => credential(...args),
}))
jest.mock("./transport", () => ({
  getActiveAccount: (...args: unknown[]) => activeAccount(...args),
  getAccount: (...args: unknown[]) => account(...args),
  getProviderPreset: (...args: unknown[]) => defaultPreset(...args),
  listPresets: (...args: unknown[]) => presets(...args),
}))
import { discoverSubscriptionModels, getSubscriptionModel } from "./model-discovery"

beforeEach(() => {
  jest.clearAllMocks()
  registered = definition
  unlockedAccountId = "local"
  activeAccount.mockResolvedValue({ activeAccountId: "active" })
  credential.mockResolvedValue({ apiKey: "vault-key", baseURL: "https://vault.example/v1" })
  account.mockResolvedValue({ presetId: "bound" })
  presets.mockResolvedValue([
    {
      id: "bound",
      baseUrl: "https://bound.example/v1",
      extraHeaders: { "x-project": "project", "x-cognia-private": "hidden" },
    },
  ])
  defaultPreset.mockResolvedValue(null)
  list.mockResolvedValue({ models: [{ id: "kimi", contextLength: 256000 }], freshness: "fresh" })
  detail.mockResolvedValue({ model: { id: "kimi", supportsTools: true } })
})

it("uses saved vault credentials and returns metadata without storing credentials", async () => {
  const result = await discoverSubscriptionModels({ definition, accountId: "selected" })
  expect(result.models[0].contextLength).toBe(256000)
  expect(credential).toHaveBeenCalledWith(definition, "selected")
  const input = list.mock.calls[0][0]
  expect(input.provider).toMatchObject({
    apiKey: "vault-key",
    baseURL: "https://vault.example/v1",
    protocol: "anthropic",
  })
  expect(input.settings).toEqual({ providers: {}, customProviders: [], defaultProvider: undefined })
  expect(await input.persistence.readInventory("anything")).toBeUndefined()
})

it("honors creation and existing-account preset bindings ahead of preview overrides", async () => {
  await discoverSubscriptionModels({
    definition,
    preview: { apiKey: "new-key", baseUrl: "https://override.example/v1", presetId: "bound" },
  })
  expect(list.mock.calls[0][0].provider).toMatchObject({
    baseURL: "https://bound.example/v1",
    headers: { "x-project": "project" },
  })
  await discoverSubscriptionModels({
    definition,
    accountId: "saved",
    preview: { apiKey: "replacement", baseUrl: "https://override.example/v1" },
  })
  expect(account).toHaveBeenCalledWith(definition.id, "saved")
  expect(list.mock.calls[1][0].provider.baseURL).toBe("https://bound.example/v1")
  expect(credential).not.toHaveBeenCalled()
})

it("uses the provider preset and normalizes Anthropic roots for a transient key", async () => {
  defaultPreset.mockResolvedValue({ baseUrl: "https://default.example/coding" })
  await getSubscriptionModel({ definition, model: "kimi", preview: { apiKey: "new-key" } })
  expect(detail).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "kimi",
      provider: expect.objectContaining({ baseURL: "https://default.example/coding/v1" }),
    })
  )
})

it("never falls back to the default endpoint when preset resolution fails", async () => {
  presets.mockRejectedValue(new Error("vault locked"))
  await expect(
    discoverSubscriptionModels({ definition, preview: { apiKey: "new-key", presetId: "bound" } })
  ).rejects.toThrow("vault locked")
  expect(list).not.toHaveBeenCalled()
})

it("rejects missing keys, unsafe URLs and unloaded providers before dispatch", async () => {
  credential.mockResolvedValue(null)
  await expect(discoverSubscriptionModels({ definition })).rejects.toMatchObject({
    code: "credentialsRequired",
  })
  await expect(
    discoverSubscriptionModels({
      definition,
      preview: { apiKey: "key", baseUrl: "https://user:password@example.com" },
    })
  ).rejects.toMatchObject({ code: "invalidBaseUrl" })
  registered = undefined
  await expect(
    discoverSubscriptionModels({ definition, preview: { apiKey: "key" } })
  ).rejects.toMatchObject({ code: "unavailable" })
  expect(list).not.toHaveBeenCalled()
})

it("discards results after cancellation, key rotation or plugin removal", async () => {
  const controller = new AbortController()
  list.mockImplementationOnce(async () => {
    controller.abort()
    return { models: [] }
  })
  await expect(
    discoverSubscriptionModels({ definition, signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
  credential.mockResolvedValueOnce({ apiKey: "before", baseURL: "https://vault.example/v1" })
  credential.mockResolvedValueOnce({ apiKey: "after", baseURL: "https://vault.example/v1" })
  await expect(discoverSubscriptionModels({ definition })).rejects.toMatchObject({
    name: "AbortError",
  })
  list.mockImplementationOnce(async () => {
    registered = undefined
    return { models: [] }
  })
  await expect(discoverSubscriptionModels({ definition })).rejects.toMatchObject({
    code: "unavailable",
  })
})

it("discards results on active-account or local-vault changes even if credentials match", async () => {
  list.mockImplementationOnce(async () => {
    activeAccount.mockResolvedValue({ activeAccountId: "other" })
    return { models: [] }
  })
  await expect(discoverSubscriptionModels({ definition })).rejects.toMatchObject({
    name: "AbortError",
  })
  list.mockImplementationOnce(async () => {
    unlockedAccountId = "other-local"
    return { models: [] }
  })
  await expect(
    discoverSubscriptionModels({ definition, preview: { apiKey: "key" } })
  ).rejects.toMatchObject({ name: "AbortError" })
})
