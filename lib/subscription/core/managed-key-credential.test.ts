const mockLocalAccount = { unlockedAccountId: "local-a" as string | null }
const mockPluginAvailable = { value: true }
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => mockLocalAccount },
}))
jest.mock("./provider-registry", () => ({
  getSubscriptionProvider: () => (mockPluginAvailable.value ? {} : undefined),
}))
import { resolveManagedSubscriptionCredential } from "./managed-key-credential"
import * as transport from "./transport"
import { isTauri } from "@/lib/tauri"
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("./transport", () => ({
  getAccount: jest.fn(),
  getActiveAccount: jest.fn(),
  getProviderPreset: jest.fn(),
  listPresets: jest.fn(),
}))
const definition = {
  id: "example:api",
  name: "Example",
  authMode: "api-key" as const,
  source: "plugin" as const,
  baseUrl: "https://example.com/v1",
  protocol: "openai" as const,
}
beforeEach(() => {
  jest.clearAllMocks()
  mockLocalAccount.unlockedAccountId = "local-a"
  mockPluginAvailable.value = true
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(transport.getActiveAccount).mockResolvedValue({ activeAccountId: "active", env: [] })
  jest.mocked(transport.getAccount).mockResolvedValue({
    id: "active",
    credential: {
      provider: "api-key",
      providerId: definition.id,
      accessToken: "secret",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  })
  jest.mocked(transport.getProviderPreset).mockResolvedValue(null)
  jest.mocked(transport.listPresets).mockResolvedValue([])
})
test("resolves an explicitly selected account without switching or consulting the active pointer", async () => {
  expect(await resolveManagedSubscriptionCredential(definition, "chosen")).toEqual({
    apiKey: "secret",
    baseURL: definition.baseUrl,
  })
  expect(transport.getAccount).toHaveBeenCalledWith(definition.id, "chosen")
  expect(transport.getActiveAccount).not.toHaveBeenCalled()
})
test("presets override the provider endpoint and filter internal headers", async () => {
  jest.mocked(transport.getProviderPreset).mockResolvedValue({
    id: "p",
    label: "Relay",
    baseUrl: "https://relay.example/v1",
    extraHeaders: { "X-Tenant": "team", "x-cognia-private": "omit" },
  })
  expect(await resolveManagedSubscriptionCredential(definition)).toEqual({
    apiKey: "secret",
    baseURL: "https://relay.example/v1",
    headers: { "X-Tenant": "team" },
  })
})
test.each([
  "https://api.kimi.com/coding/",
  "https://api.kimi.com/coding/v1",
  "https://api.kimi.com/coding/v1/",
])("normalizes Anthropic subscription endpoint %s for the chat SDK", async (baseUrl) => {
  expect(
    await resolveManagedSubscriptionCredential({ ...definition, protocol: "anthropic", baseUrl })
  ).toMatchObject({ baseURL: "https://api.kimi.com/coding/v1" })
})
test("normalizes the selected account preset after applying endpoint precedence", async () => {
  const account = await transport.getAccount(definition.id, "active")
  jest.mocked(transport.getAccount).mockResolvedValue({ ...account!, presetId: "account-preset" })
  jest
    .mocked(transport.listPresets)
    .mockResolvedValue([
      { id: "account-preset", label: "Kimi", baseUrl: "https://relay.example/coding/" },
    ])
  expect(
    await resolveManagedSubscriptionCredential({ ...definition, protocol: "anthropic" })
  ).toMatchObject({ baseURL: "https://relay.example/coding/v1" })
  expect(transport.getProviderPreset).not.toHaveBeenCalled()
})
test("carries the declared OpenAI endpoint flavor with the vault credential", async () => {
  expect(
    await resolveManagedSubscriptionCredential({ ...definition, apiFlavor: "responses" })
  ).toMatchObject({ apiFlavor: "responses", baseURL: definition.baseUrl })
})
test("provider mismatch and disabled plugin definitions never reveal a key", async () => {
  const account = await transport.getAccount(definition.id, "active")
  jest.mocked(transport.getAccount).mockResolvedValue({
    ...account!,
    credential: {
      provider: "api-key",
      providerId: "other:api",
      accessToken: "secret",
      storedAtMs: 0,
    },
  })
  expect(await resolveManagedSubscriptionCredential(definition)).toBeNull()
  jest.mocked(transport.getAccount).mockClear()
  expect(await resolveManagedSubscriptionCredential({ ...definition, available: false })).toBeNull()
  expect(transport.getAccount).not.toHaveBeenCalled()
})
test("web and locked/missing credentials remain unavailable", async () => {
  jest.mocked(isTauri).mockReturnValue(false)
  expect(await resolveManagedSubscriptionCredential(definition)).toBeNull()
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(transport.getAccount).mockRejectedValue(new Error("locked"))
  expect(await resolveManagedSubscriptionCredential(definition)).toBeNull()
})

test.each(["lock", "unload"])(
  "discards a resolved key when %s occurs during vault reads",
  async (action) => {
    jest.mocked(transport.getProviderPreset).mockImplementation(async () => {
      if (action === "lock") mockLocalAccount.unlockedAccountId = null
      else mockPluginAvailable.value = false
      return null
    })
    expect(await resolveManagedSubscriptionCredential(definition)).toBeNull()
  }
)
