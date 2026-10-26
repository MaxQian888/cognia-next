jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
import { getSettings } from "@/lib/db/settings"
import { detectActive } from "./active-provider"
import type { CcswitchProvider } from "@/types/ccswitch"
const mGet = getSettings as jest.Mock
beforeEach(() => jest.resetAllMocks())

function provider(overrides: Partial<CcswitchProvider>): CcswitchProvider {
  return {
    id: "p1",
    kind: "claude",
    name: "Anthropic Official",
    apiKey: "sk-ant-x",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  }
}

describe("detectActive", () => {
  it("matches cognia by (apiKey, baseUrl) tuple", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "sk-ant-x",
      apiBaseUrl: "https://api.anthropic.com",
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const providers = [provider({ id: "a" }), provider({ id: "b", apiKey: "other" })]
    const state = await detectActive(providers)
    expect(state.cognia).toBe("ccswitch:claude:a")
    expect(state.drift).toBe(false)
  })

  it("returns undefined cognia when no provider matches", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "unknown",
      apiBaseUrl: undefined,
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const state = await detectActive([provider({ id: "a" })])
    expect(state.cognia).toBeUndefined()
  })

  it("flags drift when cognia and an agent disagree", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "sk-ant-x",
      apiBaseUrl: "https://api.anthropic.com",
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const providers = [
      provider({ id: "a" }),
      provider({ id: "b", apiKey: "sk-moon", baseUrl: "https://moon" }),
    ]
    const state = await detectActive(providers, {
      agentReaders: {
        "claude-code": async () => ({ apiKey: "sk-moon", baseUrl: "https://moon" }),
      },
    })
    expect(state.cognia).toBe("ccswitch:claude:a")
    expect(state.agents["claude-code"]).toBe("ccswitch:claude:b")
    expect(state.drift).toBe(true)
  })

  it("treats unreadable agents as having no active provider", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: undefined,
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const state = await detectActive([provider({ id: "a" })], {
      agentReaders: {
        "claude-code": async () => {
          throw new Error("permission denied")
        },
      },
    })
    expect(state.agents["claude-code"]).toBeUndefined()
    expect(state.drift).toBe(false)
  })
})

it("normalizes URL slashes and prefers the stored composite identity for equivalent credentials", async () => {
  mGet.mockResolvedValue({
    apiKey: "sk-ant-x",
    apiBaseUrl: "https://api.anthropic.com/",
    activeProviderId: "ccswitch:claude-desktop:p1",
  })
  const state = await detectActive([
    provider({ kind: "claude" }),
    provider({ kind: "claude-desktop" }),
  ])
  expect(state.cognia).toBe("ccswitch:claude-desktop:p1")
})

it("trims credentials before matching", async () => {
  mGet.mockResolvedValue({ apiKey: "  sk-x ", apiBaseUrl: " https://e " })
  const state = await detectActive([provider({ apiKey: "sk-x", baseUrl: "https://e" })])
  expect(state.cognia).toBe("ccswitch:claude:p1")
})
it("does not match empty credentials or infer drift from unreadable agents", async () => {
  mGet.mockResolvedValue({})
  const state = await detectActive([provider({})], {
    agentReaders: { "claude-code": async () => null },
  })
  expect(state).toEqual({ cognia: undefined, agents: { "claude-code": undefined }, drift: false })
})
