import {
  anthropicOauthSavePkceResult,
  codexOauthDiscover,
  codexOauthPollDeviceCode,
  codexOauthRefresh,
  codexOauthRequestDeviceCode,
  codexOauthRevoke,
  deleteAccount,
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  opencodeOauthDiscover,
  opencodeSaveZenKey,
  renameAccount,
  saveAccount,
  setActiveAccount,
  setProviderPreset,
  subscriptionInit,
} from "./transport"
import type { Account, AnthropicCredentialData } from "./types"

jest.mock("@/lib/tauri", () => {
  return {
    transport: {
      call: jest.fn(),
    },
  }
})

// Pulled out for type inference; jest.mock above does the wiring.
import { transport } from "@/lib/tauri"
const mockedCall = transport.call as jest.MockedFunction<typeof transport.call>

afterEach(() => {
  mockedCall.mockReset()
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
    expect(mockedCall).toHaveBeenCalledWith("subscription_init")
  })

  it("listAccounts forwards provider", async () => {
    mockedCall.mockResolvedValueOnce([])
    await listAccounts("anthropic")
    expect(mockedCall).toHaveBeenCalledWith("subscription_list_accounts", {
      provider: "anthropic",
    })
  })

  it("getAccount returns null when transport returns undefined", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    const result = await getAccount("anthropic", "id-1")
    expect(result).toBeNull()
    expect(mockedCall).toHaveBeenCalledWith("subscription_get_account", {
      provider: "anthropic",
      accountId: "id-1",
    })
  })

  it("saveAccount forwards both args", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    const account = sampleAccount()
    await saveAccount("anthropic", account)
    expect(mockedCall).toHaveBeenCalledWith("subscription_save_account", {
      provider: "anthropic",
      account,
    })
  })

  it("deleteAccount forwards provider + accountId", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await deleteAccount("codex", "id-2")
    expect(mockedCall).toHaveBeenCalledWith("subscription_delete_account", {
      provider: "codex",
      accountId: "id-2",
    })
  })

  it("renameAccount carries the label (including null to clear)", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await renameAccount("anthropic", "id-1", "Work")
    expect(mockedCall).toHaveBeenCalledWith("subscription_rename_account", {
      provider: "anthropic",
      accountId: "id-1",
      label: "Work",
    })
    mockedCall.mockResolvedValueOnce(undefined)
    await renameAccount("anthropic", "id-1", null)
    expect(mockedCall).toHaveBeenLastCalledWith("subscription_rename_account", {
      provider: "anthropic",
      accountId: "id-1",
      label: null,
    })
  })

  it("setActiveAccount forwards null to clear", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    await setActiveAccount("anthropic", null)
    expect(mockedCall).toHaveBeenCalledWith("subscription_set_active", {
      provider: "anthropic",
      accountId: null,
    })
  })

  it("getActiveAccount returns the ActiveSnapshot", async () => {
    mockedCall.mockResolvedValueOnce({ activeAccountId: "id-1", env: [] })
    const got = await getActiveAccount("anthropic")
    expect(got.activeAccountId).toBe("id-1")
    expect(got.env).toEqual([])
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
      preset: null,
    })
  })

  it("anthropicOauthSavePkceResult dispatches the right command + label", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    const data = anthropicData()
    await anthropicOauthSavePkceResult(data, "My Alias")
    expect(mockedCall).toHaveBeenCalledWith("anthropic_oauth_save_pkce_result", {
      payload: data,
      label: "My Alias",
    })
  })

  it("anthropicOauthSavePkceResult defaults label to null", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await anthropicOauthSavePkceResult(anthropicData())
    expect(mockedCall).toHaveBeenLastCalledWith(
      "anthropic_oauth_save_pkce_result",
      expect.objectContaining({ label: null })
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
      () => codexOauthPollDeviceCode("dc-1"),
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

  it("codexOauthPollDeviceCode forwards camelCase deviceCode", async () => {
    mockedCall.mockResolvedValueOnce({ Pending: { error: "authorization_pending" } })
    await codexOauthPollDeviceCode("device-code-x")
    expect(mockedCall).toHaveBeenCalledWith("codex_oauth_poll_device_code", {
      deviceCode: "device-code-x",
    })
  })

  it("opencodeOauthDiscover returns null on undefined", async () => {
    mockedCall.mockResolvedValueOnce(undefined)
    expect(await opencodeOauthDiscover()).toBeNull()
  })

  it("opencodeSaveZenKey passes accessToken/baseUrl/label", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await opencodeSaveZenKey("ozk-1", "https://zen.opencode.ai", "Personal Zen")
    expect(mockedCall).toHaveBeenCalledWith("opencode_save_zen_key", {
      accessToken: "ozk-1",
      baseUrl: "https://zen.opencode.ai",
      label: "Personal Zen",
    })
  })

  it("opencodeSaveZenKey accepts null baseUrl and defaults label to null", async () => {
    mockedCall.mockResolvedValueOnce(sampleAccount())
    await opencodeSaveZenKey("ozk-2", null)
    expect(mockedCall).toHaveBeenLastCalledWith("opencode_save_zen_key", {
      accessToken: "ozk-2",
      baseUrl: null,
      label: null,
    })
  })
})
