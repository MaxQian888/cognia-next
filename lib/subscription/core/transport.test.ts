import {
  anthropicOauthSavePkceResult,
  codexOauthDiscover,
  codexOauthPollDeviceCode,
  codexOauthRefresh,
  codexOauthRequestDeviceCode,
  codexOauthRevoke,
  clearSubscriptionRuntime,
  deleteAccount,
  deleteProviderPreset,
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listPresets,
  listAccounts,
  opencodeOauthDiscover,
  opencodeSaveZenKey,
  renameAccount,
  saveProviderPreset,
  saveAccount,
  setActiveAccount,
  setDefaultPreset,
  setProviderPreset,
  subscriptionInit,
  authedGet,
  authedRequest,
} from "./transport"
import type { Account, AnthropicCredentialData } from "@/types/subscription"
import { __resetVaultChangeTrackerForTesting } from "@/lib/subscription/sync/change-tracker"
import { subscribeSubscriptionChanged } from "./subscription-events"

jest.mock("@/lib/tauri", () => {
  return {
    transport: {
      call: jest.fn(),
    },
  }
})

const mockAccountStoreState: { unlockedAccountId: string | null } = {
  unlockedAccountId: "local_acct_a",
}

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: {
    getState: () => mockAccountStoreState,
  },
}))

// Pulled out for type inference; jest.mock above does the wiring.
import { transport } from "@/lib/tauri"
const mockedCall = transport.call as jest.MockedFunction<typeof transport.call>

afterEach(() => {
  __resetVaultChangeTrackerForTesting()
  mockedCall.mockReset()
  mockAccountStoreState.unlockedAccountId = "local_acct_a"
})

function anthropicData(): AnthropicCredentialData {
  return {
    accessToken: "oat",
    refreshToken: "rt",
    expiresAtMs: 1_800_000_000_000,
    mode: "subscription",
    storedAtMs: 1_700_000_000_000,
  }
}

function sampleAccount(): Account {
  return {
    id: "0193c2b0-0000-7000-8000-000000000001",
    label: "Test",
    credential: { provider: "anthropic", ...anthropicData() },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  }
}

describe("subscription core transport", () => {
  it("subscriptionInit dispatches subscription_init with no args", async () => {
    mockedCall.mockResolvedValueOnce([])
    await subscriptionInit()
    expect(mockedCall).toHaveBeenCalledWith("subscription_init", {
      localAccountId: "local_acct_a",
    })
  })

  it("listAccounts forwards provider and local account", async () => {
    mockedCall.mockResolvedValueOnce([])
    await listAccounts("anthropic")
    expect(mockedCall).toHaveBeenCalledWith("subscription_list_accounts", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
    })
  })

  it("rejects vault access when no local account is unlocked", async () => {
    mockAccountStoreState.unlockedAccountId = null
    await expect(listAccounts("anthropic")).rejects.toThrow(/local account must be unlocked/i)
    expect(mockedCall).not.toHaveBeenCalled()
  })

  it("getAccount returns null when transport returns undefined", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    const result = await getAccount("anthropic", "id-1")
    expect(result).toBeNull()
    expect(mockedCall).toHaveBeenCalledWith("subscription_get_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: "id-1",
    })
  })

  it("saveAccount forwards both args", async () => {
    const changed = jest.fn()
    const unsubscribe = subscribeSubscriptionChanged(changed)
    mockedCall.mockResolvedValueOnce(undefined)
    const account = sampleAccount()
    await saveAccount("anthropic", account)
    expect(mockedCall).toHaveBeenCalledWith("subscription_save_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      account,
    })
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("deleteAccount forwards provider + accountId", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await deleteAccount("codex", "id-2")
    expect(mockedCall).toHaveBeenCalledWith("subscription_delete_account", {
      provider: "codex",
      localAccountId: "local_acct_a",
      accountId: "id-2",
      replacementAccountId: null,
    })
  })

  it("deleteAccount forwards the selected replacement", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await deleteAccount("anthropic", "old", "replacement")
    expect(mockedCall).toHaveBeenCalledWith("subscription_delete_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: "old",
      replacementAccountId: "replacement",
    })
  })

  it("clearSubscriptionRuntime uses the explicit local-account scope", async () => {
    const changed = jest.fn()
    const unsubscribe = subscribeSubscriptionChanged(changed)
    mockedCall.mockResolvedValueOnce(undefined)
    await clearSubscriptionRuntime("local_acct_previous")
    expect(mockedCall).toHaveBeenCalledWith("subscription_clear_runtime", {
      localAccountId: "local_acct_previous",
    })
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("renameAccount carries the label (including null to clear)", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await renameAccount("anthropic", "id-1", "Work")
    expect(mockedCall).toHaveBeenCalledWith("subscription_rename_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: "id-1",
      label: "Work",
    })
    mockedCall.mockResolvedValueOnce(undefined)
    await renameAccount("anthropic", "id-1", null)
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_rename_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: "id-1",
      label: null,
    })
  })

  it("setActiveAccount forwards null to clear", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await setActiveAccount("anthropic", null)
    expect(mockedCall).toHaveBeenCalledWith("subscription_set_active", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: null,
    })
  })

  it("getActiveAccount returns the ActiveSnapshot", async () => {
    mockedCall.mockResolvedValueOnce({ activeAccountId: "id-1", env: [] })
    const got = await getActiveAccount("anthropic")
    expect(got.activeAccountId).toBe("id-1")
    expect(got.env).toEqual([])
    expect(mockedCall).toHaveBeenCalledWith("subscription_get_active", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
    })
  })

  it("preset get returns null when Rust returns undefined", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    expect(await getProviderPreset("anthropic")).toBeNull()
  })

  it("preset set forwards null to clear", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await setProviderPreset("anthropic", null)
    expect(mockedCall).toHaveBeenCalledWith("subscription_set_preset", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      preset: null,
    })
  })

  it("preset library helpers forward the active local account scope", async () => {
    const preset = {
      id: "fast",
      label: "Fast",
      baseUrl: "https://api.example.test",
      extraHeaders: { "X-Test": "1" },
    }
    mockedCall.mockResolvedValueOnce([preset])
    await expect(listPresets("anthropic")).resolves.toEqual([preset])
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_list_presets", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
    })

    mockedCall.mockResolvedValueOnce(undefined)
    await saveProviderPreset("anthropic", preset)
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_save_preset", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      preset,
    })

    mockedCall.mockResolvedValueOnce(undefined)
    await deleteProviderPreset("anthropic", "fast")
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_delete_preset", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      presetId: "fast",
    })

    mockedCall.mockResolvedValueOnce(undefined)
    await setDefaultPreset("anthropic", null)
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_set_default_preset", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      presetId: null,
    })
  })

  it("authedGet serializes headers as named entries", async () => {
    mockedCall.mockResolvedValueOnce('{"ok":true}')
    await expect(
      authedGet("https://example.test/balance", { Authorization: "Bearer x" })
    ).resolves.toBe('{"ok":true}')
    expect(mockedCall).toHaveBeenCalledWith("subscription_authed_get", {
      url: "https://example.test/balance",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    })
  })

  it("authedRequest preserves upstream status, headers, and body", async () => {
    const response = {
      status: 429,
      headers: [{ name: "retry-after", value: "60" }],
      body: '{"error":"rate limited"}',
    }
    mockedCall.mockResolvedValueOnce(response)

    await expect(
      authedRequest({
        url: "https://example.test/balance",
        method: "POST",
        headers: { Authorization: "Bearer x" },
        body: "{}",
        timeoutMs: 15_000,
      })
    ).resolves.toEqual(response)
    expect(mockedCall).toHaveBeenCalledWith("subscription_authed_request", {
      request: {
        url: "https://example.test/balance",
        method: "POST",
        headers: [{ name: "Authorization", value: "Bearer x" }],
        body: "{}",
        timeoutMs: 15_000,
        maxBodyBytes: 1_048_576,
      },
    })
  })

  it("anthropicOauthSavePkceResult dispatches the right command + label", async () => {
    const changed = jest.fn()
    const unsubscribe = subscribeSubscriptionChanged(changed)
    mockedCall.mockResolvedValueOnce(sampleAccount())
    const data = anthropicData()
    await anthropicOauthSavePkceResult(data, "My Alias")
    expect(mockedCall).toHaveBeenCalledWith("anthropic_oauth_save_pkce_result", {
      localAccountId: "local_acct_a",
      payload: data,
      label: "My Alias",
    })
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("anthropicOauthSavePkceResult defaults label to null", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await anthropicOauthSavePkceResult(anthropicData())
    expect(mockedCall).toHaveBeenLastCalledWith(
      "anthropic_oauth_save_pkce_result",
      expect.objectContaining({ label: null, localAccountId: "local_acct_a" })
    )
  })

  it.each([
    ["codexOauthDiscover", "codex_oauth_discover", () => codexOauthDiscover()],
    [
      "codexOauthRequestDeviceCode",
      "codex_oauth_request_device_code",
      () => codexOauthRequestDeviceCode(),
    ],
    [
      "codexOauthPollDeviceCode",
      "codex_oauth_poll_device_code",
      () => codexOauthPollDeviceCode("dc-1", "CODE-1"),
    ],
    ["codexOauthRefresh", "codex_oauth_refresh", () => codexOauthRefresh("rt-1")],
    ["codexOauthRevoke", "codex_oauth_revoke", () => codexOauthRevoke("tok")],
  ])("%s invokes %s", async (_label, command, runner) => {
    mockedCall.mockResolvedValueOnce(undefined)
    await runner()
    // Some commands take a payload (poll/refresh/revoke), others are arg-less
    // (discover, request_device_code). Just check the first arg matches.
    expect(mockedCall.mock.calls[0][0]).toBe(command)
  })

  it("codexOauthPollDeviceCode forwards device_auth_id + user_code", async () => {
    mockedCall.mockResolvedValueOnce({ Pending: { error: "authorization_pending" } })
    await codexOauthPollDeviceCode("device-code-x", "CODE-9")
    expect(mockedCall).toHaveBeenCalledWith("codex_oauth_poll_device_code", {
      localAccountId: "local_acct_a",
      deviceCode: "device-code-x",
      userCode: "CODE-9",
    })
  })

  it("opencodeOauthDiscover returns null on undefined", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    expect(await opencodeOauthDiscover()).toBeNull()
  })

  it("opencodeSaveZenKey passes accessToken/baseUrl/label/plan", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await opencodeSaveZenKey("ozk-1", "https://zen.opencode.ai", "Personal Zen", "go")
    expect(mockedCall).toHaveBeenCalledWith("opencode_save_zen_key", {
      localAccountId: "local_acct_a",
      accessToken: "ozk-1",
      baseUrl: "https://zen.opencode.ai",
      label: "Personal Zen",
      plan: "go",
    })
  })

  it("opencodeSaveZenKey accepts null baseUrl and defaults label/plan to null", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await opencodeSaveZenKey("ozk-2", null)
    expect(mockedCall).toHaveBeenLastCalledWith("opencode_save_zen_key", {
      localAccountId: "local_acct_a",
      accessToken: "ozk-2",
      baseUrl: null,
      label: null,
      plan: null,
    })
  })
})
