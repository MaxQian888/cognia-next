const mockInvoke = jest.fn()
const mockIsTauri = jest.fn(() => true)

jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

import {
  clearProviderBalanceToken,
  migrateProviderBalanceToken,
  runProviderBalanceScript,
} from "./sandbox"

beforeEach(() => jest.clearAllMocks())

it("migrates plaintext securely before returning its credential reference", async () => {
  mockInvoke.mockResolvedValue("source-1")
  await expect(migrateProviderBalanceToken("source-1", "secret")).resolves.toBe("source-1")
  expect(mockInvoke).toHaveBeenCalledWith("provider_diagnostics_migrate_balance_token", {
    sourceId: "source-1",
    token: "secret",
  })
})

it("passes only source policy and sanitized provider metadata to the native sandbox", async () => {
  mockInvoke.mockResolvedValue({ sourceId: "source-1", amounts: [], requestCount: 1 })
  await runProviderBalanceScript(
    {
      id: "source-1",
      providerId: "custom",
      label: "Balance",
      script: "function buildRequests() { return []; }",
      sameOrigin: "https://api.example.com",
      credentialRef: "source-1",
      grants: [],
      enabled: true,
    },
    { providerId: "custom", endpoint: "https://api.example.com" }
  )
  const payload = mockInvoke.mock.calls[0][1]
  expect(payload).not.toHaveProperty("token")
  expect(payload.request.providerMetadata).toEqual({
    providerId: "custom",
    endpoint: "https://api.example.com",
  })
})

it("refuses to expose credentials in a non-desktop runtime", async () => {
  mockIsTauri.mockReturnValue(false)
  await expect(migrateProviderBalanceToken("source-1", "secret")).rejects.toThrow("desktop")
})

it("revokes the secure credential when a source is removed", async () => {
  mockIsTauri.mockReturnValue(true)
  mockInvoke.mockResolvedValue(undefined)
  await clearProviderBalanceToken("source-1")
  expect(mockInvoke).toHaveBeenCalledWith("provider_diagnostics_clear_balance_token", {
    sourceId: "source-1",
  })
})
