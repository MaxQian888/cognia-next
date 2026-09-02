"use client"

// Fires once on app boot. Three jobs, in order:
//
//  1. Install the budget-mirror sink on the canonical usage ledger, so every
//     committed turn snaps the in-memory mirror to the durable day total. This
//     must happen BEFORE anything can send, which is why it runs synchronously
//     in the effect body rather than after an await.
//  2. Hydrate that mirror from `providerCostDaily` so the routing engine's
//     dailyCostBudget check survives reloads.
//  3. Reconcile the projection once per schema generation (ADR-0165), then
//     prune usage/cost rows older than 90 days.
//
// Best-effort throughout: a failed hydration leaves the mirror at zero and
// budgets degrade to advisory-from-now. Boot is never blocked.

import { useEffect, useRef } from "react"

import {
  getTodaysCostByProvider,
  localDayString,
  pruneProviderCostOlderThan,
} from "@/lib/db/provider-cost-daily"
import { pruneSessionUsageOlderThan } from "@/lib/db/session-usage"
import {
  rebuildProviderCostDaily,
  setBudgetMirrorSink,
  USAGE_LEDGER_RECONCILE_MARKER,
} from "@/lib/usage/usage-ledger"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"

const COST_RETENTION_DAYS = 90

/**
 * Whether the one-time projection rebuild still owes this install a run.
 *
 * The marker is written only AFTER the rebuild transaction commits, so a crash
 * or a failed transaction leaves it unset and the next boot retries. Storage
 * being unavailable (private mode, a locked profile) reports "needed", which
 * costs one extra rebuild rather than silently skipping the repair.
 */
export function reconcileNeeded(storage: Pick<Storage, "getItem"> | null): boolean {
  if (!storage) return true
  try {
    return storage.getItem(USAGE_LEDGER_RECONCILE_MARKER) !== "1"
  } catch {
    return true
  }
}

export function markReconciled(storage: Pick<Storage, "setItem"> | null): void {
  if (!storage) return
  try {
    storage.setItem(USAGE_LEDGER_RECONCILE_MARKER, "1")
  } catch {
    // A failed marker write only costs a repeat rebuild next boot.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function ProviderCostMirrorInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    // (1) The ledger reconciles the mirror on every commit from here on.
    const disposeSink = setBudgetMirrorSink((committed) => {
      useProviderCostMirrorStore
        .getState()
        .reconcileProvider(committed.providerId, committed.day, committed.providerTotalUsd)
    })

    void (async () => {
      const storage = safeLocalStorage()
      // (3) before (2): a rebuild changes the very totals the mirror hydrates
      // from, so hydrating first would seed it with numbers the next few
      // milliseconds invalidate.
      if (reconcileNeeded(storage)) {
        try {
          await rebuildProviderCostDaily(COST_RETENTION_DAYS)
          markReconciled(storage)
        } catch {
          // Left unmarked on purpose. The next boot tries again.
        }
      }
      try {
        const totals = await getTodaysCostByProvider()
        useProviderCostMirrorStore.getState().hydrate(totals, localDayString())
      } catch {
        // Mirror stays at zero, so budgets stay advisory until the next commit.
      }
      void pruneProviderCostOlderThan(COST_RETENTION_DAYS).catch(() => {})
      void pruneSessionUsageOlderThan(COST_RETENTION_DAYS).catch(() => {})
    })()

    return disposeSink
  }, [])

  return null
}

export default ProviderCostMirrorInitializer
