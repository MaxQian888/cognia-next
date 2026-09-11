"use client"

/**
 * Assembles the provider list rows and the diagnostic badges that decorate
 * them.
 *
 * Pulled out of `provider-settings.tsx`, where one 95-line `useMemo` sat
 * between two Dexie live queries and three pieces of filter state, so nothing
 * about row derivation could be read or tested without mounting the whole
 * 1800-line settings pane.
 */

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type { ProviderHealth } from "@/hooks/ai/use-provider-manager"
import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"
import { getLastUsedByProvider } from "@/lib/db/provider-cost-daily"
import {
  queryLatestProviderDiagnosticSamples,
  queryLatestProviderModelDiagnosticSamples,
} from "@/lib/provider-diagnostics/store"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"

import { getBuiltInProviderReadiness, getCustomProviderReadiness } from "./provider-readiness"
import type {
  ProviderConnectionStatus,
  ProviderDiagnosticBadgeStatus,
} from "./provider-sidebar-item"
import {
  deriveStatus,
  isLocalEngineConfigured,
  providerMatchesCategory,
  sortProviderRows,
  type ProviderSortBy,
} from "./provider-status-utils"

/** A diagnostic sample older than this reads as "stale" in the list. */
export const DIAGNOSTIC_STALE_MS = 2 * 60 * 60_000

export interface ProviderRow {
  id: string
  name: string
  subtitle: string
  status: ProviderConnectionStatus
  isCustom: boolean
  modelCount?: number
  diagnosticStatus?: ProviderDiagnosticBadgeStatus
  lastUsedAt?: number
}

export function diagnosticBadge(
  sample: { status: string; startedAt: number; completedAt?: number } | undefined,
  now: number
): ProviderDiagnosticBadgeStatus | undefined {
  if (!sample) return undefined
  if (now - (sample.completedAt ?? sample.startedAt) > DIAGNOSTIC_STALE_MS) return "stale"
  return sample.status === "completed" ? "passed" : "failed"
}

type VerificationOutcome =
  "verified" | "failed" | "limited" | "success" | "error" | null | undefined

/**
 * Live health from the provider manager outranks the stored test result, but
 * only once it has actually seen traffic. A provider with zero requests this
 * session carries no evidence, so the persisted outcome stands.
 */
export function preferLiveHealth(
  health: ProviderHealth | undefined,
  fallbackOk: boolean | undefined,
  fallbackOutcome: VerificationOutcome
): { ok: boolean | undefined; outcome: VerificationOutcome } {
  if (!health || health.totalRequests === 0) {
    return { ok: fallbackOk, outcome: fallbackOutcome }
  }
  if (health.status === "healthy") return { ok: true, outcome: "verified" }
  if (health.status === "degraded") return { ok: undefined, outcome: "limited" }
  if (health.status === "error") return { ok: false, outcome: "failed" }
  return { ok: fallbackOk, outcome: fallbackOutcome }
}

export interface UseProviderRowsOptions {
  settings: UseProviderSettingsResult
  liveProviderHealth: Record<string, ProviderHealth>
  search: string
  categoryFilter: string
  sortBy: ProviderSortBy
}

export interface UseProviderRowsResult {
  rows: ProviderRow[]
  /** Per-model badges for the selected provider's Models tab. */
  modelDiagnosticBadges: Record<string, ProviderDiagnosticBadgeStatus>
}

export function useProviderRows({
  settings: s,
  liveProviderHealth,
  search,
  categoryFilter,
  sortBy,
}: UseProviderRowsOptions): UseProviderRowsResult {
  // Provider-level diagnostic badges: latest sample per provider, read through
  // the `[providerId+startedAt]` index (one `last()` per provider) instead of
  // scanning the whole samples table on every change.
  const latestDiagnosticByProvider = useLiveQuery(
    () =>
      queryLatestProviderDiagnosticSamples().catch(
        () => new Map<string, ProviderDiagnosticSample>()
      ),
    []
  )
  const selectedProviderIdForDiagnostics = s.selectedProviderId
  // Model-level badges are only shown for the selected provider's Models tab,
  // so only that provider's rows are read.
  const latestDiagnosticByModel = useLiveQuery(
    (): Promise<Map<string, ProviderDiagnosticSample>> =>
      selectedProviderIdForDiagnostics
        ? queryLatestProviderModelDiagnosticSamples(selectedProviderIdForDiagnostics).catch(
            () => new Map<string, ProviderDiagnosticSample>()
          )
        : Promise.resolve(new Map<string, ProviderDiagnosticSample>()),
    [selectedProviderIdForDiagnostics]
  )
  // "Stale" is a function of wall-clock time. Re-evaluate only when a fresh
  // badge could actually cross the 2h line, at that exact moment, rather than
  // ticking every minute for the life of the page.
  const [diagnosticNow, setDiagnosticNow] = useState(() => Date.now())
  useEffect(() => {
    if (!latestDiagnosticByProvider) return
    let nextFlip = Number.POSITIVE_INFINITY
    for (const sample of latestDiagnosticByProvider.values()) {
      const at = (sample.completedAt ?? sample.startedAt) + DIAGNOSTIC_STALE_MS
      if (at > diagnosticNow && at < nextFlip) nextFlip = at
    }
    if (!Number.isFinite(nextFlip)) return
    const timer = window.setTimeout(
      () => setDiagnosticNow(Date.now()),
      Math.max(1_000, nextFlip - diagnosticNow + 50)
    )
    return () => window.clearTimeout(timer)
  }, [latestDiagnosticByProvider, diagnosticNow])

  const providerDiagnosticBadges = useMemo(() => {
    const out = new Map<string, ProviderDiagnosticBadgeStatus>()
    for (const [providerId, sample] of latestDiagnosticByProvider ?? []) {
      const badge = diagnosticBadge(sample, diagnosticNow)
      if (badge) out.set(providerId, badge)
    }
    return out
  }, [diagnosticNow, latestDiagnosticByProvider])

  const modelDiagnosticBadges = useMemo(() => {
    const out: Record<string, ProviderDiagnosticBadgeStatus> = {}
    for (const [modelId, sample] of latestDiagnosticByModel ?? []) {
      const badge = diagnosticBadge(sample, diagnosticNow)
      if (badge && modelId) out[modelId] = badge
    }
    return out
  }, [diagnosticNow, latestDiagnosticByModel])

  // "Recently used" reads the durable cost rollup (one row per provider/model/
  // day) and is only subscribed while that sort is active.
  const lastUsedByProvider = useLiveQuery(
    (): Promise<Record<string, number> | undefined> =>
      sortBy === "lastUsed"
        ? getLastUsedByProvider().catch((): Record<string, number> => ({}))
        : Promise.resolve(undefined),
    [sortBy]
  )

  const rows = useMemo<ProviderRow[]>(() => {
    const q = search.trim().toLowerCase()
    const builtIn = s.filteredProviders
      .filter(([id, cfg]) => {
        if (categoryFilter === "custom") return false
        if (categoryFilter !== "all" && !providerMatchesCategory(categoryFilter, id)) return false
        if (!q) return true
        return id.toLowerCase().includes(q) || cfg.name.toLowerCase().includes(q)
      })
      .map(([id, cfg]) => {
        const providerSettings = (s.readinessProviderSettings ?? s.providerSettings)[id]
        const test = s.testResults[id]
        const effectiveTest = preferLiveHealth(liveProviderHealth[id], test?.success, test?.outcome)
        // Readiness re-derives the verification status from the persisted
        // fingerprint, so a key rotated after the last successful test reads
        // "stale" instead of the frozen persisted "verified".
        const verificationStatus = getBuiltInProviderReadiness(
          id,
          providerSettings,
          null
        ).verificationStatus
        return {
          id,
          name: cfg.name,
          subtitle: providerSettings?.defaultModel ?? cfg.defaultModel,
          status: deriveStatus(
            providerSettings?.apiKey,
            providerSettings?.baseURL,
            effectiveTest.ok,
            effectiveTest.outcome,
            (id === "bedrock" && !!providerSettings?.bedrock
              ? validateBedrockConnectionSettings(providerSettings.bedrock).valid
              : false) || isLocalEngineConfigured(id, providerSettings),
            verificationStatus
          ),
          isCustom: false,
          modelCount: cfg.models.length,
          diagnosticStatus: providerDiagnosticBadges.get(id),
          lastUsedAt: lastUsedByProvider?.[id],
        }
      })

    const custom: ProviderRow[] = []
    for (const id of s.visibleCustomProviderIds) {
      const cp = (s.readinessCustomProviders ?? s.customProviders)[id]
      if (!cp) continue
      if (categoryFilter !== "all" && categoryFilter !== "custom") continue
      if (q && !cp.customName.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) {
        continue
      }
      const testOutcome = s.customTestResults[id]
      const testOk = testOutcome === "success" ? true : testOutcome === "error" ? false : undefined
      const effectiveTest = preferLiveHealth(liveProviderHealth[id], testOk, testOutcome)
      const verificationStatus = getCustomProviderReadiness(cp, undefined).verificationStatus
      custom.push({
        id,
        name: cp.customName,
        subtitle: cp.defaultModel ?? cp.baseURL,
        status: deriveStatus(
          cp.apiKey,
          cp.baseURL,
          effectiveTest.ok,
          effectiveTest.outcome,
          false,
          verificationStatus
        ),
        isCustom: true,
        modelCount: cp.customModels?.length ?? 0,
        diagnosticStatus: providerDiagnosticBadges.get(id),
        lastUsedAt: lastUsedByProvider?.[id],
      })
    }

    // Built-ins keep the catalog order for `name`, and custom rows follow. Any
    // other sort interleaves both groups: a connected custom endpoint belongs
    // above an unconfigured built-in when sorting by status.
    return sortBy === "name"
      ? [...builtIn, ...custom]
      : sortProviderRows([...builtIn, ...custom], sortBy)
  }, [
    s.filteredProviders,
    s.providerSettings,
    s.readinessProviderSettings,
    s.testResults,
    s.visibleCustomProviderIds,
    s.customProviders,
    s.readinessCustomProviders,
    s.customTestResults,
    liveProviderHealth,
    search,
    categoryFilter,
    providerDiagnosticBadges,
    lastUsedByProvider,
    sortBy,
  ])

  return { rows, modelDiagnosticBadges }
}
