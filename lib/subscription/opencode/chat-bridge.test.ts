const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const listAccountsMock = jest.fn()
const getAccountMock = jest.fn()
const getActiveAccountMock = jest.fn()
const listPresetsMock = jest.fn()
const getProviderPresetMock = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: (...a: unknown[]) => listAccountsMock(...a),
  getAccount: (...a: unknown[]) => getAccountMock(...a),
  getActiveAccount: (...a: unknown[]) => getActiveAccountMock(...a),
  listPresets: (...a: unknown[]) => listPresetsMock(...a),
  getProviderPreset: (...a: unknown[]) => getProviderPresetMock(...a),
}))

import { resolveOpencodeVaultCredential } from "./chat-bridge"

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    provider: "opencode",
    variant: "opencode-zen",
    plan: "zen",
    expiresAtMs: 0,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    ...over,
  }
}

function fullAccount(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    credential: {
      provider: "opencode-zen",
      accessToken: "sk-zen",
      storedAtMs: 0,
    },
    createdAtMs: 1,
    lastUsedAtMs: 1,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getActiveAccountMock.mockResolvedValue({ env: [] })
  listPresetsMock.mockResolvedValue([])
  getProviderPresetMock.mockResolvedValue(null)
})

describe("resolveOpencodeVaultCredential", () => {
  it("returns null for non-opencode provider ids", async () => {
    expect(await resolveOpencodeVaultCredential("openai")).toBeNull()
    expect(listAccountsMock).not.toHaveBeenCalled()
  })

  it("returns null outside tauri", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await resolveOpencodeVaultCredential("opencode")).toBeNull()
    expect(listAccountsMock).not.toHaveBeenCalled()
  })

  it("resolves a zen account for the opencode provider with the zen default URL", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(fullAccount())
    expect(await resolveOpencodeVaultCredential("opencode")).toEqual({
      apiKey: "sk-zen",
      baseURL: "https://opencode.ai/zen/v1",
    })
    expect(getAccountMock).toHaveBeenCalledWith("opencode", "acc-1")
  })

  it("resolves a go account for opencode-go with the go default URL", async () => {
    listAccountsMock.mockResolvedValue([
      summary(),
      summary({ id: "acc-go", plan: "go", lastUsedAtMs: 5 }),
    ])
    getAccountMock.mockResolvedValue(
      fullAccount({
        id: "acc-go",
        credential: { provider: "opencode-zen", accessToken: "sk-go", plan: "go", storedAtMs: 0 },
      })
    )
    expect(await resolveOpencodeVaultCredential("opencode-go")).toEqual({
      apiKey: "sk-go",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
    expect(getAccountMock).toHaveBeenCalledWith("opencode", "acc-go")
  })

  it("treats a missing plan as zen", async () => {
    listAccountsMock.mockResolvedValue([summary({ plan: undefined })])
    getAccountMock.mockResolvedValue(fullAccount())
    expect(await resolveOpencodeVaultCredential("opencode")).not.toBeNull()
    expect(await resolveOpencodeVaultCredential("opencode-go")).toBeNull()
  })

  it("prefers the active account over a more recently used one", async () => {
    listAccountsMock.mockResolvedValue([
      summary({ id: "acc-old", lastUsedAtMs: 1 }),
      summary({ id: "acc-new", lastUsedAtMs: 99 }),
    ])
    getActiveAccountMock.mockResolvedValue({ activeAccountId: "acc-old", env: [] })
    getAccountMock.mockResolvedValue(fullAccount({ id: "acc-old" }))
    await resolveOpencodeVaultCredential("opencode")
    expect(getAccountMock).toHaveBeenCalledWith("opencode", "acc-old")
  })

  it("falls back to most recently used when the active account's plan mismatches", async () => {
    listAccountsMock.mockResolvedValue([
      summary({ id: "acc-zen", plan: "zen" }),
      summary({ id: "acc-go-1", plan: "go", lastUsedAtMs: 2 }),
      summary({ id: "acc-go-2", plan: "go", lastUsedAtMs: 9 }),
    ])
    getActiveAccountMock.mockResolvedValue({ activeAccountId: "acc-zen", env: [] })
    getAccountMock.mockResolvedValue(
      fullAccount({
        id: "acc-go-2",
        credential: { provider: "opencode-zen", accessToken: "sk", plan: "go", storedAtMs: 0 },
      })
    )
    await resolveOpencodeVaultCredential("opencode-go")
    expect(getAccountMock).toHaveBeenCalledWith("opencode", "acc-go-2")
  })

  it("honours an explicit per-account base URL override", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({
        credential: {
          provider: "opencode-zen",
          accessToken: "sk",
          baseUrl: "https://proxy.example/v1",
          storedAtMs: 0,
        },
      })
    )
    expect(await resolveOpencodeVaultCredential("opencode")).toEqual({
      apiKey: "sk",
      baseURL: "https://proxy.example/v1",
    })
  })

  it("skips discovery rows and blank tokens", async () => {
    listAccountsMock.mockResolvedValue([summary({ variant: "opencode-discovered" })])
    expect(await resolveOpencodeVaultCredential("opencode")).toBeNull()

    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({ credential: { provider: "opencode-zen", accessToken: "   ", storedAtMs: 0 } })
    )
    expect(await resolveOpencodeVaultCredential("opencode")).toBeNull()
  })

  it("returns null when no accounts exist or transport throws", async () => {
    listAccountsMock.mockResolvedValue([])
    expect(await resolveOpencodeVaultCredential("opencode")).toBeNull()

    listAccountsMock.mockRejectedValue(new Error("keyring locked"))
    expect(await resolveOpencodeVaultCredential("opencode")).toBeNull()
  })

  it("prefers a bound preset's base URL over the account override", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({
        presetId: "preset-1",
        credential: {
          provider: "opencode-zen",
          accessToken: "sk",
          baseUrl: "https://account.example/v1",
          storedAtMs: 0,
        },
      })
    )
    listPresetsMock.mockResolvedValue([
      { id: "preset-1", label: "Relay", baseUrl: "https://relay.example/v1" },
    ])
    expect(await resolveOpencodeVaultCredential("opencode")).toEqual({
      apiKey: "sk",
      baseURL: "https://relay.example/v1",
    })
  })

  it("falls back to the default preset when the bound one is gone", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(fullAccount({ presetId: "deleted" }))
    listPresetsMock.mockResolvedValue([])
    getProviderPresetMock.mockResolvedValue({
      id: "default-1",
      label: "Default relay",
      baseUrl: "https://default-relay.example/v1",
    })
    expect(await resolveOpencodeVaultCredential("opencode")).toEqual({
      apiKey: "sk-zen",
      baseURL: "https://default-relay.example/v1",
    })
  })

  it("degrades to the plan default when preset lookups throw", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(fullAccount({ presetId: "p" }))
    listPresetsMock.mockRejectedValue(new Error("nope"))
    expect(await resolveOpencodeVaultCredential("opencode")).toEqual({
      apiKey: "sk-zen",
      baseURL: "https://opencode.ai/zen/v1",
    })
  })

  it("tolerates getActiveAccount failure", async () => {
    getActiveAccountMock.mockRejectedValue(new Error("nope"))
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(fullAccount())
    expect(await resolveOpencodeVaultCredential("opencode")).not.toBeNull()
  })
})
