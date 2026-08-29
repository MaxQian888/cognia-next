import type { SlashContext } from "../builtin"
import type { ProviderLimitsRow, SubscriptionUsageRow } from "@/types/subscription"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"

// ── Mocks for the data sources the handlers reuse ──────────────────────────

let usageRows: SubscriptionUsageRow[] = []
let usageThrows = false
let sessionUsageRows: SessionUsageRow[] = []
let sessionUsageThrows = false
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
    sessionUsage: {
      toArray: async () => {
        if (sessionUsageThrows) throw new Error("no dexie")
        return sessionUsageRows
      },
    },
  }),
}))

// The quota plane. `/usage` reads the newest stored snapshot and refreshes it
// through the coalescer when it is stale AND the account opted in.
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => true),
}))

const getActiveAccountMock = jest.fn()
const latestLimitsSnapshotMock = jest.fn()
const recordLimitsSnapshotMock = jest.fn()
const queryAccountLimitsCoalescedMock = jest.fn()
jest.mock("@/lib/subscription/limits/store", () => ({
  latestLimitsSnapshot: (...a: unknown[]) => latestLimitsSnapshotMock(...a),
  recordLimitsSnapshot: (...a: unknown[]) => recordLimitsSnapshotMock(...a),
}))
jest.mock("@/lib/subscription/limits/coalesce", () => ({
  queryAccountLimitsCoalesced: (...a: unknown[]) => queryAccountLimitsCoalescedMock(...a),
}))

const listAccountsMock = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: (...a: unknown[]) => listAccountsMock(...a),
  getActiveAccount: (...a: unknown[]) => getActiveAccountMock(...a),
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

type Pushed = Parameters<SlashContext["pushSystemMessage"]>[0]

function makeCtx(): { ctx: SlashContext; pushed: Pushed[]; openSettings: jest.Mock } {
  const pushed: Pushed[] = []
  const openSettings = jest.fn()
  const ctx = {
    args: "",
    activeSessionId: "s1",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings,
    setPermissionMode: jest.fn(),
    pushSystemMessage: (m: Pushed) => pushed.push(m),
  } as unknown as SlashContext
  return { ctx, pushed, openSettings }
}

beforeEach(() => {
  jest.clearAllMocks()
  usageRows = []
  usageThrows = false
  sessionUsageRows = []
  sessionUsageThrows = false
  ;(isTauri as jest.Mock).mockReturnValue(true)
  listAccountsMock.mockResolvedValue([])
  latestBalanceSnapshotMock.mockResolvedValue(null)
  getActiveAccountMock.mockResolvedValue({ activeAccountId: "acc-1", env: [] })
  latestLimitsSnapshotMock.mockResolvedValue(null)
  recordLimitsSnapshotMock.mockImplementation(async (snap: ProviderLimitsRow) => snap)
  queryAccountLimitsCoalescedMock.mockResolvedValue(null)
  useSettingsStore.setState({
    settings: { limitsQueryEnabledAccounts: ["anthropic:acc-1"] } as never,
  })
})

afterEach(() => {
  useSettingsStore.setState({ settings: null as never })
})

// ── /usage ─────────────────────────────────────────────────────────────────

type UsageBlock = Extract<Pushed, { kind: "usage" }>

const NOW = Date.now()

function limitsSnapshot(overrides: Partial<ProviderLimitsRow> = {}): ProviderLimitsRow {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    fetchedAt: NOW,
    meters: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        kind: "window",
        usedPct: 11,
        resetAt: NOW + 3_600_000,
        status: "ok",
      },
      {
        id: "weekly_opus",
        labelKey: "subscription.limits.meter.weekly_opus",
        kind: "window",
        usedPct: 4,
        resetAt: NOW + 86_400_000,
        status: "ok",
      },
      {
        id: "overage",
        labelKey: "subscription.limits.meter.overage",
        kind: "balance",
        usedPct: 20,
        remaining: 80,
        currency: "USD",
        status: "ok",
      },
    ],
    ...overrides,
  }
}

function sessionRow(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: Date.now(),
    model: "claude-opus-5",
    providerId: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 1,
    durationMs: 1000,
    costSource: "sdk",
    costKnown: true,
    surface: "chat",
    ...overrides,
  }
}

describe("handleUsage", () => {
  it("pushes a usage block even when nothing at all could be read", async () => {
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.kind).toBe("usage")
    expect(block.meters).toEqual([])
    // The card is still worth rendering; the notes say why it is empty.
    expect(block.notes?.map((n) => n.id)).toContain("no-local-spend")
  })

  it("prefers the usage-endpoint snapshot, keeping windows and balances apart", async () => {
    latestLimitsSnapshotMock.mockResolvedValue(limitsSnapshot())
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.source).toBe("endpoint")
    expect(block.meters?.map((m) => m.id)).toEqual(["session", "weekly_opus"])
    expect(block.extras?.map((m) => m.id)).toEqual(["overage"])
  })

  it("falls back to the passive header sample when no endpoint snapshot exists", async () => {
    usageRows = [
      {
        fetchedAt: NOW,
        source: "passive",
        status: "allowed_warning",
        representativeClaim: "five_hour",
        fallbackPercentage: 0.2,
        fiveHour: { utilization: 0.42, resetAt: NOW + 5_100_000 },
        sevenDay: { utilization: 0.95, resetAt: NOW + 86_400_000 },
        overageDisabledReason: "spend cap reached",
        rawHeaders: {},
      } as unknown as SubscriptionUsageRow,
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.source).toBe("headers")
    expect(block.meters?.find((m) => m.id === "session")?.usedPct).toBe(42)
    expect(block.meters?.find((m) => m.id === "weekly")?.status).toBe("warn")
    // Header-only metadata is only trustworthy when headers won the fuse.
    expect(block.status).toBe("allowed_warning")
    expect(block.representativeClaim).toBe("five_hour")
    expect(block.fallbackPercentage).toBe(0.2)
    expect(block.overageDisabledReason).toBe("spend cap reached")
  })

  it("still resolves a status when the endpoint wins and reports none", async () => {
    // The usage endpoint has no unified-status field, so `resolveUsageWindows`
    // nulls `headerStatus` whenever it wins — which, because this command
    // actively refreshes the endpoint, is nearly always. Passing that through
    // left the card's status pill permanently blank; the severity of the worst
    // meter is the honest substitute.
    latestLimitsSnapshotMock.mockResolvedValue(
      limitsSnapshot({
        meters: [
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            kind: "window",
            usedPct: 96,
            resetAt: NOW + 86_400_000,
            status: "warn",
          },
        ],
      })
    )
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.source).toBe("endpoint")
    expect(block.status).toBe("allowed_warning")
  })

  it("reports no status at all when neither source produced a reading", async () => {
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect((pushed[0] as UsageBlock).status).toBeNull()
  })

  it("keeps the header-only facts even when the endpoint wins the windows", async () => {
    // Representative claim, fallback buffer and the overage-disabled reason are
    // reported ONLY by the rate-limit headers. "The endpoint had fresher
    // windows" must not silently become "your org has no overage restriction".
    latestLimitsSnapshotMock.mockResolvedValue(limitsSnapshot())
    usageRows = [
      {
        fetchedAt: NOW - 60_000,
        source: "passive",
        status: "allowed",
        representativeClaim: "seven_day",
        fallbackPercentage: 0.2,
        fiveHour: { utilization: 0.1, resetAt: NOW + 3_600_000 },
        sevenDay: null,
        overageDisabledReason: "org_level_disabled",
        rawHeaders: {},
      } as unknown as SubscriptionUsageRow,
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.source).toBe("endpoint")
    expect(block.representativeClaim).toBe("seven_day")
    expect(block.fallbackPercentage).toBe(0.2)
    expect(block.overageDisabledReason).toBe("org_level_disabled")
  })

  it("refreshes a stale snapshot through the coalescer and persists it", async () => {
    latestLimitsSnapshotMock.mockResolvedValue(limitsSnapshot({ fetchedAt: NOW - 3_600_000 }))
    queryAccountLimitsCoalescedMock.mockResolvedValue(limitsSnapshot({ fetchedAt: NOW }))
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledWith("anthropic", "acc-1")
    expect(recordLimitsSnapshotMock).toHaveBeenCalled()
    expect((pushed[0] as UsageBlock).fetchedAt).toBe(NOW)
  })

  it("does not refresh a snapshot that is still fresh", async () => {
    latestLimitsSnapshotMock.mockResolvedValue(limitsSnapshot())
    const { ctx } = makeCtx()
    await handleUsage(ctx)
    expect(queryAccountLimitsCoalescedMock).not.toHaveBeenCalled()
  })

  it("sends nothing outbound for an account that has not opted into quota queries", async () => {
    useSettingsStore.setState({ settings: { limitsQueryEnabledAccounts: [] } as never })
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(queryAccountLimitsCoalescedMock).not.toHaveBeenCalled()
    expect((pushed[0] as UsageBlock).notes?.map((n) => n.id)).toContain("query-disabled")
  })

  it("notes web mode instead of attempting a keyring read", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(getActiveAccountMock).not.toHaveBeenCalled()
    expect((pushed[0] as UsageBlock).notes?.map((n) => n.id)).toContain("web-mode")
  })

  it("notes a missing account rather than querying for one that isn't there", async () => {
    getActiveAccountMock.mockResolvedValue({ env: [] })
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(queryAccountLimitsCoalescedMock).not.toHaveBeenCalled()
    expect((pushed[0] as UsageBlock).notes?.map((n) => n.id)).toContain("no-account")
  })

  it("carries a failed quota query through as a note, not a thrown command", async () => {
    latestLimitsSnapshotMock.mockResolvedValue(null)
    queryAccountLimitsCoalescedMock.mockRejectedValue(new Error("429 Too Many Requests"))
    const { ctx, pushed } = makeCtx()
    await expect(handleUsage(ctx)).resolves.toBeUndefined()
    const note = (pushed[0] as UsageBlock).notes?.find((n) => n.id === "quota-error")
    expect(note?.detail).toContain("429")
  })

  it("marks a snapshot older than the freshness budget as stale", async () => {
    // Opted out, so the stale snapshot is rendered rather than refreshed.
    useSettingsStore.setState({ settings: { limitsQueryEnabledAccounts: [] } as never })
    latestLimitsSnapshotMock.mockResolvedValue(limitsSnapshot({ fetchedAt: NOW - 3_600_000 }))
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect((pushed[0] as UsageBlock).notes?.map((n) => n.id)).toContain("stale")
  })

  it("precomputes every attribution scope, session-scoped to the active chat", async () => {
    sessionUsageRows = [
      sessionRow({ sessionId: "s1" }),
      sessionRow({ sessionId: "other", surface: "workflow" }),
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.hasSession).toBe(true)
    expect(block.scopes?.map((s) => s.key)).toEqual(["session", "today", "week"])
    expect(block.scopes?.[0].totals.turns).toBe(1)
    expect(block.scopes?.[1].totals.turns).toBe(2)
    expect(block.scopes?.[1].surfaces.map((s) => s.surface).sort()).toEqual(["chat", "workflow"])
  })

  it("excludes imported spend, which was paid on another machine", async () => {
    sessionUsageRows = [
      sessionRow({ sessionId: "s1" }),
      sessionRow({ sessionId: "s1", imported: true }),
    ]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect((pushed[0] as UsageBlock).scopes?.[0].totals.turns).toBe(1)
  })

  it("does not truncate the active session's own scope to the calendar window", async () => {
    // A long-running chat can be older than seven days. Deriving its tab from
    // the calendar rows made it report "no recorded turns" for the very
    // conversation on screen.
    sessionUsageRows = [sessionRow({ sessionId: "s1", at: Date.now() - 30 * 86_400_000 })]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.scopes?.[0].totals.turns).toBe(1)
    // The calendar scopes stay bounded — only the session tab is unbounded.
    expect(block.scopes?.[2].totals.turns).toBe(0)
    expect(block.notes?.map((n) => n.id)).not.toContain("no-local-spend")
  })

  it("drops rows older than the widest scope", async () => {
    sessionUsageRows = [sessionRow({ at: Date.now() - 30 * 86_400_000 })]
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect((pushed[0] as UsageBlock).scopes?.[2].totals.turns).toBe(0)
  })

  it("degrades to a note when the local usage table cannot be read", async () => {
    sessionUsageThrows = true
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    const block = pushed[0] as UsageBlock
    expect(block.scopes).toBeUndefined()
    expect(block.notes?.map((n) => n.id)).toContain("local-spend-unavailable")
  })

  it("still pushes a block when the header read throws", async () => {
    usageThrows = true
    const { ctx, pushed } = makeCtx()
    await handleUsage(ctx)
    expect(pushed.length).toBe(1)
    expect((pushed[0] as UsageBlock).kind).toBe("usage")
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
