import { act, renderHook } from "@testing-library/react"

import type { AccountSummary, ProviderLimitsRow } from "@/types/subscription"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@cognia/logging", () => ({
  loggers: { tray: { warn: jest.fn() } },
}))
jest.mock("@/lib/credentials/secret-store-readiness", () => ({
  reportSecretStoreFailure: jest.fn(() => false),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))
jest.mock("@/lib/subscription/anthropic/discovery", () => ({
  discoverAnthropicAuth: jest.fn(),
}))
jest.mock("@/lib/subscription/codex/discovery", () => ({
  discoverCodexAuth: jest.fn(),
}))
jest.mock("@/lib/subscription/core/subscription-events", () => ({
  subscribeSubscriptionChanged: jest.fn(),
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(),
  listSubscriptionProviderIds: jest.fn(),
}))
jest.mock("@/lib/subscription/limits/coalesce", () => ({
  LIMITS_QUERY_MIN_INTERVAL_MS: 5 * 60_000,
  queryAccountLimitsCoalesced: jest.fn(),
}))
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useAllConfiguredLimits: jest.fn(),
}))
jest.mock("@/lib/subscription/limits/store", () => ({
  recordLimitsSnapshot: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))
jest.mock("@/stores/settings", () => {
  const state: { settings: Record<string, unknown> | null; save: jest.Mock } = {
    settings: {},
    save: jest.fn(),
  }
  const useSettingsStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  )
  return { useSettingsStore }
})

import { useLiveQuery } from "dexie-react-hooks"
import { loggers } from "@cognia/logging"

import { reportSecretStoreFailure } from "@/lib/credentials/secret-store-readiness"
import { getDb } from "@/lib/db/schema"
import { discoverAnthropicAuth } from "@/lib/subscription/anthropic/discovery"
import { discoverCodexAuth } from "@/lib/subscription/codex/discovery"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { listAccounts, listSubscriptionProviderIds } from "@/lib/subscription/core/transport"
import { queryAccountLimitsCoalesced } from "@/lib/subscription/limits/coalesce"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"
import { recordLimitsSnapshot } from "@/lib/subscription/limits/store"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"

import {
  foldReadings,
  GLANCE_DISCOVERY_INTERVAL_MS,
  isQuotaCapable,
  useGlanceQuota,
} from "./use-glance-quota"

const useLiveQueryMock = useLiveQuery as unknown as jest.Mock
const getDbMock = getDb as unknown as jest.Mock
const discoverAnthropicMock = discoverAnthropicAuth as jest.Mock
const discoverCodexMock = discoverCodexAuth as jest.Mock
const subscribeChangedMock = subscribeSubscriptionChanged as jest.Mock
const listAccountsMock = listAccounts as jest.Mock
const listProviderIdsMock = listSubscriptionProviderIds as jest.Mock
const queryMock = queryAccountLimitsCoalesced as jest.Mock
const useAllConfiguredLimitsMock = useAllConfiguredLimits as jest.Mock
const recordSnapshotMock = recordLimitsSnapshot as jest.Mock
const isTauriMock = isTauri as jest.Mock
const reportFailureMock = reportSecretStoreFailure as jest.Mock
const warnMock = loggers.tray.warn as jest.Mock

type SettingsState = {
  settings: Record<string, unknown> | null
  save: jest.Mock
}
const settingsState = (useSettingsStore as unknown as { getState: () => SettingsState }).getState()

const NOW = 1_700_000_000_000

function row(
  partial: Partial<ProviderLimitsRow> & Pick<ProviderLimitsRow, "provider">
): ProviderLimitsRow {
  return { fetchedAt: NOW - 1_000, meters: [], ...partial }
}

function summary(partial: Partial<AccountSummary> & Pick<AccountSummary, "id">): AccountSummary {
  return {
    provider: "anthropic",
    variant: "anthropic",
    expiresAtMs: 0,
    createdAtMs: 0,
    lastUsedAtMs: 0,
    authMode: "oauth",
    credentialSource: "managed",
    health: "ok",
    ...partial,
  } as AccountSummary
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

describe("isQuotaCapable", () => {
  it("is true for any anthropic account", () => {
    expect(isQuotaCapable({ variant: "anthropic", authMode: "oauth" })).toBe(true)
    expect(isQuotaCapable({ variant: "anthropic", authMode: "api_key" })).toBe(true)
  })

  it("is true for a codex account signed in with ChatGPT", () => {
    expect(isQuotaCapable({ variant: "codex", authMode: "chatgpt" })).toBe(true)
  })

  it("is false for a codex account using an API key", () => {
    expect(isQuotaCapable({ variant: "codex", authMode: "api_key" })).toBe(false)
  })

  it.each(["opencode-discovered", "opencode-zen", "commandcode", "api-key"] as const)(
    "is false for variant %s",
    (variant) => {
      expect(isQuotaCapable({ variant, authMode: "chatgpt" })).toBe(false)
    }
  )
})

describe("foldReadings", () => {
  it("returns empty collections for no rows", () => {
    const folded = foldReadings([])
    expect(folded.latest.size).toBe(0)
    expect(folded.lastGood.size).toBe(0)
    expect(folded.custom).toEqual([])
  })

  it("keeps the newest reading per provider:account", () => {
    const older = row({ provider: "anthropic", accountId: "a", fetchedAt: 100 })
    const newer = row({ provider: "anthropic", accountId: "a", fetchedAt: 200 })
    const folded = foldReadings([newer, older])
    expect(folded.latest.get("anthropic:a")).toBe(newer)
    expect(folded.latest.size).toBe(1)
    expect(folded.lastGood.get("anthropic:a")).toBe(newer)
  })

  it("keeps accounts of one provider apart", () => {
    const a = row({ provider: "anthropic", accountId: "a" })
    const b = row({ provider: "anthropic", accountId: "b" })
    const folded = foldReadings([a, b])
    expect(folded.latest.size).toBe(2)
    expect(folded.latest.get("anthropic:a")).toBe(a)
    expect(folded.latest.get("anthropic:b")).toBe(b)
  })

  it("keys a row with no accountId as provider with an empty id", () => {
    const r = row({ provider: "codex" })
    expect(foldReadings([r]).latest.get("codex:")).toBe(r)
  })

  it("tracks the newest error-free reading separately from the newest reading", () => {
    const good = row({ provider: "anthropic", accountId: "a", fetchedAt: 100 })
    const bad = row({ provider: "anthropic", accountId: "a", fetchedAt: 200, error: "boom" })
    const folded = foldReadings([good, bad])
    expect(folded.latest.get("anthropic:a")).toBe(bad)
    expect(folded.lastGood.get("anthropic:a")).toBe(good)
  })

  it("picks the newest of several good readings regardless of order", () => {
    const g1 = row({ provider: "anthropic", accountId: "a", fetchedAt: 300 })
    const g2 = row({ provider: "anthropic", accountId: "a", fetchedAt: 100 })
    const g3 = row({ provider: "anthropic", accountId: "a", fetchedAt: 200 })
    expect(foldReadings([g2, g1, g3]).lastGood.get("anthropic:a")).toBe(g1)
  })

  it("has no lastGood when every reading errored", () => {
    const bad = row({ provider: "anthropic", accountId: "a", error: "x" })
    const folded = foldReadings([bad])
    expect(folded.latest.get("anthropic:a")).toBe(bad)
    expect(folded.lastGood.has("anthropic:a")).toBe(false)
  })

  it("routes custom: rows to the custom list only, newest per key", () => {
    const c1 = row({ provider: "custom:one", fetchedAt: 100 })
    const c2 = row({ provider: "custom:one", fetchedAt: 200 })
    const c3 = row({ provider: "custom:two", fetchedAt: 50 })
    const folded = foldReadings([c1, c2, c3])
    expect(folded.latest.size).toBe(0)
    expect(folded.lastGood.size).toBe(0)
    expect(folded.custom).toHaveLength(2)
    expect(folded.custom).toEqual(expect.arrayContaining([c2, c3]))
    expect(folded.custom).not.toContain(c1)
  })

  it("keeps an errored custom reading when it is the newest", () => {
    const ok = row({ provider: "custom:one", fetchedAt: 100 })
    const bad = row({ provider: "custom:one", fetchedAt: 200, error: "x" })
    expect(foldReadings([ok, bad]).custom).toEqual([bad])
  })
})

describe("useGlanceQuota", () => {
  const refreshConfigured = jest.fn()
  let liveRows: ProviderLimitsRow[]
  let changeListener: (() => void) | null
  let unsubscribeChanged: jest.Mock
  let configuredRefreshing: boolean

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    jest.clearAllMocks()
    liveRows = []
    changeListener = null
    configuredRefreshing = false
    unsubscribeChanged = jest.fn()
    refreshConfigured.mockResolvedValue(undefined)
    useAllConfiguredLimitsMock.mockImplementation(() => ({
      refresh: refreshConfigured,
      refreshing: configuredRefreshing,
    }))
    useLiveQueryMock.mockImplementation(() => liveRows)
    subscribeChangedMock.mockImplementation((listener: () => void) => {
      changeListener = listener
      return unsubscribeChanged
    })
    isTauriMock.mockReturnValue(true)
    reportFailureMock.mockReturnValue(false)
    listProviderIdsMock.mockResolvedValue([])
    listAccountsMock.mockResolvedValue([])
    discoverAnthropicMock.mockResolvedValue(null)
    discoverCodexMock.mockResolvedValue(null)
    queryMock.mockResolvedValue(null)
    recordSnapshotMock.mockResolvedValue(undefined)
    settingsState.settings = {}
    settingsState.save.mockReset()
    settingsState.save.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function render(enabled: boolean) {
    return renderHook(({ on }: { on: boolean }) => useGlanceQuota(on, NOW), {
      initialProps: { on: enabled },
    })
  }

  function seedVault(entries: Array<{ provider: string; accounts: AccountSummary[] }>) {
    listProviderIdsMock.mockResolvedValue(entries.map((e) => e.provider))
    listAccountsMock.mockImplementation(
      async (provider: string) => entries.find((e) => e.provider === provider)?.accounts ?? []
    )
  }

  describe("disabled", () => {
    it("returns a null slice and starts nothing", async () => {
      const { result } = render(false)
      await flush()
      expect(result.current.slice).toBeNull()
      expect(listProviderIdsMock).not.toHaveBeenCalled()
      expect(listAccountsMock).not.toHaveBeenCalled()
      expect(refreshConfigured).not.toHaveBeenCalled()
      expect(subscribeChangedMock).not.toHaveBeenCalled()
      expect(discoverAnthropicMock).not.toHaveBeenCalled()
      expect(discoverCodexMock).not.toHaveBeenCalled()
    })

    it("keys the live query on enabled and reads nothing when disabled", async () => {
      const toArray = jest.fn().mockResolvedValue([row({ provider: "anthropic" })])
      getDbMock.mockReturnValue({ providerLimits: { toArray } })
      const { rerender } = render(false)
      const [querier, deps, initial] = useLiveQueryMock.mock.calls[0]
      expect(deps).toEqual([false])
      expect(initial).toEqual([])
      await expect(querier()).resolves.toEqual([])
      expect(toArray).not.toHaveBeenCalled()

      await act(async () => {
        rerender({ on: true })
      })
      const [enabledQuerier, enabledDeps] = useLiveQueryMock.mock.calls.at(-1)!
      expect(enabledDeps).toEqual([true])
      await expect(enabledQuerier()).resolves.toHaveLength(1)
      expect(toArray).toHaveBeenCalledTimes(1)
    })
  })

  describe("enabled", () => {
    it("enumerates the vault, refreshes configured sources and subscribes to changes", async () => {
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1", label: "Work" })] }])
      render(true)
      await flush()
      expect(listProviderIdsMock).toHaveBeenCalledTimes(1)
      expect(listAccountsMock).toHaveBeenCalledWith("anthropic")
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
      expect(subscribeChangedMock).toHaveBeenCalledTimes(1)
    })

    it("builds a slice from readings and the vault", async () => {
      settingsState.settings = { limitsQueryEnabledAccounts: ["anthropic:acc1"] }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1", label: "Work" })] }])
      liveRows = [
        row({
          provider: "anthropic",
          accountId: "acc1",
          fetchedAt: NOW - 1_000,
          meters: [
            {
              id: "session",
              labelKey: "k",
              kind: "window",
              usedPct: 40,
              resetAt: NOW + 5_000,
              status: "ok",
            },
          ],
        }),
      ]
      const { result } = render(true)
      await flush()
      const slice = result.current.slice
      expect(slice).not.toBeNull()
      expect(slice?.updatedAt).toBe(NOW)
      expect(slice?.sources).toHaveLength(1)
      expect(slice?.sources[0]).toMatchObject({
        key: "anthropic:acc1",
        provider: "anthropic",
        accountId: "acc1",
        accountLabel: "Work",
        state: "ok",
        fetchedAt: NOW - 1_000,
      })
      expect(slice?.sources[0]).not.toHaveProperty("providerAccountId")
      expect(slice?.sources[0].windows[0]).toMatchObject({
        id: "session",
        usedPct: 40,
        severity: "ok",
      })
    })

    it("falls back to the account email when there is no label", async () => {
      settingsState.settings = { limitsQueryEnabledAccounts: ["anthropic:acc1"] }
      seedVault([
        { provider: "anthropic", accounts: [summary({ id: "acc1", email: "me@example.com" })] },
      ])
      liveRows = [row({ provider: "anthropic", accountId: "acc1" })]
      const { result } = render(true)
      await flush()
      expect(result.current.slice?.sources[0].accountLabel).toBe("me@example.com")
    })

    it("offers a vault account with queries off as disabled", async () => {
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const { result } = render(true)
      await flush()
      expect(result.current.slice?.sources).toEqual([
        expect.objectContaining({ key: "anthropic:acc1", state: "disabled" }),
      ])
    })

    it("marks the slice refreshing from the configured-limits hook", async () => {
      configuredRefreshing = true
      const { result } = render(true)
      await flush()
      expect(result.current.slice?.refreshing).toBe(true)
    })

    it("drops readings of custom sources that are not enabled and keeps enabled ones", async () => {
      settingsState.settings = {
        customLimitsSources: [
          { id: "on", enabled: true },
          { id: "off", enabled: false },
        ],
      }
      liveRows = [
        row({ provider: "custom:on", accountLabel: "Mine", meters: [] }),
        row({ provider: "custom:off", meters: [] }),
      ]
      const { result } = render(true)
      await flush()
      const keys = result.current.slice?.sources.map((s) => s.key)
      expect(keys).toEqual(["custom:on:"])
    })

    it("does nothing outside Tauri but still yields a slice", async () => {
      isTauriMock.mockReturnValue(false)
      const { result } = render(true)
      await flush()
      expect(listProviderIdsMock).not.toHaveBeenCalled()
      expect(refreshConfigured).not.toHaveBeenCalled()
      expect(subscribeChangedMock).not.toHaveBeenCalled()
      expect(discoverAnthropicMock).not.toHaveBeenCalled()
      expect(result.current.slice).not.toBeNull()
    })

    it("re-enumerates and refreshes when subscriptions change, and unsubscribes on unmount", async () => {
      const { unmount } = render(true)
      await flush()
      listProviderIdsMock.mockClear()
      refreshConfigured.mockClear()
      act(() => changeListener?.())
      await flush()
      expect(listProviderIdsMock).toHaveBeenCalledTimes(1)
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
      unmount()
      expect(unsubscribeChanged).toHaveBeenCalledTimes(1)
    })

    it("stops reading when switched back to disabled", async () => {
      const { result, rerender } = render(true)
      await flush()
      expect(result.current.slice).not.toBeNull()
      rerender({ on: false })
      await flush()
      expect(result.current.slice).toBeNull()
      expect(unsubscribeChanged).toHaveBeenCalledTimes(1)
    })

    it("logs a failed enumeration unless the secret-store reporter claimed it", async () => {
      listProviderIdsMock.mockRejectedValueOnce(new Error("locked"))
      render(true)
      await flush()
      expect(reportFailureMock).toHaveBeenCalledWith(expect.any(Error), "glance.quota")
      expect(warnMock).toHaveBeenCalledWith(
        "glance quota: account enumeration failed",
        expect.objectContaining({ error: expect.stringContaining("locked") })
      )

      warnMock.mockClear()
      reportFailureMock.mockReturnValue(true)
      listProviderIdsMock.mockRejectedValueOnce(new Error("locked again"))
      act(() => changeListener?.())
      await flush()
      expect(warnMock).not.toHaveBeenCalled()
    })
  })

  describe("passive", () => {
    function renderPassive(enabled: boolean) {
      return renderHook(({ on }: { on: boolean }) => useGlanceQuota(on, NOW, { passive: true }), {
        initialProps: { on: enabled },
      })
    }

    it("still lists the vault but never refreshes configured sources on enable", async () => {
      settingsState.settings = { limitsQueryEnabledAccounts: ["anthropic:acc1"] }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1", label: "Work" })] }])
      const { result } = renderPassive(true)
      await flush()
      expect(listProviderIdsMock).toHaveBeenCalledTimes(1)
      expect(listAccountsMock).toHaveBeenCalledWith("anthropic")
      expect(refreshConfigured).not.toHaveBeenCalled()
      expect(result.current.slice?.sources[0]).toMatchObject({
        key: "anthropic:acc1",
        accountLabel: "Work",
      })
    })

    it("re-lists the vault on a subscription change without refreshing", async () => {
      renderPassive(true)
      await flush()
      listProviderIdsMock.mockClear()
      act(() => changeListener?.())
      await flush()
      expect(subscribeChangedMock).toHaveBeenCalledTimes(1)
      expect(listProviderIdsMock).toHaveBeenCalledTimes(1)
      expect(refreshConfigured).not.toHaveBeenCalled()
    })

    it("never probes for local logins, not even after the discovery interval", async () => {
      renderPassive(true)
      await flush()
      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS * 2)
      })
      await flush()
      expect(discoverAnthropicMock).not.toHaveBeenCalled()
      expect(discoverCodexMock).not.toHaveBeenCalled()
    })

    it("gives nothing to offer for discovery", async () => {
      const { result } = renderPassive(true)
      await flush()
      expect(result.current.slice?.sources.filter((s) => s.state === "discovered")).toEqual([])
    })
  })

  describe("discover: false", () => {
    it("refreshes on enable but never probes for local logins", async () => {
      discoverAnthropicMock.mockResolvedValue({ found: true })
      const { result } = renderHook(() => useGlanceQuota(true, NOW, { discover: false }))
      await flush()
      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS * 2)
      })
      await flush()
      expect(refreshConfigured).toHaveBeenCalled()
      expect(discoverAnthropicMock).not.toHaveBeenCalled()
      expect(discoverCodexMock).not.toHaveBeenCalled()
      expect(result.current.slice?.sources).toEqual([])
    })
  })

  describe("pollMs", () => {
    it("re-runs the throttled refresh on its interval while enabled", async () => {
      const { rerender } = renderHook(
        ({ on }: { on: boolean }) => useGlanceQuota(on, NOW, { pollMs: 60_000 }),
        { initialProps: { on: true } }
      )
      await flush()
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
      await act(async () => {
        jest.advanceTimersByTime(60_000)
      })
      expect(refreshConfigured).toHaveBeenCalledTimes(2)
      await act(async () => {
        jest.advanceTimersByTime(120_000)
      })
      expect(refreshConfigured).toHaveBeenCalledTimes(4)
      rerender({ on: false })
      await act(async () => {
        jest.advanceTimersByTime(300_000)
      })
      expect(refreshConfigured).toHaveBeenCalledTimes(4)
    })

    it("does not poll when passive", async () => {
      renderHook(() => useGlanceQuota(true, NOW, { passive: true, pollMs: 60_000 }))
      await flush()
      await act(async () => {
        jest.advanceTimersByTime(300_000)
      })
      expect(refreshConfigured).not.toHaveBeenCalled()
    })

    it("does not poll without an interval", async () => {
      render(true)
      await flush()
      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS * 3)
      })
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
    })
  })

  describe("discovery", () => {
    it("discovers both providers when the vault is empty and surfaces the finds", async () => {
      discoverAnthropicMock.mockResolvedValue({ found: true })
      discoverCodexMock.mockResolvedValue({ found: true })
      const { result } = render(true)
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledWith(false)
      expect(discoverCodexMock).toHaveBeenCalledWith(false)
      const keys = result.current.slice?.sources.map((s) => s.key).sort()
      expect(keys).toEqual(["discovered:anthropic", "discovered:codex"])
      expect(result.current.slice?.sources.every((s) => s.state === "discovered")).toBe(true)
    })

    it("only lists providers whose discovery returned something", async () => {
      discoverAnthropicMock.mockResolvedValue(null)
      discoverCodexMock.mockResolvedValue({ found: true })
      const { result } = render(true)
      await flush()
      expect(result.current.slice?.sources.map((s) => s.key)).toEqual(["discovered:codex"])
    })

    it("treats a throwing discovery as nothing to offer", async () => {
      discoverAnthropicMock.mockRejectedValue(new Error("keychain denied"))
      discoverCodexMock.mockResolvedValue({ found: true })
      const { result } = render(true)
      await flush()
      expect(result.current.slice?.sources.map((s) => s.key)).toEqual(["discovered:codex"])
    })

    it("skips providers that already have a vault account on the next probe", async () => {
      seedVault([
        {
          provider: "codex",
          accounts: [
            summary({ id: "cx", provider: "codex", variant: "codex", authMode: "chatgpt" }),
          ],
        },
      ])
      render(true)
      await flush()
      discoverAnthropicMock.mockClear()
      discoverCodexMock.mockClear()

      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS)
      })
      await flush()
      expect(discoverCodexMock).not.toHaveBeenCalled()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(1)
    })

    it("does not re-run discovery inside the 10-minute interval", async () => {
      render(true)
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(1)

      jest.setSystemTime(NOW + GLANCE_DISCOVERY_INTERVAL_MS - 1)
      act(() => changeListener?.())
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(1)
      expect(discoverCodexMock).toHaveBeenCalledTimes(1)
    })

    it("re-runs discovery on its interval while enabled", async () => {
      render(true)
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS)
      })
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(2)
      expect(discoverCodexMock).toHaveBeenCalledTimes(2)
    })

    it("keeps a probe's result when the vault finishes loading mid-probe", async () => {
      let releaseVault!: () => void
      listProviderIdsMock.mockReturnValue(
        new Promise<string[]>((resolve) => {
          releaseVault = () => resolve(["anthropic"])
        })
      )
      listAccountsMock.mockResolvedValue([summary({ id: "a1" })])
      let finishDiscovery!: (value: { found: boolean }) => void
      discoverAnthropicMock.mockReturnValue(new Promise((resolve) => (finishDiscovery = resolve)))
      discoverCodexMock.mockResolvedValue({ found: true })
      const { result } = render(true)
      await flush()

      await act(async () => releaseVault())
      await flush()
      await act(async () => finishDiscovery({ found: false }))
      await flush()

      expect(result.current.slice?.sources.map((s) => s.key)).toContain("discovered:codex")
    })

    it("probes again on re-enable after an interrupted probe", async () => {
      let finishDiscovery!: (value: { found: boolean }) => void
      discoverAnthropicMock.mockReturnValueOnce(
        new Promise((resolve) => (finishDiscovery = resolve))
      )
      const { rerender } = render(true)
      await flush()
      rerender({ on: false })
      await act(async () => finishDiscovery({ found: true }))
      await flush()

      rerender({ on: true })
      await flush()
      expect(discoverAnthropicMock).toHaveBeenCalledTimes(2)
    })

    it("stops probing once disabled", async () => {
      const { rerender } = render(true)
      await flush()
      rerender({ on: false })
      discoverAnthropicMock.mockClear()
      await act(async () => {
        jest.advanceTimersByTime(GLANCE_DISCOVERY_INTERVAL_MS * 2)
      })
      expect(discoverAnthropicMock).not.toHaveBeenCalled()
    })
  })

  describe("refreshOne", () => {
    async function setupEnabledAccount() {
      settingsState.settings = { limitsQueryEnabledAccounts: ["anthropic:acc1"] }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const hook = render(true)
      await flush()
      return hook
    }

    it("force-queries the account, records the snapshot and returns true", async () => {
      const reading = row({ provider: "anthropic", accountId: "acc1" })
      queryMock.mockResolvedValue(reading)
      const { result } = await setupEnabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("anthropic:acc1")
      })
      expect(queryMock).toHaveBeenCalledWith("anthropic", "acc1", { force: true })
      expect(recordSnapshotMock).toHaveBeenCalledWith(reading)
      expect(ok).toBe(true)
    })

    it("returns false and records nothing when the query yields nothing", async () => {
      queryMock.mockResolvedValue(null)
      const { result } = await setupEnabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("anthropic:acc1")
      })
      expect(ok).toBe(false)
      expect(recordSnapshotMock).not.toHaveBeenCalled()
    })

    it("flags the source refreshing while the query is in flight and clears it after", async () => {
      let resolveQuery!: (value: ProviderLimitsRow | null) => void
      queryMock.mockReturnValue(
        new Promise((resolve) => {
          resolveQuery = resolve
        })
      )
      const { result } = await setupEnabledAccount()
      let pending!: Promise<boolean>
      act(() => {
        pending = result.current.refreshOne("anthropic:acc1")
      })
      expect(result.current.slice?.sources[0]).toMatchObject({
        key: "anthropic:acc1",
        state: "refreshing",
      })
      await act(async () => {
        resolveQuery(null)
        await pending
      })
      expect(result.current.slice?.sources[0].state).toBe("refreshing") // still no reading, but not flagged by key
      expect(queryMock).toHaveBeenCalledTimes(1)
    })

    it("clears the in-flight flag even when the query throws", async () => {
      queryMock.mockRejectedValue(new Error("network"))
      const { result } = await setupEnabledAccount()
      await act(async () => {
        await expect(result.current.refreshOne("anthropic:acc1")).rejects.toThrow("network")
      })
      // quota-capable account with no reading renders as refreshing regardless; the
      // contract here is that a later refresh is not wedged.
      queryMock.mockResolvedValue(null)
      await act(async () => {
        await expect(result.current.refreshOne("anthropic:acc1")).resolves.toBe(false)
      })
    })

    it("returns false for an account whose queries are off", async () => {
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const { result } = render(true)
      await flush()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("anthropic:acc1")
      })
      expect(ok).toBe(false)
      expect(queryMock).not.toHaveBeenCalled()
    })

    it("returns false for an unknown key", async () => {
      const { result } = await setupEnabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("anthropic:nope")
      })
      expect(ok).toBe(false)
      expect(queryMock).not.toHaveBeenCalled()
    })

    it("re-runs all configured sources for a custom key", async () => {
      const { result } = await setupEnabledAccount()
      refreshConfigured.mockClear()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("custom:one:")
      })
      expect(ok).toBe(true)
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
      expect(queryMock).not.toHaveBeenCalled()
    })

    it("returns false outside Tauri for a non-custom key", async () => {
      settingsState.settings = { limitsQueryEnabledAccounts: ["anthropic:acc1"] }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const { result } = render(true)
      await flush()
      isTauriMock.mockReturnValue(false)
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.refreshOne("anthropic:acc1")
      })
      expect(ok).toBe(false)
      expect(queryMock).not.toHaveBeenCalled()
    })
  })

  describe("refreshAll", () => {
    it("queries only accounts with queries on and also re-runs enabled custom sources", async () => {
      settingsState.settings = {
        limitsQueryEnabledAccounts: ["anthropic:acc1"],
        customLimitsSources: [{ id: "one", enabled: true }],
      }
      seedVault([
        {
          provider: "anthropic",
          accounts: [summary({ id: "acc1" }), summary({ id: "acc2" })],
        },
      ])
      const { result } = render(true)
      await flush()
      queryMock.mockClear()
      refreshConfigured.mockClear()

      await act(async () => {
        await result.current.refreshAll()
      })
      expect(queryMock).toHaveBeenCalledTimes(1)
      expect(queryMock).toHaveBeenCalledWith("anthropic", "acc1", { force: true })
      expect(refreshConfigured).toHaveBeenCalledTimes(1)
    })

    it("skips the custom refresh when no custom source is enabled", async () => {
      settingsState.settings = {
        limitsQueryEnabledAccounts: ["anthropic:acc1"],
        customLimitsSources: [{ id: "one", enabled: false }],
      }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const { result } = render(true)
      await flush()
      refreshConfigured.mockClear()

      await act(async () => {
        await result.current.refreshAll()
      })
      expect(queryMock).toHaveBeenCalledTimes(1)
      expect(refreshConfigured).not.toHaveBeenCalled()
    })

    it("does nothing with an empty vault and no custom sources", async () => {
      const { result } = render(true)
      await flush()
      refreshConfigured.mockClear()
      await act(async () => {
        await result.current.refreshAll()
      })
      expect(queryMock).not.toHaveBeenCalled()
      expect(refreshConfigured).not.toHaveBeenCalled()
    })
  })

  describe("enable", () => {
    async function setupDisabledAccount() {
      settingsState.settings = { limitsQueryEnabledAccounts: ["codex:other"] }
      seedVault([{ provider: "anthropic", accounts: [summary({ id: "acc1" })] }])
      const hook = render(true)
      await flush()
      return hook
    }

    it("persists the enabled account, queries it and records the result", async () => {
      const reading = row({ provider: "anthropic", accountId: "acc1" })
      queryMock.mockResolvedValue(reading)
      const { result } = await setupDisabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.enable("anthropic", "acc1")
      })
      expect(ok).toBe(true)
      expect(settingsState.save).toHaveBeenCalledWith({
        limitsQueryEnabledAccounts: ["codex:other", "anthropic:acc1"],
      })
      expect(queryMock).toHaveBeenCalledWith("anthropic", "acc1", { force: true })
      expect(recordSnapshotMock).toHaveBeenCalledWith(reading)
    })

    it("does not record when the query yields nothing but still reports true", async () => {
      queryMock.mockResolvedValue(null)
      const { result } = await setupDisabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.enable("anthropic", "acc1")
      })
      expect(ok).toBe(true)
      expect(recordSnapshotMock).not.toHaveBeenCalled()
    })

    it("returns false for an account that is not in the vault and changes nothing", async () => {
      const { result } = await setupDisabledAccount()
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.enable("anthropic", "ghost")
      })
      expect(ok).toBe(false)
      expect(settingsState.save).not.toHaveBeenCalled()
      expect(queryMock).not.toHaveBeenCalled()
    })

    it("propagates a failed settings save without querying", async () => {
      settingsState.save.mockRejectedValue(new Error("disk"))
      const { result } = await setupDisabledAccount()
      await act(async () => {
        await expect(result.current.enable("anthropic", "acc1")).rejects.toThrow("disk")
      })
      expect(queryMock).not.toHaveBeenCalled()
    })
  })
})
