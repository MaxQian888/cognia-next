import { transport } from "@/lib/tauri"

import { discoverCodexAuth, discoveredToCredential, toCodexProviderCredential } from "./discovery"
import type { DiscoveredCodexAuth } from "./discovery"

const chatgptDiscovered: DiscoveredCodexAuth = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ChatGPT",
  openaiApiKey: undefined,
  tokens: {
    accessToken: "oat-discovered",
    refreshToken: "rt-discovered",
    idTokenRaw: "eyJ.fake.jwt",
    accountId: "acct_def",
    email: "user@example.com",
    chatgptPlanType: "Plus",
    chatgptUserId: "user_abc",
    chatgptAccountId: "acct_def",
  },
  lastRefreshIso: "2026-05-10T01:23:45Z",
}

const apiKeyDiscovered: DiscoveredCodexAuth = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ApiKey",
  openaiApiKey: "sk-test-1234",
  tokens: undefined,
  lastRefreshIso: undefined,
}

beforeEach(() => {
  jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("discoverCodexAuth", () => {
  it("forwards through codex_oauth_discover", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(chatgptDiscovered)
    const got = await discoverCodexAuth()
    expect(transport.call).toHaveBeenCalledWith("codex_oauth_discover")
    expect(got).toEqual(chatgptDiscovered)
  })

  it("normalises undefined into null", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce(undefined)
    expect(await discoverCodexAuth()).toBeNull()
  })

  it("propagates parse errors from Rust", async () => {
    ;(transport.call as jest.Mock).mockRejectedValueOnce("parse keyring 'Codex Auth' payload: bad")
    await expect(discoverCodexAuth()).rejects.toBe("parse keyring 'Codex Auth' payload: bad")
  })
})

describe("discoveredToCredential", () => {
  const now = 1_700_000_000_000

  it("maps ChatGPT discovery onto a chatgpt credential", () => {
    const got = discoveredToCredential(chatgptDiscovered, now)
    expect(got).toEqual({
      accessToken: "oat-discovered",
      refreshToken: "rt-discovered",
      idTokenRaw: "eyJ.fake.jwt",
      expiresAtMs: 0,
      authMode: "chatgpt",
      email: "user@example.com",
      chatgptPlanType: "Plus",
      chatgptUserId: "user_abc",
      accountId: "acct_def",
      originalSource: "file",
      storedAtMs: now,
    })
  })

  it("prefers account_id over chatgpt_account_id when both are present", () => {
    const got = discoveredToCredential(
      {
        ...chatgptDiscovered,
        tokens: {
          ...chatgptDiscovered.tokens!,
          accountId: "acct_pref",
          chatgptAccountId: "acct_fallback",
        },
      },
      now
    )
    expect(got?.accountId).toBe("acct_pref")
  })

  it("falls back to chatgpt_account_id when account_id is missing", () => {
    const got = discoveredToCredential(
      {
        ...chatgptDiscovered,
        tokens: {
          ...chatgptDiscovered.tokens!,
          accountId: undefined,
          chatgptAccountId: "acct_fallback",
        },
      },
      now
    )
    expect(got?.accountId).toBe("acct_fallback")
  })

  it("maps ApiKey discovery onto an api_key credential", () => {
    const got = discoveredToCredential(apiKeyDiscovered, now)
    expect(got).toEqual({
      accessToken: "sk-test-1234",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "api_key",
      originalSource: "file",
      storedAtMs: now,
    })
  })

  it("returns null when neither tokens.accessToken nor openaiApiKey is present", () => {
    const empty: DiscoveredCodexAuth = {
      source: "file",
      authJsonPath: "/p",
      tokens: undefined,
      openaiApiKey: undefined,
    }
    expect(discoveredToCredential(empty)).toBeNull()
  })

  it("treats empty-string tokens.accessToken as missing", () => {
    const got = discoveredToCredential({
      ...chatgptDiscovered,
      tokens: { ...chatgptDiscovered.tokens!, accessToken: "" },
      openaiApiKey: "sk-fallback",
    })
    expect(got?.authMode).toBe("api_key")
    expect(got?.accessToken).toBe("sk-fallback")
  })

  it("inherits the discovered source onto originalSource", () => {
    const keyringSourced: DiscoveredCodexAuth = {
      ...chatgptDiscovered,
      source: "keyring",
    }
    expect(discoveredToCredential(keyringSourced, now)?.originalSource).toBe("keyring")
  })
})

describe("toCodexProviderCredential", () => {
  it("tags a CodexCredentialData with provider='codex'", () => {
    const data = discoveredToCredential(chatgptDiscovered, 0)!
    const tagged = toCodexProviderCredential(data)
    expect(tagged.provider).toBe("codex")
    expect(tagged).toMatchObject(data)
  })
})
