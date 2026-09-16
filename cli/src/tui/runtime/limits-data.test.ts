/**
 * @jest-environment node
 */
import { probeOnce } from "@/lib/subscription/anthropic/usage-probe"
import {
  agentStatusLimits,
  buildCliLimits,
  codexStatusLimits,
  loadCodexLimits,
  loadExternalAgentLimits,
  mapCliProvider,
  nodeAuthedGet,
  nodeAuthedRequest,
  parseDevinCredentialsToml,
  resolveDevinCredential,
} from "./limits-data"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import {
  __resetLimitsSourcesForTesting,
  registerLimitsSource,
} from "@/lib/plugin/registries/limits-source-registry"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"

jest.mock("@/lib/subscription/anthropic/usage-probe", () => ({ probeOnce: jest.fn() }))
jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: jest.fn() }))
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
    expect(mapCliProvider("devin")).toBe("devin")
  })
})

describe("native Codex limits", () => {
  it("localizes native quota labels for the selected CLI language", () => {
    const [snapshot] = codexStatusLimits(
      {
        mcpServers: [],
        skills: [],
        ordinaryUsageAllowed: false,
        rateLimits: {
          primary: { usedPercent: 1, windowDurationMins: 300 },
          credits: { hasCredits: true, unlimited: true, balance: null },
        },
      },
      NOW,
      "zh-CN"
    )
    expect(snapshot.meters.map((meter) => meter.label)).toEqual([
      "codex · 5小时",
      "codex · 额度余额（无限）",
      "Codex · 常规模型使用已被阻止",
    ])
  })

  it("maps used percentages and actual reset timestamps from the connected account", () => {
    const [snapshot] = codexStatusLimits(
      {
        mcpServers: [],
        skills: [],
        account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
        accountFetchedAt: NOW - 1000,
        rateLimits: {
          primary: { usedPercent: 25, resetsAt: NOW / 1000 + 60 },
          secondary: { usedPercent: 75 },
        },
      },
      NOW
    )
    expect(snapshot).toMatchObject({ provider: "codex", accountId: "codex", fetchedAt: NOW - 1000 })
    expect(snapshot.accountLabel).toContain("person@example.com")
    expect(snapshot.meters).toEqual([
      expect.objectContaining({ usedPct: 25, resetAt: NOW + 60_000, status: "ok" }),
      expect.objectContaining({ usedPct: 75, resetAt: null }),
    ])
  })

  it("prefers all named limit buckets without duplicating the legacy bucket", () => {
    const [snapshot] = codexStatusLimits(
      {
        mcpServers: [],
        skills: [],
        rateLimits: { primary: { usedPercent: 100 } },
        rateLimitsByLimitId: {
          codex: { limitName: "Codex", primary: { usedPercent: 1 } },
          spark: { limitName: "Spark", primary: { usedPercent: 2 } },
        },
      },
      NOW
    )
    expect(snapshot.meters.map((meter) => [meter.id, meter.usedPct])).toEqual([
      ["codex/session", 1],
      ["spark/session", 2],
    ])
  })

  it.each([
    {},
    { account: null, rateLimits: { primary: { usedPercent: 100 } } },
    { account: { type: "apiKey" }, rateLimits: { primary: { usedPercent: 100 } } },
    { rateLimitsError: "Temporarily unavailable", rateLimits: { primary: { usedPercent: 100 } } },
    { accountError: "Signed out" },
    { rateLimits: { primary: { usedPercent: Number.NaN } } },
  ])("keeps missing, signed-out, failed and API-key quota unknown: %j", (status) => {
    expect(codexStatusLimits({ mcpServers: [], skills: [], ...status }, NOW)[0].meters).toEqual([])
  })

  it("preserves real credits, unlimited credits and individual spending controls", () => {
    const [snapshot] = codexStatusLimits(
      {
        mcpServers: [],
        skills: [],
        rateLimitsByLimitId: {
          paid: {
            limitName: "Paid",
            credits: { hasCredits: true, unlimited: false, balance: "12.5" },
            individualLimit: {
              limit: "100",
              used: "40",
              remainingPercent: 60,
              resetsAt: NOW / 1000 + 60,
            },
            spendControlReached: true,
          },
          unlimited: { credits: { hasCredits: true, unlimited: true, balance: "0" } },
          unknown: { credits: { hasCredits: false, unlimited: false, balance: null } },
        },
      },
      NOW
    )
    expect(snapshot.meters).toEqual([
      expect.objectContaining({ id: "paid/credits", remaining: 12.5, status: "ok" }),
      expect.objectContaining({ id: "paid/individual", usedPct: 40, resetAt: NOW + 60_000 }),
      expect.objectContaining({
        id: "paid/spending-control",
        usedPct: null,
        status: "crit",
        label: "Paid · Spending limit reached",
      }),
      expect.objectContaining({
        id: "unlimited/credits",
        remaining: undefined,
        status: "ok",
        label: "unlimited · Credits (unlimited)",
      }),
      expect.objectContaining({ id: "unknown/credits", remaining: undefined, status: "unknown" }),
    ])
    expect(snapshot.error).toBeUndefined()
  })

  it("reads only the requested existing adapter, without creating a process or session", async () => {
    const adapter = {
      isConnected: () => true,
      refreshAccount: jest.fn(async () => {}),
      getStatus: () => ({ mcpServers: [], skills: [] }),
    }
    const getAdapter = jest.fn(() => adapter)
    jest
      .mocked(getExternalAgentManager)
      .mockReturnValue({ getCodexAppServerAdapter: getAdapter } as never)
    expect(await loadCodexLimits("live-agent", NOW)).toEqual([
      expect.objectContaining({ provider: "codex", meters: [] }),
    ])
    expect(getAdapter).toHaveBeenCalledWith("live-agent")
    expect(adapter.refreshAccount).toHaveBeenCalledTimes(1)
    getAdapter.mockReturnValue(null as never)
    await expect(loadCodexLimits("gone-agent", NOW)).rejects.toThrow("not connected")
  })

  it("flags an explicit ordinary-usage block even when windows have capacity", () => {
    const base = { mcpServers: [], skills: [], rateLimits: { primary: { usedPercent: 1 } } }
    expect(
      codexStatusLimits({ ...base, ordinaryUsageAllowed: false }, NOW)[0].meters
    ).toContainEqual(
      expect.objectContaining({ id: "ordinary-usage", usedPct: null, status: "crit" })
    )
    expect(codexStatusLimits(base, NOW)[0].meters).toHaveLength(1)
  })
})

describe("buildCliLimits", () => {
  it("loads independent provider balances concurrently", async () => {
    const releases: Array<() => void> = []
    const authedGet = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve(JSON.stringify({ balance_infos: [{ total_balance: 5 }] })))
        })
    )

    const result = buildCliLimits({
      config: config({ deepseek: { apiKey: "d" }, moonshot: { apiKey: "m" } }),
      now: NOW,
      authedGet,
    })
    await Promise.resolve()

    expect(authedGet).toHaveBeenCalledTimes(2)
    releases.forEach((release) => release())
    await result
  })

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

  it("always surfaces the active provider as a no-data placeholder when it yields nothing", async () => {
    // Active provider (anthropic) has no credential here, but a credit provider
    // (deepseek) does. Without the placeholder the panel would show ONLY deepseek
    // — the "always shows deepseek regardless of active provider" bug. The active
    // provider must appear (empty) AND be pinned first.
    const out = await buildCliLimits({
      config: config({ deepseek: { apiKey: "b" } }, "anthropic"),
      now: NOW,
      authedGet: async () => JSON.stringify({ balance_infos: [{ total_balance: 5 }] }),
      activeProvider: "anthropic",
    })
    expect(out[0]).toMatchObject({ accountId: "anthropic", meters: [] })
    expect(out.find((s) => s.accountId === "deepseek")?.meters[0]).toMatchObject({ id: "credit" })
  })

  it("does not add a placeholder when the active provider already has data", async () => {
    const out = await buildCliLimits({
      config: config({ deepseek: { apiKey: "b" } }, "deepseek"),
      now: NOW,
      authedGet: async () =>
        JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "5.25" }] }),
      activeProvider: "deepseek",
    })
    expect(out.filter((s) => s.accountId === "deepseek")).toHaveLength(1)
    expect(out[0].meters[0]).toMatchObject({ id: "credit", remaining: 5.25, currency: "CNY" })
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
          enabled: true,
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

  it("resolves a glm Coding Plan descriptor by id (raw-key auth, window meters)", async () => {
    let seenHeaders: Record<string, string> | undefined
    const out = await buildCliLimits({
      config: config({ glm: { apiKey: "raw-glm-key" } }),
      now: NOW,
      authedGet: async (url, headers) => {
        seenHeaders = headers
        expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
        return JSON.stringify({
          data: {
            limits: [
              { unit: 3, percentage: 60, nextResetTime: NOW / 1000 + 3600 },
              { unit: 6, percentage: 30, nextResetTime: NOW / 1000 + 86_400 },
            ],
          },
        })
      },
    })
    const glm = out.find((s) => s.provider === "glm")
    expect(glm?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(glm?.meters[0]).toMatchObject({ usedPct: 60 })
    expect(glm?.meters[1]).toMatchObject({ usedPct: 30 })
    // Raw key forwarded verbatim — no "Bearer " scheme (Zhipu requires the bare key).
    expect(seenHeaders?.Authorization).toBe("raw-glm-key")
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

describe("native agent limits", () => {
  it("maps native fractional utilization and seconds without synthesizing usage", () => {
    const [snapshot] = agentStatusLimits(
      "anthropic",
      {
        five_hour: {
          kind: "rate-limit",
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.25,
          resetsAt: NOW / 1000 + 60,
        },
        seven_day: { kind: "rate-limit", status: "rejected", rateLimitType: "seven_day" },
        unknown: {
          kind: "rate-limit",
          status: "allowed_warning",
          utilization: NaN,
          resetsAt: Infinity,
        },
      },
      NOW
    )
    expect(snapshot.meters).toEqual([
      expect.objectContaining({ usedPct: 25, resetAt: NOW + 60_000, status: "ok" }),
      expect.objectContaining({ usedPct: null, status: "crit" }),
      expect.objectContaining({ usedPct: null, resetAt: null, status: "warn" }),
    ])
    expect(snapshot.meters[1].label).toContain("seven_day")
  })

  it("preserves overage status, reset, explicit false and native reason", () => {
    const [snapshot] = agentStatusLimits(
      "anthropic",
      {
        five_hour: {
          kind: "rate-limit",
          status: "rejected",
          overageStatus: "allowed",
          overageResetsAt: NOW / 1000 + 120,
          isUsingOverage: false,
          overageDisabledReason: "spend_limit",
        },
        seven_day: { kind: "rate-limit", status: "allowed", overageInUse: true },
      },
      NOW,
      "zh-CN"
    )
    expect(snapshot.meters[1]).toMatchObject({
      usedPct: null,
      resetAt: NOW + 120_000,
      status: "ok",
    })
    expect(snapshot.meters[1].label).toContain("未使用")
    expect(snapshot.meters[1].label).toContain("spend_limit")
    expect(snapshot.meters[3].label).toContain("使用中")
    expect(snapshot.meters[3].status).toBe("unknown")
  })
})

it("retains the latest native quota report time when reopening the panel", () => {
  const events = {
    five_hour: {
      kind: "rate-limit" as const,
      status: "allowed" as const,
      receivedAt: NOW - 60_000,
    },
    seven_day: {
      kind: "rate-limit" as const,
      status: "allowed" as const,
      receivedAt: NOW - 120_000,
    },
    legacy: { kind: "rate-limit" as const, status: "allowed" as const },
  }
  const [initial] = agentStatusLimits("anthropic", events, NOW)
  const [reopened] = agentStatusLimits("anthropic", events, NOW + 300_000, "zh-CN")
  expect(initial.fetchedAt).toBe(NOW - 60_000)
  expect(reopened.fetchedAt).toBe(initial.fetchedAt)
  expect(initial.notice).toContain("Latest quota reported")
  expect(reopened.notice).toContain("最近报告")
  expect(agentStatusLimits("anthropic", { legacy: events.legacy }, NOW)[0].fetchedAt).toBe(NOW)
})

describe("nodeAuthedRequest", () => {
  it("sends method/body and returns status + text", async () => {
    const original = globalThis.fetch
    globalThis.fetch = jest.fn(async () => ({ status: 201, text: async () => "ok-body" })) as never
    try {
      const res = await nodeAuthedRequest({
        url: "https://x.test/rpc",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      expect(res).toEqual({ status: 201, body: "ok-body" })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://x.test/rpc",
        expect.objectContaining({ method: "POST", body: "{}" })
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("parseDevinCredentialsToml", () => {
  it("extracts the quota fields and tolerates missing ones", () => {
    expect(
      parseDevinCredentialsToml(
        'windsurf_api_key = "wk-abc"\napi_server_url = "https://server.codeium.com"\ndevin_api_url = "https://api.devin.ai"\n'
      )
    ).toEqual({ apiKey: "wk-abc", apiServerUrl: "https://server.codeium.com" })
    expect(parseDevinCredentialsToml('windsurf_api_key = "wk-only"\n')).toEqual({
      apiKey: "wk-only",
      apiServerUrl: undefined,
    })
    expect(parseDevinCredentialsToml("not valid = = toml [")).toEqual({})
    expect(parseDevinCredentialsToml('other = "x"\n')).toEqual({})
  })
})

describe("resolveDevinCredential", () => {
  it("prefers DEVIN_API_KEY env over the credentials file", async () => {
    const readFile = jest.fn(async () => 'windsurf_api_key = "wk-file"\n')
    const cred = await resolveDevinCredential({
      env: { DEVIN_API_KEY: "wk-env", DEVIN_BASE_URL: "https://mirror.codeium.com" },
      readFile,
    })
    expect(cred).toEqual({ token: "wk-env", baseUrl: "https://mirror.codeium.com" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("falls back to DEVIN_TOKEN then the credentials file", async () => {
    const cred = await resolveDevinCredential({
      env: { DEVIN_TOKEN: "wk-tok" },
      readFile: async () => null,
    })
    expect(cred).toEqual({ token: "wk-tok", baseUrl: undefined })
    const fromFile = await resolveDevinCredential({
      env: {},
      readFile: async () =>
        'windsurf_api_key = "wk-file"\napi_server_url = "https://server.codeium.com"\n',
    })
    expect(fromFile).toEqual({ token: "wk-file", baseUrl: "https://server.codeium.com" })
  })

  it("returns null when neither env nor file yields a token", async () => {
    expect(await resolveDevinCredential({ env: {}, readFile: async () => null })).toBeNull()
    expect(await resolveDevinCredential({ env: {}, readFile: async () => "garbage [[" })).toBeNull()
  })
})

describe("loadExternalAgentLimits", () => {
  const devinBody = JSON.stringify({
    userStatus: {
      email: "fan@example.com",
      planStatus: {
        weeklyQuotaRemainingPercent: 48,
        weeklyQuotaResetAtUnix: "1789891200",
        planInfo: { planName: "Pro" },
      },
    },
  })

  it("queries Devin quota via the source registry using the agent's own credential", async () => {
    const authedRequest = jest.fn(async (_req: { url: string; body?: string }) => ({
      status: 200,
      body: devinBody,
    }))
    const out = await loadExternalAgentLimits(
      config({}),
      NOW,
      "devin",
      "devin",
      "agentLimits.unavailable",
      {
        authedGet: async () => "{}",
        authedRequest,
        credentialDeps: { env: { DEVIN_API_KEY: "wk-x" }, readFile: async () => null },
      }
    )
    expect(authedRequest).toHaveBeenCalledTimes(1)
    expect(authedRequest.mock.calls[0][0].url).toBe(
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
    )
    expect(JSON.parse(authedRequest.mock.calls[0][0].body!).metadata.apiKey).toBe("wk-x")
    expect(out[0]).toMatchObject({ provider: "devin", accountId: "devin" })
    expect(out[0].meters[0]).toMatchObject({ id: "devin/weekly", usedPct: 52 })
    expect(out[0].accountLabel).toBe("Devin · fan@example.com · Pro")
  })

  it("uses a user-configured providers.devin entry without touching the agent store", async () => {
    const readFile = jest.fn(async (_path: string) => null)
    const authedRequest = jest.fn(async (_req: { url: string; body?: string }) => ({
      status: 200,
      body: devinBody,
    }))
    const out = await loadExternalAgentLimits(
      config({ devin: { authToken: "wk-cfg", baseURL: "https://server.codeium.com" } }),
      NOW,
      "devin",
      "devin",
      "agentLimits.unavailable",
      { authedGet: async () => "{}", authedRequest, credentialDeps: { env: {}, readFile } }
    )
    expect(readFile).not.toHaveBeenCalled()
    expect(JSON.parse(authedRequest.mock.calls[0][0].body!).metadata.apiKey).toBe("wk-cfg")
    expect(out[0].meters.length).toBeGreaterThan(0)
  })

  it("shows the devin missing-credential notice when nothing resolves", async () => {
    const authedRequest = jest.fn(async () => ({ status: 200, body: "{}" }))
    const out = await loadExternalAgentLimits(
      config({}),
      NOW,
      "devin",
      "devin",
      "agentLimits.unavailable",
      {
        authedGet: async () => "{}",
        authedRequest,
        credentialDeps: { env: {}, readFile: async () => null },
      }
    )
    expect(authedRequest).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ provider: "devin", accountId: "devin" })
    expect(out[0].notice).toContain("devin auth login")
  })

  it("keeps the generic unavailable notice for agents with no linked provider", async () => {
    const out = await loadExternalAgentLimits(
      config({}),
      NOW,
      "gemini-cli",
      "gemini-cli",
      "agentLimits.unavailable",
      { authedGet: async () => "{}" }
    )
    expect(out[0]).toMatchObject({ accountId: "gemini-cli", meters: [] })
    expect(out[0].notice).toContain("does not support querying")
  })

  it("surfaces a devin API failure as an error snapshot, not a fake empty state", async () => {
    const authedRequest = async () => ({ status: 429, body: "slow down" })
    const out = await loadExternalAgentLimits(
      config({}),
      NOW,
      "devin",
      "devin",
      "agentLimits.unavailable",
      {
        authedGet: async () => "{}",
        authedRequest,
        credentialDeps: { env: { DEVIN_API_KEY: "wk-x" }, readFile: async () => null },
      }
    )
    expect(out[0].error).toContain("429")
  })

  it("leaves the placeholder bare when a query ran but reported no plan data", async () => {
    const authedRequest = async () => ({
      status: 200,
      body: JSON.stringify({ userStatus: { email: "a@b.c" } }),
    })
    const out = await loadExternalAgentLimits(
      config({}),
      NOW,
      "devin",
      "devin",
      "agentLimits.unavailable",
      {
        authedGet: async () => "{}",
        authedRequest,
        credentialDeps: { env: { DEVIN_API_KEY: "wk-x" }, readFile: async () => null },
      }
    )
    const devin = out.find((s) => s.accountId === "devin")
    expect(devin).toBeDefined()
    expect(devin!.notice).toBeUndefined()
  })
})
