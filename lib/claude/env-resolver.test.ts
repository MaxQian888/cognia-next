// ADR-0028 — env-resolver unit tests. The transport layer is mocked so the
// tests run without a real Tauri host.

import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "./env-resolver"
import type { AppSettings, Character, ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
  },
}))

let unlockedAccountId: string | null = "local_acct_a"

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: {
    getState: () => ({ unlockedAccountId }),
  },
}))

import { transport } from "@/lib/tauri"

const mockCall = transport.call as jest.MockedFunction<typeof transport.call>

beforeEach(() => {
  mockCall.mockReset()
  unlockedAccountId = "local_acct_a"
})

// Minimal-shape factories — only the fields the resolver reads. The full
// ChatSession / Character / AppSettings interfaces carry many other fields
// our resolver does not touch, so casting via `Partial<…> as …` keeps the
// fixtures terse without losing type safety on the field paths under test.
function chatSession(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s",
    title: "test",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as ChatSession
}

function character(over: Partial<Character> = {}): Character {
  return {
    id: "c",
    name: "test",
    avatarColor: "oklch(0 0 0)",
    systemPrompt: "",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Character
}

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    alwaysAllowTools: [],
    builtinTools: {
      fileExtras: true,
      git: true,
      process: false,
      environment: true,
      shellAdvanced: false,
    },
    ...over,
  } as AppSettings
}

describe("resolveAccountId — precedence chain", () => {
  it("returns null when no layer sets it", () => {
    expect(resolveAccountId(chatSession(), character(), settings())).toBeNull()
  })

  it("returns session.accountId when set", () => {
    expect(
      resolveAccountId(
        chatSession({ accountId: "s-acct" }),
        character({ accountIdOverride: "c-acct" }),
        settings({ defaultAccountId: "app-acct" })
      )
    ).toBe("s-acct")
  })

  it("falls through to character.accountIdOverride when session is unset", () => {
    expect(
      resolveAccountId(
        chatSession(),
        character({ accountIdOverride: "c-acct" }),
        settings({ defaultAccountId: "app-acct" })
      )
    ).toBe("c-acct")
  })

  it("falls through to settings.defaultAccountId when both upper layers are unset", () => {
    expect(
      resolveAccountId(chatSession(), character(), settings({ defaultAccountId: "app-acct" }))
    ).toBe("app-acct")
  })

  it("tolerates null/undefined inputs", () => {
    expect(resolveAccountId(null, null, null)).toBeNull()
    expect(resolveAccountId(undefined, undefined, undefined)).toBeNull()
  })
})

describe("resolveAccountEnv", () => {
  it("returns {} when accountId is null without calling the transport", async () => {
    const env = await resolveAccountEnv("anthropic", null)
    expect(env).toEqual({})
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("forwards provider + accountId via transport.call and returns the merged record", async () => {
    mockCall.mockResolvedValueOnce([
      ["CLAUDE_CODE_OAUTH_TOKEN", "oat-01"],
      ["CLAUDE_CONFIG_DIR", "/tmp/configs/abc"],
      ["ANTHROPIC_BASE_URL", "https://example.com"],
    ])
    const env = await resolveAccountEnv("anthropic", "abc")
    expect(mockCall).toHaveBeenCalledWith("claude_env_for_account", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
      accountId: "abc",
    })
    expect(env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-01",
      CLAUDE_CONFIG_DIR: "/tmp/configs/abc",
      ANTHROPIC_BASE_URL: "https://example.com",
    })
  })

  it("returns {} without calling Rust when no local account is unlocked", async () => {
    unlockedAccountId = null

    const env = await resolveAccountEnv("anthropic", "abc")

    expect(env).toEqual({})
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("returns {} when transport returns null (unknown account)", async () => {
    mockCall.mockResolvedValueOnce(null)
    const env = await resolveAccountEnv("anthropic", "ghost")
    expect(env).toEqual({})
  })

  it("returns {} on transport rejection — best-effort, never blocks send", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    mockCall.mockRejectedValueOnce(new Error("vault load failed"))
    const env = await resolveAccountEnv("anthropic", "abc")
    expect(env).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("resolveProxyEnv", () => {
  it("returns parsed pairs when proxy is active", async () => {
    mockCall.mockResolvedValueOnce([
      ["HTTPS_PROXY", "http://proxy:8080"],
      ["HTTP_PROXY", "http://proxy:8080"],
    ])
    const env = await resolveProxyEnv("session-x")
    expect(mockCall).toHaveBeenCalledWith("claude_proxy_env_for_session", {
      sessionId: "session-x",
    })
    expect(env).toEqual({
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
    })
  })

  it("handles missing sessionId by passing empty string forward", async () => {
    mockCall.mockResolvedValueOnce([])
    await resolveProxyEnv(undefined)
    expect(mockCall).toHaveBeenCalledWith("claude_proxy_env_for_session", {
      sessionId: "",
    })
  })

  it("returns {} when proxy is inactive (transport gives empty array)", async () => {
    mockCall.mockResolvedValueOnce([])
    const env = await resolveProxyEnv("session-x")
    expect(env).toEqual({})
  })

  it("returns {} on transport rejection — best-effort", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    mockCall.mockRejectedValueOnce(new Error("proxy_config crash"))
    const env = await resolveProxyEnv("session-x")
    expect(env).toEqual({})
    warn.mockRestore()
  })
})
