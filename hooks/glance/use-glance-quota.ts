"use client"

/**
 * Main-window feed for the glance quota slice (ADR-0225 §5).
 *
 * Readings come from the persisted `providerLimits` table (a live query), not
 * from in-memory hook state, so the panel shows the last reading the moment it
 * opens and every refresh, from here or from the subscription page, lands in
 * the same place. While `enabled` (a visible consumer shows the quota module):
 *
 * - accounts are enumerated from the vault, without ever prompting;
 * - a coalesced refresh runs on enable, sharing the 5-minute throttle every
 *   other quota surface uses, so opening the panel repeatedly costs nothing;
 * - logins on this machine that are not in the vault are discovered, at most
 *   every 10 minutes, without a keychain prompt, and only for providers the
 *   vault has no account for.
 *
 * Disabled, the hook reads nothing and starts nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { loggers } from "@cognia/logging"
import { reportSecretStoreFailure } from "@/lib/credentials/secret-store-readiness"
import { getDb } from "@/lib/db/schema"
import { buildQuotaSlice, quotaKey, type GlanceVaultAccount } from "@/lib/glance/build-quota"
import type { GlanceQuotaSlice } from "@/lib/glance/snapshot"
import { discoverAnthropicAuth } from "@/lib/subscription/anthropic/discovery"
import { discoverCodexAuth } from "@/lib/subscription/codex/discovery"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { listAccounts, listSubscriptionProviderIds } from "@/lib/subscription/core/transport"
import { queryAccountLimitsCoalesced } from "@/lib/subscription/limits/coalesce"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"
import { isLimitsQueryEnabled, setLimitsQueryEnabled } from "@/lib/subscription/limits/policy"
import { recordLimitsSnapshot } from "@/lib/subscription/limits/store"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"
import type { AccountSummary, ProviderId, ProviderLimitsRow } from "@/types/subscription"

export const GLANCE_DISCOVERY_INTERVAL_MS = 10 * 60_000

/** Providers whose local login can be discovered without adopting it. */
const DISCOVERABLE: ReadonlyArray<{ provider: ProviderId; discover: () => Promise<unknown> }> = [
  { provider: "anthropic" as ProviderId, discover: () => discoverAnthropicAuth(false) },
  { provider: "codex" as ProviderId, discover: () => discoverCodexAuth(false) },
]

/**
 * A quota source is known to apply to this account: the windowed sources
 * (Claude subscription OAuth, a ChatGPT-login Codex account). Other accounts
 * qualify once they have produced a reading at least once.
 */
export function isQuotaCapable(summary: Pick<AccountSummary, "variant" | "authMode">): boolean {
  if (summary.variant === "anthropic") return true
  return summary.variant === "codex" && summary.authMode === "chatgpt"
}

interface VaultEntry {
  provider: string
  providerAccountId: string
  accountLabel: string | null
  quotaCapable: boolean
}

async function listVault(): Promise<VaultEntry[]> {
  const providers = await listSubscriptionProviderIds()
  const out: VaultEntry[] = []
  for (const provider of providers) {
    const summaries = await listAccounts(provider)
    for (const summary of summaries) {
      out.push({
        provider,
        providerAccountId: summary.id,
        accountLabel: summary.label ?? summary.email ?? null,
        quotaCapable: isQuotaCapable(summary),
      })
    }
  }
  return out
}

/** Newest reading and newest error-free reading per key. */
export function foldReadings(rows: readonly ProviderLimitsRow[]): {
  latest: Map<string, ProviderLimitsRow>
  lastGood: Map<string, ProviderLimitsRow>
  custom: ProviderLimitsRow[]
} {
  const latest = new Map<string, ProviderLimitsRow>()
  const lastGood = new Map<string, ProviderLimitsRow>()
  const customLatest = new Map<string, ProviderLimitsRow>()
  for (const row of rows) {
    if (row.provider.startsWith("custom:")) {
      const key = quotaKey(row.provider, row.accountId)
      const prev = customLatest.get(key)
      if (!prev || row.fetchedAt > prev.fetchedAt) customLatest.set(key, row)
      continue
    }
    const key = quotaKey(row.provider, row.accountId)
    const prev = latest.get(key)
    if (!prev || row.fetchedAt > prev.fetchedAt) latest.set(key, row)
    if (!row.error) {
      const good = lastGood.get(key)
      if (!good || row.fetchedAt > good.fetchedAt) lastGood.set(key, row)
    }
  }
  return { latest, lastGood, custom: [...customLatest.values()] }
}

export interface UseGlanceQuotaResult {
  slice: GlanceQuotaSlice | null
  /** Re-query every enabled account, forced (the 30 s floor still applies). */
  refreshAll: () => Promise<void>
  /** Re-query one source by its slice key. */
  refreshOne: (key: string) => Promise<boolean>
  /** Turn quota queries on for one vault account, then query it. */
  enable: (provider: string, providerAccountId: string) => Promise<boolean>
}

export interface UseGlanceQuotaOptions {
  /** Read the table and the vault only: no refreshes, no discovery. */
  passive?: boolean
  /**
   * Look for logins on this machine that are not in the vault. On by default
   * (unless passive). A surface that only draws queried sources, like the
   * Capacity Dock, turns it off: it would probe a keychain for rows it never
   * shows.
   */
  discover?: boolean
  /**
   * Re-run the throttled refresh on this interval while enabled. For a
   * surface that stays on screen for hours (the Capacity Dock); a panel that
   * opens and closes refreshes on open instead. The shared throttle still
   * applies, so a short interval cannot query a provider more often than any
   * other quota surface would.
   */
  pollMs?: number
}

export function useGlanceQuota(
  enabled: boolean,
  now: number,
  { passive = false, discover = !passive, pollMs }: UseGlanceQuotaOptions = {}
): UseGlanceQuotaResult {
  const enabledAccounts = useSettingsStore((s) => s.settings?.limitsQueryEnabledAccounts)
  const customSources = useSettingsStore((s) => s.settings?.customLimitsSources)
  const { refresh: refreshConfigured, refreshing } = useAllConfiguredLimits()

  const [vault, setVault] = useState<VaultEntry[]>([])
  const [discovered, setDiscovered] = useState<string[]>([])
  const [refreshingKeys, setRefreshingKeys] = useState<ReadonlySet<string>>(new Set())
  const lastDiscoveryAt = useRef(0)

  const rows = useLiveQuery<ProviderLimitsRow[], ProviderLimitsRow[]>(
    async () => (enabled ? getDb().providerLimits.toArray() : []),
    [enabled],
    []
  )

  // Enumerate + refresh on enable, and again whenever accounts change. A
  // newer enumeration supersedes an older one still in flight.
  useEffect(() => {
    if (!enabled || !isTauri()) return
    let generation = 0
    let disposed = false
    const loadVault = () => {
      const mine = ++generation
      listVault().then(
        (entries) => {
          if (!disposed && mine === generation) setVault(entries)
        },
        (error: unknown) => {
          // A locked secret store is reported once, centrally; the unlock
          // fires a subscription change and this re-runs.
          if (!reportSecretStoreFailure(error, "glance.quota")) {
            loggers.tray?.warn?.("glance quota: account enumeration failed", {
              error: String(error),
            })
          }
        }
      )
    }
    loadVault()
    if (!passive) void refreshConfigured()
    const unsubscribe = subscribeSubscriptionChanged(() => {
      loadVault()
      if (!passive) void refreshConfigured()
    })
    const poll =
      !passive && pollMs !== undefined && pollMs > 0
        ? setInterval(() => void refreshConfigured(), pollMs)
        : null
    return () => {
      disposed = true
      unsubscribe()
      if (poll) clearInterval(poll)
    }
  }, [enabled, passive, pollMs, refreshConfigured])

  // Discovery, gated: only providers the vault has nothing for, at most every
  // 10 minutes, never with a keychain prompt. The vault is read through a ref
  // at probe time rather than being a dependency: the vault often finishes
  // loading while a probe is in flight, and re-running then would cancel that
  // probe and, inside the interval, never start another. A provider the vault
  // gained meanwhile is filtered out again when the slice is built.
  const vaultProviders = useMemo(() => new Set(vault.map((v) => v.provider)), [vault])
  const vaultProvidersRef = useRef(vaultProviders)
  useEffect(() => {
    vaultProvidersRef.current = vaultProviders
  }, [vaultProviders])
  useEffect(() => {
    if (!enabled || passive || !discover || !isTauri()) return
    let cancelled = false
    const probe = async () => {
      if (Date.now() - lastDiscoveryAt.current < GLANCE_DISCOVERY_INTERVAL_MS) return
      lastDiscoveryAt.current = Date.now()
      const found: string[] = []
      for (const { provider, discover } of DISCOVERABLE) {
        if (vaultProvidersRef.current.has(provider)) continue
        try {
          if (await discover()) found.push(provider)
        } catch {
          // Discovery is best-effort: a missing file or a denied keychain read
          // simply means there is nothing to offer.
        }
        if (cancelled) return
      }
      if (!cancelled) setDiscovered(found)
    }
    void probe()
    const timer = setInterval(() => void probe(), GLANCE_DISCOVERY_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      // An interrupted probe never landed, so the next enable probes again.
      lastDiscoveryAt.current = 0
    }
  }, [enabled, passive, discover])

  const markRefreshing = useCallback((key: string, on: boolean) => {
    setRefreshingKeys((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const refreshOne = useCallback(
    async (key: string): Promise<boolean> => {
      const entry = vault.find((v) => quotaKey(v.provider, v.providerAccountId) === key)
      if (!entry || !isTauri()) {
        // Custom sources have no per-source entry point; re-run them all.
        if (key.startsWith("custom:")) {
          await refreshConfigured()
          return true
        }
        return false
      }
      if (
        !isLimitsQueryEnabled(
          enabledAccounts,
          entry.provider as ProviderId,
          entry.providerAccountId
        )
      ) {
        return false
      }
      markRefreshing(key, true)
      try {
        const result = await queryAccountLimitsCoalesced(
          entry.provider as ProviderId,
          entry.providerAccountId,
          { force: true }
        )
        if (result) await recordLimitsSnapshot(result)
        return result !== null
      } finally {
        markRefreshing(key, false)
      }
    },
    [vault, enabledAccounts, markRefreshing, refreshConfigured]
  )

  const refreshAll = useCallback(async () => {
    const keys = vault
      .filter((v) =>
        isLimitsQueryEnabled(enabledAccounts, v.provider as ProviderId, v.providerAccountId)
      )
      .map((v) => quotaKey(v.provider, v.providerAccountId))
    await Promise.all(keys.map((key) => refreshOne(key)))
    if ((customSources ?? []).some((source) => source.enabled)) await refreshConfigured()
  }, [vault, enabledAccounts, customSources, refreshOne, refreshConfigured])

  const enable = useCallback(
    async (provider: string, providerAccountId: string): Promise<boolean> => {
      const entry = vault.find(
        (v) => v.provider === provider && v.providerAccountId === providerAccountId
      )
      if (!entry) return false
      const current = useSettingsStore.getState().settings?.limitsQueryEnabledAccounts
      await useSettingsStore.getState().save({
        limitsQueryEnabledAccounts: setLimitsQueryEnabled(
          current,
          provider as ProviderId,
          providerAccountId,
          true
        ),
      })
      const key = quotaKey(provider, providerAccountId)
      markRefreshing(key, true)
      try {
        const result = await queryAccountLimitsCoalesced(
          provider as ProviderId,
          providerAccountId,
          {
            force: true,
          }
        )
        if (result) await recordLimitsSnapshot(result)
      } finally {
        markRefreshing(key, false)
      }
      return true
    },
    [vault, markRefreshing]
  )

  const slice = useMemo<GlanceQuotaSlice | null>(() => {
    if (!enabled) return null
    const { latest, lastGood, custom } = foldReadings(rows)
    const accounts: GlanceVaultAccount[] = vault.map((v) => ({
      provider: v.provider,
      providerAccountId: v.providerAccountId,
      accountLabel: v.accountLabel,
      queryEnabled: isLimitsQueryEnabled(
        enabledAccounts,
        v.provider as ProviderId,
        v.providerAccountId
      ),
      quotaCapable: v.quotaCapable,
    }))
    const enabledCustom = new Set(
      (customSources ?? []).filter((s) => s.enabled).map((s) => `custom:${s.id}`)
    )
    return buildQuotaSlice({
      accounts,
      latest,
      lastGood,
      custom: custom.filter((reading) => enabledCustom.has(reading.provider)),
      discovered,
      refreshingKeys,
      refreshing,
      now,
    })
  }, [
    enabled,
    rows,
    vault,
    enabledAccounts,
    customSources,
    discovered,
    refreshingKeys,
    refreshing,
    now,
  ])

  return { slice, refreshAll, refreshOne, enable }
}
