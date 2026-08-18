"use client"

/**
 * In-memory mirror of today's per-provider spend (USD).
 *
 * The routing engine needs a SYNCHRONOUS read of today's spend to enforce
 * `ProviderConstraint.dailyCostBudget` without awaiting Dexie on the send hot
 * path. The mirror is hydrated once at boot from the durable rollup table
 * (`lib/db/provider-cost-daily.ts` via `provider-cost-mirror-initializer`),
 * then incremented in memory by `recordProviderOutcome` alongside the
 * fire-and-forget Dexie write. Day rollover is handled lazily on each write
 * (an app left running past local midnight resets itself).
 *
 * The optimistic in-memory add and the durable write can disagree: if the app
 * dies between them the spend is counted here but absent from the rollup (and
 * vanishes on the next boot hydration); if the write rejects, it is counted here
 * and never persisted. So the mirror does not stay optimistic — the caller feeds
 * the committed provider total back through {@link ProviderCostMirrorStore.reconcileProvider}
 * (snapping the mirror to durable truth) or reverses the optimistic add through
 * `rollbackCost` when the write failed outright. Dexie is the authority; this is
 * a cache that converges on it after every turn.
 */

import { create } from "zustand"

import { localDayString } from "@/lib/db/provider-cost-daily"

interface ProviderCostMirrorStore {
  /** The local day ("YYYY-MM-DD") the totals belong to. */
  day: string
  /** Today's spend per provider in USD. */
  totalsByProvider: Record<string, number>
  /** Replace the totals wholesale (boot hydration from Dexie). */
  hydrate: (totals: Record<string, number>, day: string) => void
  /** Add one turn's cost; lazily resets when the local day changed. */
  addCost: (providerId: string, costUsd: number, now?: number) => void
  /**
   * Reverse an optimistic {@link addCost} whose durable write never landed.
   * Clamped at 0 — an over-rollback must not make the mirror under-report.
   */
  rollbackCost: (providerId: string, costUsd: number, now?: number) => void
  /**
   * Snap one provider's total to the value committed to Dexie. Ignored when the
   * committed day is not the mirror's current day (a turn that landed just
   * before local midnight must not resurrect yesterday's spend into today).
   */
  reconcileProvider: (providerId: string, day: string, totalUsd: number) => void
  /** Synchronous O(1) read for the routing engine. Unknown provider = 0. */
  getTodaySpend: (providerId: string) => number
  reset: () => void
}

export const useProviderCostMirrorStore = create<ProviderCostMirrorStore>((set, get) => ({
  day: "",
  totalsByProvider: {},

  hydrate: (totals, day) => set({ totalsByProvider: { ...totals }, day }),

  addCost: (providerId, costUsd, now) => {
    if (!providerId || !Number.isFinite(costUsd) || costUsd <= 0) return
    const today = localDayString(now)
    set((s) => {
      const totals = s.day === today ? s.totalsByProvider : {}
      return {
        day: today,
        totalsByProvider: {
          ...totals,
          [providerId]: (totals[providerId] ?? 0) + costUsd,
        },
      }
    })
  },

  rollbackCost: (providerId, costUsd, now) => {
    if (!providerId || !Number.isFinite(costUsd) || costUsd <= 0) return
    const today = localDayString(now)
    set((s) => {
      // A rollback for a day the mirror has already rolled past is a no-op:
      // those totals are gone and yesterday's failure cannot affect today.
      if (s.day !== today) return s
      const current = s.totalsByProvider[providerId]
      if (current === undefined) return s
      return {
        ...s,
        totalsByProvider: {
          ...s.totalsByProvider,
          [providerId]: Math.max(0, current - costUsd),
        },
      }
    })
  },

  reconcileProvider: (providerId, day, totalUsd) => {
    if (!providerId || !day || !Number.isFinite(totalUsd) || totalUsd < 0) return
    set((s) => {
      // Hydration may not have run yet (day === ""); adopt the committed day so
      // the very first turn of a session still establishes the bucket.
      if (s.day && s.day !== day) return s
      return {
        day,
        totalsByProvider: { ...s.totalsByProvider, [providerId]: totalUsd },
      }
    })
  },

  getTodaySpend: (providerId) => get().totalsByProvider[providerId] ?? 0,

  reset: () => set({ day: "", totalsByProvider: {} }),
}))
