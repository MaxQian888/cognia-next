/**
 * @jest-environment node
 */
import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"
import { buildCliLimits, mapCliProvider, nodeAuthedGet } from "./limits-data"
import {
  __resetLimitsSourcesForTesting,
  registerLimitsSource,
} from "@/lib/plugin/registries/limits-source-registry"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"

jest.mock("@/lib/subscription/anthropic/usage-probe", () => ({ probeOnce: jest.fn() }))
const mockProbe = probeOnce as jest.MockedFunction<typeof probeOnce>

const NOW = 1_700_000_000_000

function config(providers: ResolvedConfig["providers"], provider = "anthropic"): ResolvedConfig {
  return { ...DEFAULT_RESOLVED_CONFIG, provider, cwd: "/w", providers }
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetLimitsSourcesForTesting())

describe("mapCliProvider", () => {
  it("maps to the vault ProviderId the windowed sources match", () => {
    expect(mapCliProvider("anthropic")).toBe("anthropic")
    expect(mapCliProvider("openai")).toBe("codex")
    expect(mapCliProvider("chatgpt")).toBe("codex")
    expect(mapCliProvider("moonshot")).toBe("opencode")
  })
})

describe("buildCliLimits", () => {
  it("probes anthropic and builds a credit meter for a moonshot key", async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        source: "probe",
        status: "allowed",
        representativeClaim: "five_hour",
        fiveHour: { utilization: 0.21, resetAt: NOW + 3600_000, status: "allowed" },
        sevenDay: { utilization: 0.05, resetAt: NOW + 86_400_000, status: "allowed" },
        fallbackPercentage: null,
        overageDisabledReason: null,
        rawHeaders: {},
      },
    })
    const authedGet = jest.fn(async () =>
      JSON.stringify({ code: 0, data: { available_balance: 88.5 } })
    )
    const out = await buildCliLimits({
      config: config({ anthropic: { authToken: "tok" }, moonshot: { apiKey: "k" } }),
      now: NOW,
      authedGet,
      activeProvider: "anthropic",
    })
    const anthropic = out.find((s) => s.accountId === "anthropic")
    const moonshot = out.find((s) => s.accountId === "moonshot")
    expect(anthropic?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(moonshot?.meters[0]).toMatchObject({ id: "credit", remaining: 88.5 })
    // Active provider pinned first.
    expect(out[0].accountId).toBe("anthropic")
  })

  it("handles a config with no providers map", async () => {
    const cfg = {
      ...DEFAULT_RESOLVED_CONFIG,
      provider: "x",
      cwd: "/w",
      providers: undefined as unknown as ResolvedConfig["providers"],
    }
    expect(await buildCliLimits({ config: cfg, now: NOW, authedGet: async () => "" })).toEqual([])
  })

  it("pins the active provider even when it is enumerated second", async () => {
    const authedGet = async () => JSON.stringify({ code: 0, data: { available_balance: 1 } })
    const out = await buildCliLimits({
      config: config({ moonshot: { apiKey: "a" }, deepseek: { apiKey: "b" } }, "deepseek"),
      now: NOW,
      authedGet,
      activeProvider: "deepseek",
    })
    expect(out[0].accountId).toBe("deepseek")
  })

  it("skips providers with no credential and those with no matching source", async () => {
    const out = await buildCliLimits({
      config: config({
        moonshot: {}, // no credential
        groq: { apiKey: "k", baseURL: "https://api.groq.com/openai/v1" }, // no adapter
      }),
      now: NOW,
      authedGet: async () => "{}",
    })
    expect(out).toEqual([])
  })

  it("isolates a throwing source", async () => {
    const out = await buildCliLimits({
      config: config({ moonshot: { apiKey: "k" } }),
      now: NOW,
      authedGet: async () => {
        throw new Error("boom")
      },
    })
    // moonshot balance source catches the transport error → error snapshot kept.
    expect(out).toHaveLength(1)
    expect(out[0].error).toBe("boom")
  })

  it("swallows a source whose fetch throws and drops the provider", async () => {
    // A plugin source that throws outright (not a caught transport error) must
    // be isolated by the per-source try/catch → provider dropped, no crash.
    registerLimitsSource(
      "throw:src",
      {
        id: "throw:src",
        key: "throw",
        matches: (q) => q.providerKey === "kimi",
        fetch: async () => {
          throw new Error("kaboom")
        },
      },
      { pluginId: "throw" }
    )
    const out = await buildCliLimits({
      config: config({ kimi: { apiKey: "k" } }),
      now: NOW,
      authedGet: async () => JSON.stringify({ code: 0, data: { available_balance: 1 } }),
    })
    // The throwing plugin source matches first and is swallowed; the built-in
    // moonshot balance source (kimi → moonshot.cn) then yields the credit meter.
    expect(out).toHaveLength(1)
    expect(out[0].meters[0]).toMatchObject({ id: "credit" })
  })

  it("appends user-defined custom sources after the configured providers", async () => {
    const cfg: ResolvedConfig = {
      ...config({ moonshot: { apiKey: "k" } }),
      customLimitsSources: [
        {
          id: "myrelay",
          name: "My Relay",
          baseUrl: "https://relay.example.com/v1",
          token: "tok",
          request: { path: "/balance" },
          extract: { kind: "balance", remainingPath: "data.balance", unit: "USD" },
        },
      ],
    }
    const out = await buildCliLimits({
      config: cfg,
      now: NOW,
      authedGet: async () => JSON.stringify({ data: { balance: 12.5, available_balance: 1 } }),
    })
    const custom = out.find((s) => s.provider === "custom:myrelay")
    expect(custom?.accountLabel).toBe("My Relay")
    expect(custom?.meters[0]).toMatchObject({ remaining: 12.5, unit: "USD" })
  })

  it("resolves a stepfun catalog descriptor by id", async () => {
    const out = await buildCliLimits({
      config: config({ stepfun: { apiKey: "k" } }),
      now: NOW,
      authedGet: async (url) => {
        expect(url).toBe("https://api.stepfun.com/v1/accounts")
        return JSON.stringify({ balance: 9 })
      },
    })
    const step = out.find((s) => s.provider === "stepfun")
    expect(step?.meters[0]).toMatchObject({ id: "credit", remaining: 9, unit: "CNY" })
  })
})

describe("nodeAuthedGet", () => {
  it("fetches and returns the body text", async () => {
    const original = globalThis.fetch
    globalThis.fetch = jest.fn(async () => ({ text: async () => "hello" })) as never
    try {
      expect(await nodeAuthedGet("https://x", { A: "b" })).toBe("hello")
      expect(globalThis.fetch).toHaveBeenCalledWith("https://x", { headers: { A: "b" } })
    } finally {
      globalThis.fetch = original
    }
  })
})
