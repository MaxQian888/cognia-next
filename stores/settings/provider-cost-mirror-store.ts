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

  getTodaySpend: (providerId) => get().totalsByProvider[providerId] ?? 0,

  reset: () => set({ day: "", totalsByProvider: {} }),
}))
