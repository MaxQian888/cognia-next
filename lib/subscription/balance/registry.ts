// Balance adapter registry. Pure — a flat list of adapters plus a resolver
// that matches by providerKey first, then by the host of a baseUrl.
//
// Only providers with a real, documented public balance API are listed here.
// Everything else simply doesn't match → the runner returns `null` → the UI
// shows "balance unavailable".

import type { BalanceAdapter } from "@/types/subscription"

import { deepseekBalanceAdapter } from "./adapters/deepseek"
import { moonshotBalanceAdapter } from "./adapters/moonshot"
import { openrouterBalanceAdapter } from "./adapters/openrouter"
import { siliconflowBalanceAdapter } from "./adapters/siliconflow"

export const BALANCE_ADAPTERS: readonly BalanceAdapter[] = [
  deepseekBalanceAdapter,
  openrouterBalanceAdapter,
  siliconflowBalanceAdapter,
  moonshotBalanceAdapter,
]

/**
 * Resolve the adapter for a query. Tries an exact providerKey match first
 * (the authoritative signal — the preset's `templateId`), then falls back to
 * host-of-baseUrl matching so a pure-custom preset still resolves when its
 * URL points at a known host. Returns `undefined` when nothing matches.
 */
export function findBalanceAdapter(q: {
  providerKey?: string
  baseUrl?: string
}): BalanceAdapter | undefined {
  if (q.providerKey) {
    const byKey = BALANCE_ADAPTERS.find((a) => a.matches({ providerKey: q.providerKey }))
    if (byKey) return byKey
  }
  if (q.baseUrl) {
    return BALANCE_ADAPTERS.find((a) => a.matches({ baseUrl: q.baseUrl }))
  }
  return undefined
}
