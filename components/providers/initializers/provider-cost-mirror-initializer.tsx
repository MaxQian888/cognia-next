"use client"

// Fires once on app boot. Hydrates the in-memory daily-spend mirror from the
// durable `providerCostDaily` rollup so the routing engine's dailyCostBudget
// check survives reloads, then prunes usage/cost rows older than 90 days.
// Best-effort: a failed hydration just leaves the mirror at zero (budgets
// degrade to advisory-from-now, never block boot).

import { useEffect, useRef } from "react"

import {
  getTodaysCostByProvider,
  localDayString,
  pruneProviderCostOlderThan,
} from "@/lib/db/provider-cost-daily"
import { pruneSessionUsageOlderThan } from "@/lib/db/session-usage"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"

const COST_RETENTION_DAYS = 90

export function ProviderCostMirrorInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    void getTodaysCostByProvider()
      .then((totals) => {
        useProviderCostMirrorStore.getState().hydrate(totals, localDayString())
      })
      .catch(() => {})
    void pruneProviderCostOlderThan(COST_RETENTION_DAYS).catch(() => {})
    void pruneSessionUsageOlderThan(COST_RETENTION_DAYS).catch(() => {})
  }, [])

  return null
}

export default ProviderCostMirrorInitializer
