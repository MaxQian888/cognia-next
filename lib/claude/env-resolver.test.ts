// ADR-0028 — env-resolver unit tests. The transport layer is mocked so the
// tests run without a real Tauri host.

import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "./env-resolver"
import type { AppSettings, Character, ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
  },
}))

let standaloneRuntime = false
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standaloneRuntime,
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
  standaloneRuntime = false
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
    expect(resolveAccountId("anthropic", chatSession(), character(), settings())).toBeNull()
  })

  it("returns session.accountId when set", () => {
    expect(
      resolveAccountId(
        "anthropic",
        chatSession({ accountId: "s-acct" }),
        character({ accountIdOverride: "c-acct" }),
        settings({ defaultAccountId: "app-acct" })
      )
    ).toBe("s-acct")
  })

  it("falls through to character.accountIdOverride when session is unset", () => {
    expect(
      resolveAccountId(
        "anthropic",
        chatSession(),
        character({ accountIdOverride: "c-acct" }),
        settings({ defaultAccountId: "app-acct" })
      )
    ).toBe("c-acct")
  })

  it("uses the default account scoped to the current provider", () => {
    expect(
      resolveAccountId(
        "codex",
        chatSession(),
        character(),
        settings({ defaultAccountIds: { anthropic: "claude-acct", codex: "codex-acct" } })
      )
    ).toBe("codex-acct")
  })

  it("reads the legacy default only when defaultProvider matches", () => {
    const legacy = settings({ defaultProvider: "anthropic", defaultAccountId: "legacy" })
    expect(resolveAccountId("anthropic", chatSession(), character(), legacy)).toBe("legacy")
    expect(resolveAccountId("codex", chatSession(), character(), legacy)).toBeNull()
  })

  it("treats the legacy OpenCode default as scoped for the Go runtime", () => {
    const legacy = settings({ defaultProvider: "opencode", defaultAccountId: "legacy-go" })
    expect(resolveAccountId("opencode-go", chatSession(), character(), legacy)).toBe("legacy-go")
  })

  it("tolerates null/undefined inputs", () => {
    expect(resolveAccountId("anthropic", null, null, null)).toBeNull()
    expect(resolveAccountId("anthropic", undefined, undefined, undefined)).toBeNull()
  })
})

describe("resolveAccountEnv", () => {
  it("does not call a host-only command in browser standalone mode", async () => {
    standaloneRuntime = true

    await expect(resolveAccountEnv("anthropic", "abc")).resolves.toEqual({})
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("uses the validated provider active account when no override/default is selected", async () => {
    mockCall.mockResolvedValueOnce({
      activeAccountId: "active-account",
      env: [["CLAUDE_CODE_OAUTH_TOKEN", "active-token"]],
    })

    await expect(resolveAccountEnv("anthropic", null)).resolves.toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "active-token",
    })
    expect(mockCall).toHaveBeenCalledWith("subscription_get_active", {
      provider: "anthropic",
      localAccountId: "local_acct_a",
    })
  })

  it("fails actionably when the provider has no active account", async () => {
    mockCall.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })

    await expect(resolveAccountEnv("anthropic", null)).rejects.toMatchObject({
      name: "SubscriptionAccountResolutionError",
      providerId: "anthropic",
      accountId: "",
    })
  })

  it("ignores account routing for non-subscription providers", async () => {
    await expect(resolveAccountEnv("openai", null)).resolves.toEqual({})
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("forwards provider + accountId via transport.call and returns the merged record", async () => {
    mockCall.mockResolvedValueOnce([
      { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "oat-01" },
      { key: "CLAUDE_CONFIG_DIR", value: "/tmp/configs/abc" },
      { key: "ANTHROPIC_BASE_URL", value: "https://example.com" },
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

  it("rejects an explicit account when no local account is unlocked", async () => {
    unlockedAccountId = null

    await expect(resolveAccountEnv("anthropic", "abc")).rejects.toMatchObject({
      name: "SubscriptionAccountResolutionError",
      accountId: "abc",
    })

    expect(mockCall).not.toHaveBeenCalled()
  })

  it("rejects an unknown explicit account instead of falling through", async () => {
    mockCall.mockResolvedValueOnce(null)
    await expect(resolveAccountEnv("anthropic", "ghost")).rejects.toMatchObject({
      name: "SubscriptionAccountResolutionError",
      providerId: "anthropic",
      accountId: "ghost",
    })
  })

  it("wraps vault failures instead of silently using a different credential", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    mockCall.mockRejectedValueOnce(new Error("vault load failed"))
    await expect(resolveAccountEnv("anthropic", "abc")).rejects.toMatchObject({
      name: "SubscriptionAccountResolutionError",
      cause: expect.any(Error),
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("resolveProxyEnv", () => {
  it("never lets renderer session data override the host proxy environment", async () => {
    await expect(resolveProxyEnv("session-x")).resolves.toEqual({})
    await expect(resolveProxyEnv(undefined)).resolves.toEqual({})
    expect(mockCall).not.toHaveBeenCalled()
  })
})
