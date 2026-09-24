import { __resetSubscriptionBreakerForTesting } from "@/lib/subscription/retry/breaker"

import {
  __resetAnthropicRefreshInFlightForTesting,
  refreshAndPersistAnthropicAccount,
} from "./refresh"
import { discoverAnthropicAuth, discoveredToCredential } from "./discovery"

import type { Account, AnthropicCredentialData, ProviderId } from "@/types/subscription"

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ unlockedAccountId: "local-test" }) },
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  getAccount: jest.fn(),
  refreshAnthropicAccountCredential: jest.fn(),
  setActiveAccount: jest.fn(),
}))

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

// Both the token-endpoint block and the single-flight map are process-wide by
// design, so a case that makes a refresh fail would otherwise gate every later
// case for the same account id.
beforeEach(() => {
  __resetSubscriptionBreakerForTesting()
  __resetAnthropicRefreshInFlightForTesting()
})

describe("refreshAndPersistAnthropicAccount", () => {
  it("coalesces concurrent refreshes for the same account", async () => {
    let release!: (credential: AnthropicCredentialData) => void
    const pending = new Promise<AnthropicCredentialData>((resolve) => {
      release = resolve
    })
    const refreshAccessToken = jest.fn(() => pending)
    const persistCredential = jest.fn(async () => {})
    const setActiveAccount = jest.fn(async () => {})
    const deps = {
      getAccount: async () => anthropicAccount(),
      persistCredential,
      setActiveAccount,
      refreshAccessToken,
    }

    const first = refreshAndPersistAnthropicAccount("acc-1", deps)
    const second = refreshAndPersistAnthropicAccount("acc-1", { ...deps, reactivate: true })

    expect(first).toBe(second)
    await Promise.resolve()
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    release(refreshedCredential())
    const results = await Promise.all([first, second])
    expect(results[0]).toMatchObject({ accessToken: "new-access", refreshToken: "rt-2" })
    expect(results[1]).toEqual(results[0])
    expect(persistCredential).toHaveBeenCalledTimes(1)
    expect(setActiveAccount).toHaveBeenCalledWith("anthropic", "acc-1")
  })

  it("refreshes with the vault's refresh token and upserts the merged credential", async () => {
    const persistCredential = jest.fn(
      async (
        _local: string,
        _id: string,
        _old: AnthropicCredentialData,
        _new: AnthropicCredentialData
      ) => {}
    )
    const setActiveAccount = jest.fn(async (_p: ProviderId, _id: string | null) => {})
    const refreshAccessToken = jest.fn(async () => refreshedCredential())

    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      persistCredential,
      setActiveAccount,
      refreshAccessToken,
      now: () => 42,
    })

    expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: "rt-1", mode: "subscription" })
    expect(merged?.accessToken).toBe("new-access")
    // Persisted with the SAME id (upsert) and a bumped lastUsedAtMs.
    expect(persistCredential).toHaveBeenCalledWith(
      "local-test",
      "acc-1",
      anthropicAccount().credential,
      expect.objectContaining({ accessToken: "new-access" })
    )
    // Default reactivate:false → sidecar not restarted.
    expect(setActiveAccount).not.toHaveBeenCalled()
  })

  it("re-syncs a reused Claude CLI login without rotating its refresh token copy", async () => {
    const linked = anthropicAccount({
      originalSource: "keyring",
    } as Partial<AnthropicCredentialData>)
    const local = refreshedCredential({
      accessToken: "cli-current-access",
      refreshToken: "rt-1",
      originalSource: "keyring",
    } as Partial<AnthropicCredentialData>)
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const persistCredential = jest.fn(
      async (
        _local: string,
        _id: string,
        _old: AnthropicCredentialData,
        _new: AnthropicCredentialData
      ) => {}
    )
    const discoverLocalCredential = jest.fn(async () => local)
    const deps = {
      getAccount: async () => linked,
      persistCredential,
      setActiveAccount: async () => {},
      refreshAccessToken,
      discoverLocalCredential,
      now: () => 42,
    }

    const merged = await refreshAndPersistAnthropicAccount("acc-1", deps)

    expect(merged?.accessToken).toBe("cli-current-access")
    expect(discoverLocalCredential).toHaveBeenCalledTimes(1)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(persistCredential.mock.calls[0][3]).toMatchObject({
      provider: "anthropic",
      accessToken: "cli-current-access",
      originalSource: "keyring",
    })
  })

  it("uses the default CLI discovery adapter for a linked account", async () => {
    const local = refreshedCredential({ originalSource: "keyring", refreshToken: "rt-1" })
    jest
      .mocked(discoverAnthropicAuth)
      .mockResolvedValue({ source: "keyring", credential: {} } as never)
    jest.mocked(discoveredToCredential).mockReturnValue(local)

    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount({ originalSource: "keyring" }),
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential(),
    })

    expect(merged).toMatchObject({ accessToken: "new-access", originalSource: "keyring" })
    expect(discoverAnthropicAuth).toHaveBeenCalledTimes(1)
    expect(discoveredToCredential).toHaveBeenCalledTimes(1)
  })

  it("keeps a file-linked account unchanged when the CLI login is unavailable", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const persistCredential = jest.fn(async () => {})
    const deps = {
      getAccount: async () =>
        anthropicAccount({ originalSource: "file" } as Partial<AnthropicCredentialData>),
      persistCredential,
      setActiveAccount: async () => {},
      refreshAccessToken,
      discoverLocalCredential: async () => null,
    }

    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow(
      "external_login_unavailable"
    )
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(persistCredential).not.toHaveBeenCalled()
  })

  it("re-activates the account only when reactivate is true", async () => {
    const setActiveAccount = jest.fn(async () => {})
    await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      persistCredential: async () => {},
      setActiveAccount,
      refreshAccessToken: async () => refreshedCredential(),
      reactivate: true,
    })
    expect(setActiveAccount).toHaveBeenCalledWith("anthropic", "acc-1")
  })

  it("keeps the richer email/plan when the refresh response omits them", async () => {
    const merged = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => anthropicAccount(),
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential({ email: undefined, plan: undefined }),
    })
    expect(merged?.email).toBe("max@example.com")
    expect(merged?.plan).toBe("max")
  })

  it("returns null (no refresh) when the account is missing", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const out = refreshAndPersistAnthropicAccount("gone", {
      getAccount: async () => null,
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken,
    })
    await expect(out).rejects.toThrow("account_removed")
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
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken: async () => refreshedCredential(),
    })
    expect(out).toBeNull()
  })
})

describe("the token-endpoint block", () => {
  const failing = (error: Error) => ({
    getAccount: async () => anthropicAccount(),
    persistCredential: async () => {},
    setActiveAccount: async () => {},
    refreshAccessToken: jest.fn(async () => {
      throw error
    }),
    now: () => 1_000_000,
    random: () => 0,
  })

  it("does not exchange the same dead token again after a failure", async () => {
    // Single-flight alone only ever stopped SIMULTANEOUS refreshes. The quota
    // loop calls this every five minutes, so without a block a revoked grant
    // was re-POSTed for as long as the app stayed open.
    const deps = failing(new Error("500: token service unavailable"))
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow()
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1)

    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).resolves.toBeNull()
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it("latches a revoked refresh token so it is never retried on its own", async () => {
    const deps = failing(new Error('400: {"error":"invalid_grant"}'))
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow()

    const muchLater = { ...deps, now: () => 1_000_000 + 30 * 24 * 60 * 60_000 }
    await expect(refreshAndPersistAnthropicAccount("acc-1", muchLater)).resolves.toBeNull()
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it("lets the exchange through again once the block expires", async () => {
    const deps = failing(new Error("500: token service unavailable"))
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow()

    const later = { ...deps, now: () => 1_000_000 + 60 * 60_000 }
    await expect(refreshAndPersistAnthropicAccount("acc-1", later)).rejects.toThrow()
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it("keeps accounts independent", async () => {
    const deps = failing(new Error("500: token service unavailable"))
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow()

    const sibling = {
      ...deps,
      getAccount: async () => ({ ...anthropicAccount(), id: "acc-2" }),
    }
    await expect(refreshAndPersistAnthropicAccount("acc-2", sibling)).rejects.toThrow()
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it("clears the block after a successful exchange", async () => {
    const refreshAccessToken = jest
      .fn<Promise<AnthropicCredentialData>, [unknown]>()
      .mockRejectedValueOnce(new Error("500: token service unavailable"))
      .mockResolvedValueOnce(refreshedCredential())
      .mockResolvedValueOnce(refreshedCredential())
    let clock = 1_000_000
    const deps = {
      getAccount: async () => anthropicAccount(),
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken,
      now: () => clock,
      random: () => 0,
    }

    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).rejects.toThrow()
    clock += 60 * 60_000
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).resolves.toMatchObject({
      accessToken: "new-access",
    })
    // The success reset the counter, so the very next call is not gated.
    await expect(refreshAndPersistAnthropicAccount("acc-1", deps)).resolves.toMatchObject({
      accessToken: "new-access",
    })
    expect(refreshAccessToken).toHaveBeenCalledTimes(3)
  })

  it("does not treat a missing account as evidence the endpoint is healthy", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const deps = {
      getAccount: async () => null,
      persistCredential: async () => {},
      setActiveAccount: async () => {},
      refreshAccessToken,
      now: () => 1_000_000,
    }
    await expect(refreshAndPersistAnthropicAccount("missing", deps)).rejects.toThrow(
      "account_removed"
    )
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
})

describe("linked login isolation", () => {
  it("rejects a different CLI login without rotating or saving its tokens", async () => {
    const refreshAccessToken = jest.fn()
    const persistCredential = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getAccount: async () => anthropicAccount({ originalSource: "keyring" }),
        discoverLocalCredential: async () => refreshedCredential({ originalSource: "keyring" }),
        refreshAccessToken,
        persistCredential,
      })
    ).rejects.toThrow("external_login_changed")
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(persistCredential).not.toHaveBeenCalled()
  })
})

describe("refresh persistence boundaries", () => {
  it("fails closed when the vault cannot be read", async () => {
    const persistCredential = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getAccount: async () => {
          throw new Error("vault unavailable")
        },
        persistCredential,
      })
    ).rejects.toThrow("account_unavailable")
    expect(persistCredential).not.toHaveBeenCalled()
  })

  it("classifies a failed exchange after a local account switch as a lifecycle error", async () => {
    let scope = "local-a"
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getLocalAccountId: () => scope,
        getAccount: async () => anthropicAccount(),
        refreshAccessToken: async () => {
          scope = "local-b"
          throw new Error("network unavailable")
        },
      })
    ).rejects.toThrow("local_account_changed")
  })

  it("keeps the rotated token when the local account switches during exchange", async () => {
    let localAccountId = "local-a"
    const persistCredential = jest.fn()
    const setActiveAccount = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getLocalAccountId: () => localAccountId,
        getAccount: async () => anthropicAccount(),
        refreshAccessToken: async () => {
          localAccountId = "local-b"
          return refreshedCredential()
        },
        persistCredential,
        setActiveAccount,
        reactivate: true,
      })
    ).rejects.toThrow("local_account_changed")
    // The server already revoked rt-1: the rotated pair is saved to the local
    // account the refresh belonged to, but nothing is activated after the switch.
    expect(persistCredential).toHaveBeenCalledWith(
      "local-a",
      "acc-1",
      expect.objectContaining({ refreshToken: "rt-1" }),
      expect.objectContaining({ refreshToken: "rt-2", accessToken: "new-access" })
    )
    expect(setActiveAccount).not.toHaveBeenCalled()
  })

  it("adopts a credential another writer rotated while the refresh was in flight", async () => {
    const rotated = anthropicAccount({ accessToken: "watcher-access", refreshToken: "rt-9" })
    const getAccount = jest
      .fn<Promise<Account | null>, [ProviderId, string]>()
      .mockResolvedValueOnce(anthropicAccount())
      .mockResolvedValueOnce(rotated)
    const got = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount,
      refreshAccessToken: async () => refreshedCredential(),
      persistCredential: async () => {
        throw new Error("credential changed while refresh was in flight")
      },
    })
    expect(got).toMatchObject({ accessToken: "watcher-access", refreshToken: "rt-9" })
  })

  it("does not rewrite the vault when a linked login is re-read unchanged", async () => {
    const linked = anthropicAccount({ originalSource: "file" } as Partial<AnthropicCredentialData>)
    const persistCredential = jest.fn()
    const got = await refreshAndPersistAnthropicAccount("acc-1", {
      getAccount: async () => linked,
      discoverLocalCredential: async () => ({
        accessToken: "old-access",
        refreshToken: "rt-1",
        expiresAtMs: 1_000,
        mode: "subscription",
        storedAtMs: 123,
      }),
      persistCredential,
    })
    expect(persistCredential).not.toHaveBeenCalled()
    expect(got).toMatchObject({ accessToken: "old-access", email: "max@example.com" })
  })

  it("never shares an in-flight refresh across local accounts", async () => {
    const refreshAccessToken = jest.fn(async () => refreshedCredential())
    const persistCredential = jest.fn()
    const deps = {
      getAccount: async () => anthropicAccount(),
      refreshAccessToken,
      persistCredential,
    }
    const first = refreshAndPersistAnthropicAccount("acc-1", {
      ...deps,
      getLocalAccountId: () => "local-a",
    })
    const second = refreshAndPersistAnthropicAccount("acc-1", {
      ...deps,
      getLocalAccountId: () => "local-b",
    })
    expect(first).not.toBe(second)
    await Promise.all([first, second])
    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(persistCredential.mock.calls.map(([scope]) => scope)).toEqual(["local-a", "local-b"])
  })

  it("fails closed if the host rejects a deleted or concurrently replaced account", async () => {
    const setActiveAccount = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getAccount: async () => anthropicAccount(),
        refreshAccessToken: async () => refreshedCredential(),
        persistCredential: async () => {
          throw new Error("credential changed")
        },
        setActiveAccount,
        reactivate: true,
      })
    ).rejects.toThrow("credential_update_rejected")
    expect(setActiveAccount).not.toHaveBeenCalled()
  })

  it("does not access credentials while the local account is locked", async () => {
    const getAccount = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getLocalAccountId: () => null,
        getAccount,
      })
    ).rejects.toThrow("local_account_locked")
    expect(getAccount).not.toHaveBeenCalled()
  })

  it("reports discovery failures without falling back to a cached login", async () => {
    const persistCredential = jest.fn()
    await expect(
      refreshAndPersistAnthropicAccount("acc-1", {
        getAccount: async () => anthropicAccount({ originalSource: "file" }),
        discoverLocalCredential: async () => {
          throw new Error("keyring unavailable")
        },
        persistCredential,
      })
    ).rejects.toThrow("external_login_unavailable")
    expect(persistCredential).not.toHaveBeenCalled()
  })
})
