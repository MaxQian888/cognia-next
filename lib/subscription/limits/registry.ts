// Limits source registry. Pure — a flat ordered list of built-in sources plus a
// resolver that returns every source matching a query, plugin overlay first.
//
// Order matters: windowed sources (anthropic, codex) come before the generic
// balance source so the runner prefers a real utilization window and only falls
// through to a credit meter when no window applies. Mirrors the shape of
// `lib/subscription/balance/registry.ts` but returns the full candidate list
// (the runner tries each until one yields a snapshot).

import { listLimitsSourceEntries } from "@/lib/plugin/registries/limits-source-registry"

import { CATALOG_SOURCES } from "./descriptor/catalog"
import { anthropicLimitsSource } from "./sources/anthropic"
import { balanceLimitsSource } from "./sources/balance"
import { codexLimitsSource } from "./sources/codex"

import type { LimitsSource } from "@/types/subscription"

/** Built-in sources, windowed first then the generic credit-balance fallthrough. */
export const LIMITS_SOURCES: readonly LimitsSource[] = [
  anthropicLimitsSource,
  codexLimitsSource,
  balanceLimitsSource,
]

/**
 * Resolve the ordered candidate sources for a query. Order of precedence:
 *   1. plugin-contributed sources (the `limits-source` overlay registry),
 *   2. the built-in declarative catalog (`descriptor/catalog.ts`),
 *   3. the hand-written built-ins (windowed first, credit-balance last).
 * Plugin + catalog come before the built-ins so a relay preset matches its
 * specific descriptor before the generic balance fallthrough. Returns `[]` when
 * nothing matches (the runner then yields `null` → "no limit data").
 */
export function resolveLimitsSources(q: {
  provider?: string
  providerKey?: string
  baseUrl?: string
}): LimitsSource[] {
  const pluginSources = listLimitsSourceEntries().map((e) => e.entry)
  const ordered = [...pluginSources, ...CATALOG_SOURCES, ...LIMITS_SOURCES]
  return ordered.filter((s) => s.matches(q))
}
