import type { LimitsMeter, LimitsMeterStatus, ProviderLimits } from "@/types/subscription"

import {
  buildQuotaSlice,
  GLANCE_QUOTA_STALE_MS,
  quotaKey,
  type BuildQuotaSliceInput,
  type GlanceVaultAccount,
} from "./build-quota"

const NOW = 1_800_000_000_000
const FRESH = NOW - 60_000
const FAKE_KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

function meter(status: LimitsMeterStatus, extra: Partial<LimitsMeter> = {}): LimitsMeter {
  return {
    id: `m-${status}`,
    kind: "window",
    usedPct: 10,
    status,
    ...extra,
  }
}

function reading(
  provider: string,
  accountId: string | undefined,
  meters: LimitsMeter[],
  extra: Partial<ProviderLimits> = {}
): ProviderLimits {
  return { provider, accountId, fetchedAt: FRESH, meters, ...extra }
}

function account(
  provider: string,
  accountId: string,
  extra: Partial<GlanceVaultAccount> = {}
): GlanceVaultAccount {
  return {
    provider,
    accountId,
    accountLabel: `${provider} ${accountId}`,
    queryEnabled: true,
    quotaCapable: true,
    ...extra,
  }
}

function build(patch: Partial<BuildQuotaSliceInput> = {}) {
  return buildQuotaSlice({
    accounts: [],
    latest: new Map(),
    lastGood: new Map(),
    custom: [],
    discovered: [],
    refreshingKeys: new Set(),
    refreshing: false,
    now: NOW,
    ...patch,
  })
}

const mapOf = (...entries: ProviderLimits[]) =>
  new Map(entries.map((e) => [quotaKey(e.provider, e.accountId), e]))

describe("quotaKey", () => {
  it("joins provider and account, tolerating a missing account", () => {
    expect(quotaKey("anthropic", "a1")).toBe("anthropic:a1")
    expect(quotaKey("anthropic", null)).toBe("anthropic:")
    expect(quotaKey("anthropic", undefined)).toBe("anthropic:")
  })
})

describe("GLANCE_QUOTA_STALE_MS", () => {
  it("is three automatic query intervals", () => {
    expect(GLANCE_QUOTA_STALE_MS).toBe(15 * 60_000)
  })
})

describe("buildQuotaSlice", () => {
  it("returns an empty slice stamped with now and the refreshing flag", () => {
    expect(build()).toEqual({ updatedAt: NOW, refreshing: false, sources: [] })
    expect(build({ refreshing: true }).refreshing).toBe(true)
  })

  describe("states from a fresh reading", () => {
    const stateFor = (...statuses: LimitsMeterStatus[]) => {
      const r = reading(
        "p",
        "a",
        statuses.map((s) => meter(s))
      )
      return build({ accounts: [account("p", "a")], latest: mapOf(r) }).sources[0].state
    }

    it("is ok when every meter is ok or unknown", () => {
      expect(stateFor("ok")).toBe("ok")
      expect(stateFor("ok", "unknown")).toBe("ok")
      expect(stateFor()).toBe("ok")
    })

    it("is warn when any meter is warn or crit", () => {
      expect(stateFor("ok", "warn")).toBe("warn")
      expect(stateFor("ok", "crit")).toBe("warn")
    })

    it("is exhausted when any meter is exceeded, ahead of warn", () => {
      expect(stateFor("warn", "exceeded")).toBe("exhausted")
      expect(stateFor("exceeded")).toBe("exhausted")
    })

    it("maps meter fields into windows", () => {
      const r = reading("p", "a", [
        meter("warn", {
          id: "weekly",
          labelKey: "subscription.limits.meter.weekly",
          label: "Weekly",
          usedPct: 82,
          resetAt: NOW + 1000,
          remaining: 5,
          unit: "USD",
          currency: "USD",
          kind: "balance",
        }),
        meter("ok", { id: "bare" }),
      ])
      const [src] = build({ accounts: [account("p", "a")], latest: mapOf(r) }).sources
      expect(src.windows[0]).toEqual({
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        label: "Weekly",
        kind: "balance",
        usedPct: 82,
        resetAt: NOW + 1000,
        remaining: 5,
        unit: "USD",
        currency: "USD",
        severity: "warn",
      })
      expect(src.windows[1]).toMatchObject({
        labelKey: null,
        label: null,
        resetAt: null,
        remaining: null,
        unit: null,
        currency: null,
        severity: "ok",
      })
    })

    it("carries identity, the reading's fetchedAt and no error", () => {
      const r = reading("p", "a", [meter("ok")])
      const [src] = build({
        accounts: [account("p", "a", { accountLabel: "Work" })],
        latest: mapOf(r),
      }).sources
      expect(src).toMatchObject({
        key: "p:a",
        provider: "p",
        accountId: "a",
        accountLabel: "Work",
        fetchedAt: FRESH,
        error: null,
      })
    })

    it("falls back to the reading's account label when the vault has none", () => {
      const r = reading("p", "a", [meter("ok")], { accountLabel: "From reading" })
      const [src] = build({
        accounts: [account("p", "a", { accountLabel: null })],
        latest: mapOf(r),
      }).sources
      expect(src.accountLabel).toBe("From reading")
    })
  })

  describe("stale", () => {
    it("is stale once the reading is older than the window, whatever its meters say", () => {
      const r = reading("p", "a", [meter("exceeded")], {
        fetchedAt: NOW - GLANCE_QUOTA_STALE_MS - 1,
      })
      const [src] = build({ accounts: [account("p", "a")], latest: mapOf(r) }).sources
      expect(src.state).toBe("stale")
      expect(src.windows).toHaveLength(1)
      expect(src.fetchedAt).toBe(r.fetchedAt)
    })

    it("is not stale exactly at the window edge", () => {
      const r = reading("p", "a", [meter("ok")], { fetchedAt: NOW - GLANCE_QUOTA_STALE_MS })
      expect(build({ accounts: [account("p", "a")], latest: mapOf(r) }).sources[0].state).toBe("ok")
    })
  })

  describe("error", () => {
    const good = reading("p", "a", [meter("warn", { id: "good" })], { fetchedAt: NOW - 120_000 })

    it("keeps the last good meters and fetchedAt, and reports the error", () => {
      const failed = reading("p", "a", [], { fetchedAt: NOW - 1000, error: "HTTP 500" })
      const [src] = build({
        accounts: [account("p", "a")],
        latest: mapOf(failed),
        lastGood: mapOf(good),
      }).sources
      expect(src.state).toBe("error")
      expect(src.error).toBe("HTTP 500")
      expect(src.windows.map((w) => w.id)).toEqual(["good"])
      expect(src.fetchedAt).toBe(good.fetchedAt)
    })

    it("stays error (not refreshing) while a retry runs if a good reading exists", () => {
      const failed = reading("p", "a", [], { error: "HTTP 500" })
      const [src] = build({
        accounts: [account("p", "a")],
        latest: mapOf(failed),
        lastGood: mapOf(good),
        refreshingKeys: new Set(["p:a"]),
      }).sources
      expect(src.state).toBe("error")
    })

    it("shows an error with no meters and no fetchedAt when nothing good exists", () => {
      const failed = reading("p", "a", [], { error: "HTTP 401" })
      const [src] = build({ accounts: [account("p", "a")], latest: mapOf(failed) }).sources
      expect(src).toMatchObject({ state: "error", windows: [], fetchedAt: null, error: "HTTP 401" })
    })

    it("is refreshing when the error has no good reading behind it and a query is in flight", () => {
      const failed = reading("p", "a", [], { error: "HTTP 401" })
      const [src] = build({
        accounts: [account("p", "a")],
        latest: mapOf(failed),
        refreshingKeys: new Set(["p:a"]),
      }).sources
      expect(src.state).toBe("refreshing")
      expect(src.error).toBe("HTTP 401")
    })

    it("ignores a last-good entry that itself carries an error", () => {
      const failed = reading("p", "a", [], { error: "boom" })
      const badGood = reading("p", "a", [meter("ok", { id: "x" })], { error: "also bad" })
      const [src] = build({
        accounts: [account("p", "a")],
        latest: mapOf(failed),
        lastGood: mapOf(badGood),
      }).sources
      expect(src.windows).toEqual([])
      expect(src.fetchedAt).toBeNull()
    })

    it("redacts an API key and an email out of the error", () => {
      const failed = reading("p", "a", [], {
        error: `401 for key ${FAKE_KEY} on account jane.doe@example.com`,
      })
      const [src] = build({ accounts: [account("p", "a")], latest: mapOf(failed) }).sources
      expect(src.error).not.toContain(FAKE_KEY)
      expect(src.error).not.toContain("AAAAAAAAAAAAAAAA")
      expect(src.error).not.toContain("jane.doe@example.com")
      expect(JSON.stringify(src)).not.toContain(FAKE_KEY)
      expect(JSON.stringify(src)).not.toContain("jane.doe@example.com")
    })

    it("collapses whitespace and caps the error at 160 characters", () => {
      const failed = reading("p", "a", [], { error: `line one\n\nline two ${"z".repeat(400)}` })
      const [src] = build({ accounts: [account("p", "a")], latest: mapOf(failed) }).sources
      expect(src.error!.length).toBeLessThanOrEqual(160)
      expect(src.error).not.toContain("\n")
      expect(src.error!.endsWith("…")).toBe(true)
    })
  })

  describe("refreshing and missing readings", () => {
    it("is refreshing with no meters while a query is in flight and nothing was read", () => {
      const [src] = build({
        accounts: [account("p", "a")],
        refreshingKeys: new Set(["p:a"]),
      }).sources
      expect(src).toMatchObject({ state: "refreshing", windows: [], fetchedAt: null, error: null })
    })

    it("shows a quota-capable enabled account with no reading yet as refreshing", () => {
      const [src] = build({ accounts: [account("p", "a", { quotaCapable: true })] }).sources
      expect(src.state).toBe("refreshing")
    })

    it("omits an enabled account with no reading that is neither capable nor refreshing", () => {
      expect(build({ accounts: [account("p", "a", { quotaCapable: false })] }).sources).toEqual([])
    })

    it("keeps an incapable account while its query is in flight", () => {
      const out = build({
        accounts: [account("p", "a", { quotaCapable: false })],
        refreshingKeys: new Set(["p:a"]),
      })
      expect(out.sources.map((s) => s.state)).toEqual(["refreshing"])
    })

    it("keeps an incapable account that already has a reading", () => {
      const r = reading("p", "a", [meter("ok")])
      const out = build({
        accounts: [account("p", "a", { quotaCapable: false })],
        latest: mapOf(r),
      })
      expect(out.sources.map((s) => s.state)).toEqual(["ok"])
    })
  })

  describe("disabled accounts", () => {
    it("shows a capable disabled account", () => {
      const [src] = build({
        accounts: [account("p", "a", { queryEnabled: false, quotaCapable: true })],
      }).sources
      expect(src).toEqual({
        key: "p:a",
        provider: "p",
        accountId: "a",
        accountLabel: "p a",
        state: "disabled",
        windows: [],
        fetchedAt: null,
        error: null,
      })
    })

    it("shows an incapable disabled account only when it has a last-good reading", () => {
      const acct = account("p", "a", { queryEnabled: false, quotaCapable: false })
      expect(build({ accounts: [acct] }).sources).toEqual([])
      const good = reading("p", "a", [meter("ok")])
      expect(
        build({ accounts: [acct], lastGood: mapOf(good) }).sources.map((s) => s.state)
      ).toEqual(["disabled"])
    })

    it("ignores any reading for a disabled account", () => {
      const r = reading("p", "a", [meter("exceeded")])
      const [src] = build({
        accounts: [account("p", "a", { queryEnabled: false })],
        latest: mapOf(r),
      }).sources
      expect(src.state).toBe("disabled")
      expect(src.windows).toEqual([])
    })
  })

  describe("custom sources", () => {
    it("includes custom readings keyed by sourceId (falling back to provider)", () => {
      const withSource = reading("vaultish", undefined, [meter("ok")], { sourceId: "my-source" })
      const withoutSource = reading("plain", "acc", [meter("warn")])
      const out = build({ custom: [withSource, withoutSource] })
      const keys = out.sources.map((s) => s.key).sort()
      expect(keys).toEqual(["my-source:", "plain:acc"])
      const first = out.sources.find((s) => s.key === "my-source:")!
      expect(first).toMatchObject({ provider: "my-source", accountId: null, state: "ok" })
    })

    it("treats a failed custom reading as an error with no meters, and a stale one as stale", () => {
      const failed = reading("c1", undefined, [], { error: "down" })
      const old = reading("c2", undefined, [meter("ok")], {
        fetchedAt: NOW - GLANCE_QUOTA_STALE_MS - 5,
      })
      const out = build({ custom: [failed, old] })
      expect(out.sources.map((s) => s.state)).toEqual(["error", "stale"])
      expect(out.sources[0]).toMatchObject({ windows: [], fetchedAt: null, error: "down" })
    })

    it("redacts secrets in custom errors too", () => {
      const failed = reading("c1", undefined, [], { error: `bad token ${FAKE_KEY}` })
      expect(JSON.stringify(build({ custom: [failed] }))).not.toContain(FAKE_KEY)
    })
  })

  describe("discovered providers", () => {
    it("shows providers with a local login that are not in the vault", () => {
      const out = build({ discovered: ["codex"] })
      expect(out.sources).toEqual([
        {
          key: "discovered:codex",
          provider: "codex",
          accountId: null,
          accountLabel: null,
          state: "discovered",
          windows: [],
          fetchedAt: null,
          error: null,
        },
      ])
    })

    it("hides a discovered provider that already has a vault account (even a disabled one)", () => {
      const out = build({
        accounts: [account("codex", "a", { queryEnabled: false })],
        discovered: ["codex", "gemini"],
      })
      expect(out.sources.map((s) => s.key)).toEqual(["codex:a", "discovered:gemini"])
    })
  })

  describe("ordering", () => {
    it("sorts by urgency: exhausted, error, warn, stale, ok, refreshing, disabled, discovered", () => {
      const accounts = [
        account("ok", "1"),
        account("disabled", "1", { queryEnabled: false }),
        account("refreshing", "1"),
        account("stale", "1"),
        account("warn", "1"),
        account("error", "1"),
        account("exhausted", "1"),
      ]
      const latest = mapOf(
        reading("ok", "1", [meter("ok")]),
        reading("stale", "1", [meter("ok")], { fetchedAt: NOW - GLANCE_QUOTA_STALE_MS - 1 }),
        reading("warn", "1", [meter("warn")]),
        reading("error", "1", [], { error: "x" }),
        reading("exhausted", "1", [meter("exceeded")])
      )
      const out = build({
        accounts,
        latest,
        refreshingKeys: new Set(["refreshing:1"]),
        discovered: ["found"],
      })
      expect(out.sources.map((s) => s.state)).toEqual([
        "exhausted",
        "error",
        "warn",
        "stale",
        "ok",
        "refreshing",
        "disabled",
        "discovered",
      ])
    })

    it("keeps enumeration order for ties", () => {
      const accounts = ["z", "a", "m"].map((id) => account("p", id))
      const latest = mapOf(...accounts.map((a) => reading("p", a.accountId, [meter("ok")])))
      const out = build({ accounts, latest })
      expect(out.sources.map((s) => s.accountId)).toEqual(["z", "a", "m"])
    })

    it("places accounts before custom sources before discovered among equal states", () => {
      const out = build({
        accounts: [account("v", "1")],
        latest: mapOf(reading("v", "1", [meter("ok")])),
        custom: [reading("c", undefined, [meter("ok")])],
      })
      expect(out.sources.map((s) => s.provider)).toEqual(["v", "c"])
    })
  })
})
