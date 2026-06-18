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
  getActiveAccountMock.mockResolvedValue({ activeAccountId: undefined })
  listPresetsMock.mockResolvedValue([])
  getProviderPresetMock.mockResolvedValue(null)
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
    listAccountsMock.mockResolvedValue([])
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
    listAccountsMock.mockRejectedValue(new Error("ipc down"))
    expect(await resolveCodexVaultCredential("codex")).toBeNull()
  })
})
