import { resolveCommandcodeVaultCredential } from "./chat-bridge"

const native = jest.fn(() => true)
const active = jest.fn()
const account = jest.fn()
const presets = jest.fn()
const defaultPreset = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => native() }))
jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: (...args: unknown[]) => active(...args),
  getAccount: (...args: unknown[]) => account(...args),
  listPresets: (...args: unknown[]) => presets(...args),
  getProviderPreset: (...args: unknown[]) => defaultPreset(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  native.mockReturnValue(true)
  active.mockResolvedValue({ activeAccountId: "active" })
  account.mockResolvedValue({
    id: "active",
    credential: { provider: "commandcode", accessToken: " key ", storedAtMs: 1 },
  })
  presets.mockResolvedValue([])
  defaultPreset.mockResolvedValue(null)
})

it("uses the selected account and official endpoint", async () => {
  expect(await resolveCommandcodeVaultCredential("commandcode", "selected")).toEqual({
    apiKey: "key",
    baseURL: "https://api.commandcode.ai/provider/v1",
  })
  expect(account).toHaveBeenCalledWith("commandcode", "selected")
  expect(active).not.toHaveBeenCalled()
})

it("uses the active account when none is selected", async () => {
  await resolveCommandcodeVaultCredential("commandcode")
  expect(account).toHaveBeenCalledWith("commandcode", "active")
})

it("honors a bound preset before the default and removes internal headers", async () => {
  account.mockResolvedValue({
    presetId: "relay",
    credential: {
      provider: "commandcode",
      accessToken: "key",
      baseUrl: "https://account.example/v1",
    },
  })
  presets.mockResolvedValue([
    {
      id: "relay",
      baseUrl: "https://relay.example/v1",
      extraHeaders: { "x-cmd-zdr": "1", "X-Cognia-Private": "internal" },
    },
  ])
  expect(await resolveCommandcodeVaultCredential("commandcode")).toEqual({
    apiKey: "key",
    baseURL: "https://relay.example/v1",
    headers: { "x-cmd-zdr": "1" },
  })
  expect(defaultPreset).not.toHaveBeenCalled()
})

it("uses the actual default when a binding dangles", async () => {
  account.mockResolvedValue({
    presetId: "missing",
    credential: { provider: "commandcode", accessToken: "key" },
  })
  defaultPreset.mockResolvedValue({ baseUrl: "https://default.example/v1" })
  expect(await resolveCommandcodeVaultCredential("commandcode")).toMatchObject({
    baseURL: "https://default.example/v1",
  })
})

it.each([
  null,
  { credential: { provider: "codex", accessToken: "other" } },
  { credential: { provider: "commandcode", accessToken: " " } },
])("does not borrow another credential for invalid accounts", async (value) => {
  account.mockResolvedValue(value)
  expect(await resolveCommandcodeVaultCredential("commandcode", "missing")).toBeNull()
  expect(active).not.toHaveBeenCalled()
})

it("does not access the vault outside desktop or for other providers", async () => {
  native.mockReturnValue(false)
  expect(await resolveCommandcodeVaultCredential("commandcode")).toBeNull()
  native.mockReturnValue(true)
  expect(await resolveCommandcodeVaultCredential("codex")).toBeNull()
  expect(account).not.toHaveBeenCalled()
})

it("returns no credential when the vault cannot be read", async () => {
  account.mockRejectedValue(new Error("locked"))
  expect(await resolveCommandcodeVaultCredential("commandcode")).toBeNull()
})
