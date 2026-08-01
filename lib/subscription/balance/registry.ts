// Balance adapter registry. Pure — a flat list of adapters plus a resolver
// that matches by providerKey first, then by the host of a baseUrl.
//
// Only providers with a real, documented public balance API are listed here.
// Everything else simply doesn't match → the runner returns `null` → the UI
// shows "balance unavailable".

import type { BalanceAdapter } from "@/types/subscription"

import { listBalanceAdapterEntries } from "@/lib/plugin/registries/balance-adapter-registry"
import { deepinfraBalanceAdapter } from "./adapters/deepinfra"
import { deepseekBalanceAdapter } from "./adapters/deepseek"
import { moonshotBalanceAdapter } from "./adapters/moonshot"
import { novitaBalanceAdapter } from "./adapters/novita"
import { openrouterBalanceAdapter } from "./adapters/openrouter"
import { ppioBalanceAdapter } from "./adapters/ppio"
import { siliconflowBalanceAdapter } from "./adapters/siliconflow"
import { stepfunBalanceAdapter } from "./adapters/stepfun"
import { threeOTwoBalanceAdapter } from "./adapters/threeotwo"

// Researched 2026-06-07: Zhipu/bigmodel, MiniMax, Together (dashboard-only) and
// AiHubMix (needs a separate dashboard access token, not the inference key) have
// NO usable documented *credit-balance* API — deliberately absent here. NOTE:
// this is the balance (top-up credit) layer only. Zhipu and MiniMax DO expose
// API-key-callable *plan-usage* windows (5h/weekly), which ship as catalog
// descriptors (`limits/descriptor/catalog.ts` → `glm`, `minimax`), not as
// balance adapters.
export const BALANCE_ADAPTERS: readonly BalanceAdapter[] = [
  deepseekBalanceAdapter,
  openrouterBalanceAdapter,
  siliconflowBalanceAdapter,
  stepfunBalanceAdapter,
  moonshotBalanceAdapter,
  novitaBalanceAdapter,
  deepinfraBalanceAdapter,
  ppioBalanceAdapter,
  threeOTwoBalanceAdapter,
]

/**
 * Resolve the adapter for a query. Plugin-contributed adapters (the
 * `balance-adapter` overlay registry) are consulted BEFORE the built-ins so a
 * plugin can extend the bundled set or override one. Within each tier it tries
 * an exact providerKey match first (the authoritative signal — the preset's
 * `templateId`), then falls back to host-of-baseUrl matching so a pure-custom
 * preset still resolves when its URL points at a known host. Returns
 * `undefined` when nothing matches.
 */
export function findBalanceAdapter(q: {
  providerKey?: string
  baseUrl?: string
}): BalanceAdapter | undefined {
  // Plugin overlay adapters take precedence (extend / override built-ins).
  const pluginAdapters = listBalanceAdapterEntries().map((e) => e.entry)
  for (const tier of [pluginAdapters, BALANCE_ADAPTERS]) {
    if (q.providerKey) {
      const byKey = tier.find((a) => a.matches({ providerKey: q.providerKey }))
      if (byKey) return byKey
    }
    if (q.baseUrl) {
      const byUrl = tier.find((a) => a.matches({ baseUrl: q.baseUrl }))
      if (byUrl) return byUrl
    }
  }
  return undefined
}
