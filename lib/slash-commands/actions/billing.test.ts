import type { SlashContext } from "../builtin"
import type { SubscriptionUsageRow } from "@/types/subscription"

// ── Mocks for the data sources the handlers reuse ──────────────────────────

let usageRows: SubscriptionUsageRow[] = []
let usageThrows = false
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    subscriptionUsage: {
      orderBy: () => ({
        reverse: () => ({
          limit: () => ({
            toArray: async () => {
              if (usageThrows) throw new Error("no dexie")
              return usageRows
            },
          }),
        }),
      }),
    },
  }),
}))

const listAccountsMock = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: (...a: unknown[]) => listAccountsMock(...a),
}))

const latestBalanceSnapshotMock = jest.fn()
jest.mock("@/lib/subscription/balance/store", () => ({
  latestBalanceSnapshot: (...a: unknown[]) => latestBalanceSnapshotMock(...a),
}))

const syncModelsDevCatalogMock = jest.fn()
jest.mock("@/lib/ai/providers/models-dev-sync", () => ({
  syncModelsDevCatalog: (...a: unknown[]) => syncModelsDevCatalogMock(...a),
}))

import { handleUsage, handleBalance, handleModels, handleLogin } from "./billing"

// ── Fake SlashContext ──────────────────────────────────────────────────────

function makeCtx(): { ctx: SlashContext; pushed: string[]; openSettings: jest.Mock } {
  const pushed: string[] = []
  const openSettings = jest.fn()
  const ctx = {
    args: "",
    activeSessionId: "s1",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings,
    setPermissionMode: jest.fn(),
    pushSystemMessage: (m: string) => pushed.push(m),
  } as unknown as SlashContext
  return { ctx, pushed, openSettings }
}

beforeEach(() => {
  jest.clearAllMocks()
  usageRows = []
  usageThrows = false
  listAccountsMock.mockResolvedValue([])
  latestBalanceSnapshotMock.mockResolvedValue(null)
})

// ── /usage ─────────────────────────────────────────────────────────────────

describe("handleUsage", () => {
  it("reports the empty state when no usage snapshot exists", async () => {
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(pushed.join("\n")).toMatch(/No Anthropic usage captured yet/)
  })

  it("renders 5h/7d windows with utilization and reset countdown", async () => {
    const now = Date.now()
    usageRows = [
      {
        fetchedAt: now,
        source: "passive",
        status: "allowed",
        representativeClaim: null,
        fallbackPercentage: 12,
        fiveHour: { utilization: 0.42, resetAt: now + 3_600_000 + 1_500_000 },
        sevenDay: { utilization: 0.95, resetAt: now + 86_400_000 },
        overageDisabledReason: "spend cap reached",
        rawHeaders: {},
      } as unknown as SubscriptionUsageRow,
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const out = pushed.join("\n")
    expect(out).toMatch(/5-hour window\*\*: 42% used/)
    expect(out).toMatch(/7-day window\*\*: 95% used \[warn\]/)
    expect(out).toMatch(/resets in 1h/)
    expect(out).toMatch(/Fallback\*\*: 12%/)
    expect(out).toMatch(/Overage disabled\*\*: spend cap reached/)
  })

  it("renders 'not reported' when a window is absent", async () => {
    usageRows = [
      {
        fetchedAt: Date.now(),
        source: "passive",
        status: "allowed",
        representativeClaim: null,
        fallbackPercentage: null,
        overageDisabledReason: null,
        fiveHour: null,
        sevenDay: null,
        rawHeaders: {},
      } as unknown as SubscriptionUsageRow,
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(pushed.join("\n")).toMatch(/5-hour window\*\*: not reported/)
  })

  it("marks a window as resetting when the countdown is expired", async () => {
    const now = Date.now()
    usageRows = [
      {
        fetchedAt: now,
        source: "passive",
        status: "allowed",
        representativeClaim: null,
        fallbackPercentage: null,
        overageDisabledReason: null,
        fiveHour: { utilization: 0.5, resetAt: now - 1000 },
        sevenDay: null,
        rawHeaders: {},
      } as unknown as SubscriptionUsageRow,
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(pushed.join("\n")).toMatch(/resetting/)
  })

  it("degrades gracefully when the Dexie read throws", async () => {
    usageThrows = true
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    // The throw is swallowed → empty-state hint, single message, no crash.
    expect(pushed.length).toBe(1)
    expect(pushed[0]).toMatch(/No Anthropic usage captured yet/)
  })
})

// ── /balance ────────────────────────────────────────────────────────────────

describe("handleBalance", () => {
  it("reports the empty state when no snapshots exist", async () => {
    const { ctx, pushed } = makeCtx()
    await handleBalance(ctx)
    expect(pushed.join("\n")).toMatch(/No balance snapshots yet/)
  })

  it("lists remaining balances across accounts", async () => {
    listAccountsMock.mockImplementation(async (provider: string) =>
      provider === "opencode"
        ? [{ id: "acc-12345678", label: "Zen", provider, variant: "opencode-zen" }]
        : []
    )
    latestBalanceSnapshotMock.mockResolvedValue({
      providerKey: "deepseek",
      accountId: "acc-12345678",
      remaining: 8.5,
      total: 10,
      unit: "USD",
      fetchedAt: Date.now(),
    })
    const { ctx, pushed } = makeCtx()
    await handleBalance(ctx)
    expect(pushed.join("\n")).toMatch(/\*\*Zen\*\* \(deepseek\): 8\.5 USD \/ 10 remaining/)
  })

  it("surfaces a snapshot error inline", async () => {
    listAccountsMock.mockImplementation(async (provider: string) =>
      provider === "anthropic" ? [{ id: "a1", provider, variant: "anthropic" }] : []
    )
    latestBalanceSnapshotMock.mockResolvedValue({
      providerKey: "deepseek",
      accountId: "a1",
      error: "HTTP 401",
      fetchedAt: Date.now(),
    })
    const { ctx, pushed } = makeCtx()
    await handleBalance(ctx)
    expect(pushed.join("\n")).toMatch(/⚠ HTTP 401/)
  })

  it("skips providers whose keyring read throws (web mode)", async () => {
    listAccountsMock.mockRejectedValue(new Error("no keyring"))
    const { ctx, pushed } = makeCtx()
    await handleBalance(ctx)
    expect(pushed.join("\n")).toMatch(/No balance snapshots yet/)
  })

  it("renders an em dash for a missing amount and skips accounts with no snapshot", async () => {
    listAccountsMock.mockImplementation(async (provider: string) =>
      provider === "codex"
        ? [
            { id: "x1", provider, variant: "codex" },
            { id: "x2", provider, variant: "codex" },
          ]
        : []
    )
    latestBalanceSnapshotMock.mockImplementation(async (id: string) =>
      id === "x1" ? { providerKey: "novita", accountId: "x1", fetchedAt: Date.now() } : null
    )
    const { ctx, pushed } = makeCtx()
    await handleBalance(ctx)
    const out = pushed.join("\n")
    expect(out).toMatch(/\(novita\): —/)
    // x2 had no snapshot → exactly one balance line is rendered.
    expect(out.match(/\(novita\)/g)?.length).toBe(1)
  })
})

// ── /models ──────────────────────────────────────────────────────────────────

describe("handleModels", () => {
  it("syncs the catalog and reports counts", async () => {
    syncModelsDevCatalogMock.mockResolvedValue({
      fetchedAt: 1_700_000_000_000,
      source: "remote",
      providers: {
        openai: { models: [{ id: "a" }, { id: "b" }] },
        anthropic: { models: [{ id: "c" }] },
      },
    })
    const { ctx, pushed } = makeCtx()
    await handleModels(ctx)
    const out = pushed.join("\n")
    expect(out).toMatch(/Syncing the models\.dev catalog/)
    expect(out).toMatch(/Providers\*\*: 2/)
    expect(out).toMatch(/Models\*\*: 3/)
    expect(out).toMatch(/Source\*\*: Live/)
  })

  it("labels a bundled-source sync", async () => {
    syncModelsDevCatalogMock.mockResolvedValue({
      fetchedAt: 1,
      source: "bundled",
      providers: {},
    })
    const { ctx, pushed } = makeCtx()
    await handleModels(ctx)
    expect(pushed.join("\n")).toMatch(/Bundled snapshot/)
  })

  it("reports a failure when the sync throws", async () => {
    syncModelsDevCatalogMock.mockRejectedValue(new Error("offline"))
    const { ctx, pushed } = makeCtx()
    await handleModels(ctx)
    expect(pushed.join("\n")).toMatch(/Failed to sync the models\.dev catalog: offline/)
  })

  it("stringifies a non-Error rejection", async () => {
    syncModelsDevCatalogMock.mockRejectedValue("boom")
    const { ctx, pushed } = makeCtx()
    await handleModels(ctx)
    expect(pushed.join("\n")).toMatch(/Failed to sync the models\.dev catalog: boom/)
  })
})

// ── /login ────────────────────────────────────────────────────────────────────

describe("handleLogin", () => {
  it("opens the subscription settings panel", () => {
    const { ctx, openSettings, pushed } = makeCtx()
    handleLogin(ctx)
    expect(openSettings).toHaveBeenCalledWith("subscription")
    expect(pushed.join("\n")).toMatch(/Settings → Subscription/)
  })
})
