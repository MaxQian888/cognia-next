/** @jest-environment jsdom */

// Unit tests for the Anthropic (Claude Code CLI) discovery wrapper — the
// E2E window hook, the adopt translation rules, and the adopt/activate chain.
// jsdom env: the E2E override branch needs a real `window`.

import {
  adoptAndActivateDiscoveredAuth,
  adoptDiscoveredAuth,
  discoverAnthropicAuth,
  discoveredToCredential,
  type DiscoveredAnthropicAuth,
} from "./discovery"
import {
  anthropicOauthDiscover,
  anthropicOauthSavePkceResult,
  setActiveAccount,
} from "../core/transport"
import type { Account } from "@/types/subscription"

jest.mock("../core/transport", () => ({
  anthropicOauthDiscover: jest.fn(),
  anthropicOauthSavePkceResult: jest.fn(),
  setActiveAccount: jest.fn(),
}))

const discoverMock = anthropicOauthDiscover as jest.Mock
const saveMock = anthropicOauthSavePkceResult as jest.Mock
const setActiveMock = setActiveAccount as jest.Mock

function sample(overrides: Partial<DiscoveredAnthropicAuth> = {}): DiscoveredAnthropicAuth {
  return {
    source: "keyring",
    credentialsPath: "/home/u/.claude/.credentials.json",
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAtMs: 1_783_590_329_176,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    ...overrides,
  }
}

function sampleAccount(): Account {
  return {
    id: "acct-1",
    credential: { provider: "anthropic", ...discoveredToCredential(sample())! },
    createdAtMs: 1,
    lastUsedAtMs: 1,
  }
}

afterEach(() => {
  jest.clearAllMocks()
  delete (window as { __cogniaE2EAnthropicDiscovery?: unknown }).__cogniaE2EAnthropicDiscovery
})

describe("discoverAnthropicAuth", () => {
  it("delegates to the Rust command", async () => {
    discoverMock.mockResolvedValue(sample())
    const got = await discoverAnthropicAuth()
    expect(got?.accessToken).toBe("sk-ant-oat01-test")
    expect(discoverMock).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent native probes but allows a later rescan", async () => {
    let resolveProbe!: (value: DiscoveredAnthropicAuth | null) => void
    discoverMock.mockReturnValueOnce(
      new Promise<DiscoveredAnthropicAuth | null>((resolve) => {
        resolveProbe = resolve
      })
    )

    const first = discoverAnthropicAuth()
    const second = discoverAnthropicAuth()

    expect(discoverMock).toHaveBeenCalledTimes(1)
    resolveProbe(sample())
    await expect(Promise.all([first, second])).resolves.toEqual([sample(), sample()])

    discoverMock.mockResolvedValueOnce(sample({ subscriptionType: "pro" }))
    await expect(discoverAnthropicAuth()).resolves.toMatchObject({ subscriptionType: "pro" })
    expect(discoverMock).toHaveBeenCalledTimes(2)
  })

  it("honours the E2E window override, including explicit null", async () => {
    const w = window as { __cogniaE2EAnthropicDiscovery?: DiscoveredAnthropicAuth | null }
    w.__cogniaE2EAnthropicDiscovery = null
    expect(await discoverAnthropicAuth()).toBeNull()
    expect(discoverMock).not.toHaveBeenCalled()

    w.__cogniaE2EAnthropicDiscovery = sample({ subscriptionType: "pro" })
    const got = await discoverAnthropicAuth()
    expect(got?.subscriptionType).toBe("pro")
    expect(discoverMock).not.toHaveBeenCalled()
  })
})

describe("discoveredToCredential", () => {
  it("maps fields into a subscription-mode credential", () => {
    const cred = discoveredToCredential(sample(), 42)
    expect(cred).toEqual({
      accessToken: "sk-ant-oat01-test",
      refreshToken: "sk-ant-ort01-test",
      expiresAtMs: 1_783_590_329_176,
      mode: "subscription",
      scope: "user:inference user:profile",
      plan: "max",
      originalSource: "keyring",
      storedAtMs: 42,
    })
  })

  it("omits scope when the scope list is empty", () => {
    const cred = discoveredToCredential(sample({ scopes: [] }), 42)
    expect(cred?.scope).toBeUndefined()
  })

  it("returns null when a token is blank", () => {
    expect(discoveredToCredential(sample({ accessToken: "  " }))).toBeNull()
    expect(discoveredToCredential(sample({ refreshToken: "" }))).toBeNull()
  })
})

describe("adoptDiscoveredAuth", () => {
  it("persists through the PKCE save hook with the given label", async () => {
    const account = sampleAccount()
    saveMock.mockResolvedValue(account)
    const got = await adoptDiscoveredAuth(sample(), "My CLI login")
    expect(got).toBe(account)
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription", plan: "max" }),
      "My CLI login"
    )
  })

  it("rejects an unusable payload instead of persisting", async () => {
    await expect(adoptDiscoveredAuth(sample({ refreshToken: "" }))).rejects.toThrow(
      /missing a token pair/
    )
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe("adoptAndActivateDiscoveredAuth", () => {
  it("adopts then activates the new account", async () => {
    const account = sampleAccount()
    saveMock.mockResolvedValue(account)
    setActiveMock.mockResolvedValue(undefined)
    const got = await adoptAndActivateDiscoveredAuth(sample())
    expect(got).toBe(account)
    expect(setActiveMock).toHaveBeenCalledWith("anthropic", "acct-1")
  })

  it("does not activate when adoption fails", async () => {
    saveMock.mockRejectedValue(new Error("vault down"))
    await expect(adoptAndActivateDiscoveredAuth(sample())).rejects.toThrow("vault down")
    expect(setActiveMock).not.toHaveBeenCalled()
  })
})
