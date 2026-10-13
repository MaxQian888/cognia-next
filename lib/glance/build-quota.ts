/**
 * Quota slice (ADR-0225 §5): every quota source the user has, in one
 * vocabulary, honest about how old and how complete each reading is.
 *
 * Three populations feed it:
 *
 * 1. Enabled vault accounts and custom sources: their newest reading decides
 *    the state; an errored reading keeps the last good meters on screen and
 *    says so; a reading past the freshness window is `stale`, not current.
 * 2. Vault accounts with quota queries off (`disabled`), when a quota source
 *    is known to apply. Enabling is the settings toggle the subscription page
 *    already exposes, so the panel may offer it inline.
 * 3. Logins found on this machine but never adopted (`discovered`). Adopting
 *    writes credentials into the vault, which is the subscription page's job,
 *    so the panel routes there instead of acting.
 */

import { redactText } from "@cognia/redact"

import { truncateLine } from "@/lib/fleet/format"
import { LIMITS_QUERY_MIN_INTERVAL_MS } from "@/lib/subscription/limits/coalesce"
import type { LimitsMeter, LimitsMeterStatus, ProviderLimits } from "@/types/subscription"

import type {
  GlanceQuotaSlice,
  GlanceQuotaSource,
  GlanceQuotaState,
  GlanceQuotaWindow,
} from "./snapshot"

/**
 * A reading older than this is `stale`. Three automatic query intervals: the
 * panel refreshes on open, so a reading this old means refreshes have been
 * failing silently or the source stopped answering, not that the user simply
 * opened the panel between two scheduled queries.
 */
export const GLANCE_QUOTA_STALE_MS = 3 * LIMITS_QUERY_MIN_INTERVAL_MS

const ERROR_MAX = 160

export interface GlanceVaultAccount {
  provider: string
  providerAccountId: string
  accountLabel: string | null
  /** Quota queries are on for this account (`limitsQueryEnabledAccounts`). */
  queryEnabled: boolean
  /** A quota source is known to apply, so enabling queries yields meters. */
  quotaCapable: boolean
}

export interface BuildQuotaSliceInput {
  accounts: readonly GlanceVaultAccount[]
  /** Newest reading per `${provider}:${providerAccountId}`, errored or not. */
  latest: ReadonlyMap<string, ProviderLimits>
  /** Newest reading WITHOUT an error per key, for the meters behind an error. */
  lastGood: ReadonlyMap<string, ProviderLimits>
  /** Custom sources' readings; they have no vault account. */
  custom: readonly ProviderLimits[]
  /** Providers with a local login that is not in the vault. */
  discovered: readonly string[]
  /** Keys with a query in flight. */
  refreshingKeys: ReadonlySet<string>
  refreshing: boolean
  now: number
}

export function quotaKey(provider: string, providerAccountId: string | null | undefined): string {
  return `${provider}:${providerAccountId ?? ""}`
}

function severityOf(status: LimitsMeterStatus): GlanceQuotaWindow["severity"] {
  return status
}

function windowOf(meter: LimitsMeter): GlanceQuotaWindow {
  return {
    id: meter.id,
    labelKey: meter.labelKey ?? null,
    label: meter.label ?? null,
    kind: meter.kind,
    usedPct: meter.usedPct,
    resetAt: meter.resetAt ?? null,
    remaining: meter.remaining ?? null,
    unit: meter.unit ?? null,
    currency: meter.currency ?? null,
    severity: severityOf(meter.status),
  }
}

/** The state a reading earns by its worst meter. */
function stateOfMeters(windows: readonly GlanceQuotaWindow[]): GlanceQuotaState {
  if (windows.some((w) => w.severity === "exceeded")) return "exhausted"
  if (windows.some((w) => w.severity === "warn" || w.severity === "crit")) return "warn"
  return "ok"
}

function safeError(message: string): string {
  return truncateLine(redactText(message).redacted, ERROR_MAX)
}

/** One source from its newest reading and its last good one. */
function fromReading(
  key: string,
  provider: string,
  providerAccountId: string | null,
  accountLabel: string | null,
  latest: ProviderLimits | undefined,
  lastGood: ProviderLimits | undefined,
  refreshing: boolean,
  now: number
): GlanceQuotaSource {
  if (!latest) {
    return {
      key,
      provider,
      accountId: providerAccountId,
      accountLabel,
      state: "refreshing",
      windows: [],
      fetchedAt: null,
      error: null,
    }
  }
  if (latest.error) {
    const good = lastGood && !lastGood.error ? lastGood : undefined
    return {
      key,
      provider,
      accountId: providerAccountId,
      accountLabel: accountLabel ?? latest.accountLabel ?? null,
      state: refreshing && !good ? "refreshing" : "error",
      windows: (good?.meters ?? []).map(windowOf),
      fetchedAt: good?.fetchedAt ?? null,
      error: safeError(latest.error),
    }
  }
  const windows = latest.meters.map(windowOf)
  const stale = now - latest.fetchedAt > GLANCE_QUOTA_STALE_MS
  return {
    key,
    provider,
    accountId: providerAccountId,
    accountLabel: accountLabel ?? latest.accountLabel ?? null,
    state: stale ? "stale" : stateOfMeters(windows),
    windows,
    fetchedAt: latest.fetchedAt,
    error: null,
  }
}

const STATE_RANK: Record<GlanceQuotaState, number> = {
  exhausted: 0,
  error: 1,
  warn: 2,
  stale: 3,
  ok: 4,
  refreshing: 5,
  disabled: 6,
  discovered: 7,
}

export function buildQuotaSlice(input: BuildQuotaSliceInput): GlanceQuotaSlice {
  const sources: GlanceQuotaSource[] = []

  for (const account of input.accounts) {
    const key = quotaKey(account.provider, account.providerAccountId)
    if (!account.queryEnabled) {
      if (!account.quotaCapable && !input.lastGood.has(key)) continue
      sources.push({
        key,
        provider: account.provider,
        accountId: account.providerAccountId,
        accountLabel: account.accountLabel,
        state: "disabled",
        windows: [],
        fetchedAt: null,
        error: null,
      })
      continue
    }
    const latest = input.latest.get(key)
    // An enabled account with no reading and no source never produces one.
    // Showing it as "refreshing" forever would be a lie, so it is left out
    // until a query actually returns something.
    if (!latest && !input.refreshingKeys.has(key) && !account.quotaCapable) continue
    sources.push(
      fromReading(
        key,
        account.provider,
        account.providerAccountId,
        account.accountLabel,
        latest,
        input.lastGood.get(key),
        input.refreshingKeys.has(key),
        input.now
      )
    )
  }

  for (const reading of input.custom) {
    const provider = reading.sourceId ?? reading.provider
    const key = quotaKey(provider, reading.accountId ?? null)
    sources.push(
      fromReading(
        key,
        provider,
        reading.accountId ?? null,
        reading.accountLabel ?? null,
        reading,
        reading.error ? undefined : reading,
        false,
        input.now
      )
    )
  }

  const inVault = new Set(input.accounts.map((a) => a.provider))
  for (const provider of input.discovered) {
    if (inVault.has(provider)) continue
    sources.push({
      key: `discovered:${provider}`,
      provider,
      accountId: null,
      accountLabel: null,
      state: "discovered",
      windows: [],
      fetchedAt: null,
      error: null,
    })
  }

  // Most urgent first; ties keep enumeration order (Array.prototype.sort is stable).
  sources.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])

  return { updatedAt: input.now, refreshing: input.refreshing, sources }
}
