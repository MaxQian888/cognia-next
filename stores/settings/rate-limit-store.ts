"use client"

/**
 * Trailing-minute rate counters (RPM/TPM), keyed per DEPLOYMENT
 * (`providerId::modelId[::keyId]` — see `types/provider/deployment.ts`) with
 * provider-level reads merged across the provider's deployments.
 *
 * Fed by `recordProviderOutcome` after every turn (success and failure both
 * count as a request); read synchronously by the routing engine to
 * deprioritize providers already at their configured `maxRequestsPerMinute` /
 * `maxTokensPerMinute` ceiling. In-memory only — rate windows are 60s, so
 * persistence would be pointless. No enable flag: an unset constraint already
 * means "no limit".
 */

import { create } from "zustand"

import {
  currentRate,
  recordRate,
  type RateEvent,
} from "@cognia/provider-core/providers/rate-limit-window"
import {
  deploymentKeyOf,
  DEPLOYMENT_MODEL_WILDCARD,
  providerIdOfDeploymentKey,
} from "@cognia/provider-types/deployment"

/** Optional deployment targeting for `record`. */
export interface RateRecordOptions {
  modelId?: string
  keyId?: string
}

interface RateLimitStore {
  events: Record<string, RateEvent[]>
  /** Record one completed request (tokens optional — 0 keeps RPM working). */
  record: (providerId: string, tokens?: number, now?: number, opts?: RateRecordOptions) => void
  /** Trailing-minute rate for a provider, merged across its deployments. */
  getRate: (providerId: string, now?: number) => { rpm: number; tpm: number }
  /** Trailing-minute rate for one deployment. */
  getDeploymentRate: (deploymentKey: string, now?: number) => { rpm: number; tpm: number }
  reset: () => void
}

/** Store key for a record; unencodable ids fall back to the raw providerId. */
function deploymentKeyFor(providerId: string, opts?: RateRecordOptions): string {
  return (
    deploymentKeyOf({
      providerId,
      modelId: opts?.modelId ?? DEPLOYMENT_MODEL_WILDCARD,
      ...(opts?.keyId !== undefined ? { keyId: opts.keyId } : {}),
    }) ?? providerId
  )
}

function keyBelongsToProvider(key: string, providerId: string): boolean {
  return key === providerId || providerIdOfDeploymentKey(key) === providerId
}

export const useRateLimitStore = create<RateLimitStore>((set, get) => ({
  events: {},

  record: (providerId, tokens = 0, now = Date.now(), opts) => {
    if (!providerId) return
    const key = deploymentKeyFor(providerId, opts)
    set((s) => ({
      events: {
        ...s.events,
        [key]: recordRate(s.events[key] ?? [], tokens, now),
      },
    }))
  },

  getRate: (providerId, now = Date.now()) => {
    const merged: RateEvent[] = []
    for (const [key, events] of Object.entries(get().events)) {
      if (keyBelongsToProvider(key, providerId)) merged.push(...events)
    }
    return currentRate(merged, now)
  },

  getDeploymentRate: (deploymentKey, now = Date.now()) =>
    currentRate(get().events[deploymentKey] ?? [], now),

  reset: () => set({ events: {} }),
}))
