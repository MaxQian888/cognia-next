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

const refreshCodexAccountIfStaleMock = jest.fn()
jest.mock("./refresh", () => ({
  refreshCodexAccountIfStale: (...a: unknown[]) => refreshCodexAccountIfStaleMock(...a),
}))

import { resolveCodexVaultCredential } from "./chat-bridge"

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    provider: "codex",
    variant: "codex",
    expiresAtMs: 0,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    ...over,
  }
}

function fullAccount(credential: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    credential: {
      provider: "codex",
      refreshToken: "",
      idTokenRaw: "",
      storedAtMs: 0,
      ...credential,
    },
    createdAtMs: 1,
    lastUsedAtMs: 1,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getActiveAccountMock.mockResolvedValue({ activeAccountId: "acc-1", env: [] })
  listPresetsMock.mockResolvedValue([])
  getProviderPresetMock.mockResolvedValue(null)
  // Default: nothing to refresh (fresh / api_key) — the stored credential stands.
  refreshCodexAccountIfStaleMock.mockResolvedValue(null)
})

describe("resolveCodexVaultCredential", () => {
  it("returns null for a non-codex provider id", async () => {
    expect(await resolveCodexVaultCredential("opencode")).toBeNull()
  })

  it("returns null outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await resolveCodexVaultCredential("codex")).toBeNull()
  })

  it("returns null when no codex account exists", async () => {
    getActiveAccountMock.mockResolvedValue({ activeAccountId: undefined, env: [] })
    expect(await resolveCodexVaultCredential("codex")).toBeNull()
  })

  it("api_key mode → genuine OpenAI base URL, no special headers", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({ authMode: "api_key", accessToken: "sk-openai", expiresAtMs: 0 })
    )
    const cred = await resolveCodexVaultCredential("codex")
    expect(cred).toEqual({ apiKey: "sk-openai", baseURL: "https://api.openai.com/v1" })
  })

  it("chatgpt mode → ChatGPT backend + required headers incl. account id", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({
        authMode: "chatgpt",
        accessToken: "chatgpt-bearer",
        accountId: "acct_123",
        expiresAtMs: 9_999_999_999_999,
      })
    )
    const cred = await resolveCodexVaultCredential("codex")
    expect(cred?.apiKey).toBe("chatgpt-bearer")
    expect(cred?.baseURL).toBe("https://chatgpt.com/backend-api/codex")
    expect(cred?.headers).toMatchObject({
      "ChatGPT-Account-Id": "acct_123",
      "OAI-Product-Sku": "codex",
      originator: "codex_cli_rs",
    })
  })

  it("chatgpt mode omits ChatGPT-Account-Id when the credential has none", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(fullAccount({ authMode: "chatgpt", accessToken: "bearer" }))
    const cred = await resolveCodexVaultCredential("codex")
    expect(cred?.headers).not.toHaveProperty("ChatGPT-Account-Id")
  })

  it("a preset baseUrl overrides the resolved default (relay / Azure)", async () => {
    listAccountsMock.mockResolvedValue([summary({ id: "acc-1" })])
    getAccountMock.mockResolvedValue(
      fullAccount({ authMode: "api_key", accessToken: "sk" }, { presetId: "p1" })
    )
    listPresetsMock.mockResolvedValue([{ id: "p1", baseUrl: "https://relay.example.com/v1" }])
    const cred = await resolveCodexVaultCredential("codex")
    expect(cred?.baseURL).toBe("https://relay.example.com/v1")
  })

  it("prefers the active account over the most-recently-used", async () => {
    getActiveAccountMock.mockResolvedValue({ activeAccountId: "acc-2" })
    listAccountsMock.mockResolvedValue([
      summary({ id: "acc-1", lastUsedAtMs: 100 }),
      summary({ id: "acc-2", lastUsedAtMs: 1 }),
    ])
    getAccountMock.mockImplementation(async (_p: string, id: string) =>
      fullAccount({ authMode: "api_key", accessToken: `key-${id}` }, { id })
    )
    const cred = await resolveCodexVaultCredential("codex")
    expect(cred?.apiKey).toBe("key-acc-2")
    expect(getAccountMock).toHaveBeenCalledWith("codex", "acc-2")
  })

  it("returns null on a transport error", async () => {
    getActiveAccountMock.mockRejectedValue(new Error("ipc down"))
    expect(await resolveCodexVaultCredential("codex")).toBeNull()
  })

  it("uses an explicit account without consulting the active pointer", async () => {
    getAccountMock.mockResolvedValue(
      fullAccount({ authMode: "api_key", accessToken: "selected" }, { id: "selected-id" })
    )

    await expect(resolveCodexVaultCredential("codex", "selected-id")).resolves.toMatchObject({
      apiKey: "selected",
    })
    expect(getAccountMock).toHaveBeenCalledWith("codex", "selected-id")
    expect(getActiveAccountMock).not.toHaveBeenCalled()
  })

  it("hands the provider the REFRESHED bearer when the stored one is near expiry", async () => {
    // The gap this covers: the spawn path renewed a stale ChatGPT bearer, chat
    // never did, so a reused subscription 401'd once the token aged out.
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({
        authMode: "chatgpt",
        accessToken: "stale-bearer",
        accountId: "acct_1",
        expiresAtMs: 1,
      })
    )
    refreshCodexAccountIfStaleMock.mockResolvedValue({
      accessToken: "fresh-bearer",
      authMode: "chatgpt",
      accountId: "acct_2",
    })
    const cred = await resolveCodexVaultCredential("codex")
    expect(refreshCodexAccountIfStaleMock).toHaveBeenCalledWith("acc-1")
    expect(cred?.apiKey).toBe("fresh-bearer")
    // The refreshed credential's own account id must win — it is the identity
    // the fresh bearer was minted for.
    expect(cred?.headers).toMatchObject({ "ChatGPT-Account-Id": "acct_2" })
  })

  it("does not touch the refresh path for a fresh credential (runs on every turn)", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({
        authMode: "chatgpt",
        accessToken: "bearer",
        expiresAtMs: 9_999_999_999_999,
      })
    )
    await resolveCodexVaultCredential("codex")
    expect(refreshCodexAccountIfStaleMock).not.toHaveBeenCalled()
  })

  it("does not touch the refresh path for an api_key login", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({ authMode: "api_key", accessToken: "sk-openai", expiresAtMs: 0 })
    )
    await resolveCodexVaultCredential("codex")
    expect(refreshCodexAccountIfStaleMock).not.toHaveBeenCalled()
  })

  it("falls back to the stored bearer when the refresh call fails", async () => {
    listAccountsMock.mockResolvedValue([summary()])
    getAccountMock.mockResolvedValue(
      fullAccount({ authMode: "chatgpt", accessToken: "stale-bearer", expiresAtMs: 1 })
    )
    refreshCodexAccountIfStaleMock.mockRejectedValue(new Error("network down"))
    const cred = await resolveCodexVaultCredential("codex")
    // Degrade to the stale token (it may still work) rather than losing the
    // credential entirely and failing the turn with "not configured".
    expect(cred?.apiKey).toBe("stale-bearer")
  })
})
