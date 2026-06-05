"use client"

/**
 * Per-provider trailing-minute rate counters (RPM/TPM).
 *
 * Fed by `recordProviderOutcome` after every turn (success and failure both
 * count as a request); read synchronously by the routing engine to
 * deprioritize providers already at their configured `maxRequestsPerMinute` /
 * `maxTokensPerMinute` ceiling. In-memory only — rate windows are 60s, so
 * persistence would be pointless. No enable flag: an unset constraint already
 * means "no limit".
 */

import { create } from "zustand"

import { currentRate, recordRate, type RateEvent } from "@/lib/ai/providers/rate-limit-window"

interface RateLimitStore {
  events: Record<string, RateEvent[]>
  /** Record one completed request (tokens optional — 0 keeps RPM working). */
  record: (providerId: string, tokens?: number, now?: number) => void
  /** Trailing-minute request/token rate for a provider. O(window size). */
  getRate: (providerId: string, now?: number) => { rpm: number; tpm: number }
  reset: () => void
}

export const useRateLimitStore = create<RateLimitStore>((set, get) => ({
  events: {},

  record: (providerId, tokens = 0, now = Date.now()) => {
    if (!providerId) return
    set((s) => ({
      events: {
        ...s.events,
        [providerId]: recordRate(s.events[providerId] ?? [], tokens, now),
      },
    }))
  },

  getRate: (providerId, now = Date.now()) => currentRate(get().events[providerId] ?? [], now),

  reset: () => set({ events: {} }),
}))
