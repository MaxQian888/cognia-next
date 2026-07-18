import { refreshAndPersistAnthropicAccount } from "./refresh"
import { discoverAnthropicAuth, discoveredToCredential } from "./discovery"

import type { Account, AnthropicCredentialData, ProviderId } from "@/types/subscription"

jest.mock("./discovery", () => ({
  discoverAnthropicAuth: jest.fn(),
  discoveredToCredential: jest.fn(),
}))

function anthropicAccount(over: Partial<AnthropicCredentialData> = {}): Account {
  return {
    id: "acc-1",
    label: "Max",
    credential: {
      provider: "anthropic",
      accessToken: "old-access",
      refreshToken: "rt-1",
      expiresAtMs: 1_000,
      mode: "subscription",
      email: "max@example.com",
      plan: "max",
      storedAtMs: 0,
      ...over,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  }
}

function refreshedCredential(over: Partial<AnthropicCredentialData> = {}): AnthropicCredentialData {
  return {
    accessToken: "new-access",
    refreshToken: "rt-2",
    expiresAtMs: 9_999_999,
    mode: "subscription",
    storedAtMs: 0,
    ...over,
  }
}

describe("refreshAndPersistAnthropicAccount", () => {
  it("refreshes with the vault's refresh token and upserts the merged credential", async () => {
    const saveAccount = jest.fn(async (_p: ProviderId, _a: Account) => {})
    const setActiveAccount = jest.fn(async (_p: ProviderId, _id: string | null) => {})
    const refreshAccessToken = jest.fn(async () => refreshedCredential())

    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      saveAccount,
      setActiveAccount,
      refreshAccessToken,
      now: () => 42,
    })

    expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: "rt-1", mode: "subscription" })
    expect(merged?.accessToken).toBe("new-access")
    // Persisted with the SAME id (upsert) and a bumped lastUsedAtMs.
    const saved = saveAccount.mock.calls[0][1]
    expect(saved.id).toBe("acc-1")
    expect(saved.lastUsedAtMs).toBe(42)
    expect(saved.credential).toMatchObject({ provider: "anthropic", accessToken: "new-access" })
    // Default reactivate:false → sidecar not restarted.
    expect(setActiveAccount).not.toHaveBeenCalled()
  })

  it("re-syncs a reused Claude CLI login without rotating its refresh token copy", async () => {
    const linked = anthropicAccount({
      originalSource: "keyring",
    } as Partial<AnthropicCredentialData>)
    const local = refreshedCredential({
      accessToken: "cli-current-access",
      refreshToken: "cli-current-refresh",
      originalSource: "keyring",
    } as Partial<AnthropicCredentialData>)
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const saveAccount = jest.fn(async (_p: ProviderId, _a: Account) => {})
    const discoverLocalCredential = jest.fn(async () => local)
    const deps = {
      getAccount: async () => linked,
      saveAccount,
      setActiveAccount: async () => {},
      refreshAccessToken,
      discoverLocalCredential,
      now: () => 42,
    }

    const merged = await refreshAndPersistAnthropicAccount("acc-1", deps)

    expect(merged?.accessToken).toBe("cli-current-access")
    expect(discoverLocalCredential).toHaveBeenCalledTimes(1)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(saveAccount.mock.calls[0][1].credential).toMatchObject({
      provider: "anthropic",
      accessToken: "cli-current-access",
      originalSource: "keyring",
    })
  })

  it("uses the default CLI discovery adapter for a linked account", async () => {
    const local = refreshedCredential({ originalSource: "keyring" })
    jest
      .mocked(discoverAnthropicAuth)
      .mockResolvedValue({ source: "keyring", credential: {} } as never)
    jest.mocked(discoveredToCredential).mockReturnValue(local)

    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount({ originalSource: "keyring" }),
      saveAccount: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential(),
    })

    expect(merged).toMatchObject({ accessToken: "new-access", originalSource: "keyring" })
    expect(discoverAnthropicAuth).toHaveBeenCalledTimes(1)
    expect(discoveredToCredential).toHaveBeenCalledTimes(1)
  })

  it("keeps a file-linked account unchanged when the CLI login is unavailable", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const saveAccount = jest.fn(async () => {})
    const deps = {
      getAccount: async () =>
        anthropicAccount({ originalSource: "file" } as Partial<AnthropicCredentialData>),
      saveAccount,
      setActiveAccount: async () => {},
      refreshAccessToken,
      discoverLocalCredential: async () => null,
    }

    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).resolves.toBeNull()
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(saveAccount).not.toHaveBeenCalled()
  })

  it("re-activates the account only when reactivate is true", async () => {
    const setActiveAccount = jest.fn(async () => {})
    await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      saveAccount: async () => {},
      setActiveAccount,
      refreshAccessToken: async () => refreshedCredential(),
      reactivate: true,
    })
    expect(setActiveAccount).toHaveBeenCalledWith("anthropic", "acc-1")
  })

  it("keeps the richer email/plan when the refresh response omits them", async () => {
    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      saveAccount: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential({ email: undefined, plan: undefined }),
    })
    expect(merged?.email).toBe("max@example.com")
    expect(merged?.plan).toBe("max")
  })

  it("returns null (no refresh) when the account is missing", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const out = await refreshAndPersistAnthropicAccount("gone", {
      getAccount: async () => null,
      saveAccount: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken,
    })
    expect(out).toBeNull()
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it("returns null when the stored credential isn't an Anthropic one", async () => {
    const out = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () =>
        ({
          id: "acc-1",
          credential: { provider: "opencode-zen", accessToken: "z", storedAtMs: 0 },
          createdAtMs: 0,
          lastUsedAtMs: 0,
        }) as Account,
      saveAccount: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential(),
    })
    expect(out).toBeNull()
  })
})
