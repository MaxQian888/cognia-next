// Limits source registry. Pure — a flat ordered list of built-in sources plus a
// resolver that returns every source matching a query, plugin overlay first.
//
// Order matters: windowed sources (anthropic, codex) come before the generic
// balance source so the runner prefers a real utilization window and only falls
// through to a credit meter when no window applies. Mirrors the shape of
// `lib/subscription/balance/registry.ts` but returns the full candidate list
// (the runner tries each until one yields a snapshot).

import { listLimitsSourceEntries } from "@/lib/plugin/registries/limits-source-registry"

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
 * Resolve the ordered candidate sources for a query. Plugin-contributed sources
 * (the `limits-source` overlay registry) are consulted BEFORE the built-ins so a
 * plugin can extend or override the bundled set. Returns `[]` when nothing
 * matches (the runner then yields `null` → "no limit data").
 */
export function resolveLimitsSources(q: {
  provider?: string
  providerKey?: string
  baseUrl?: string
}): LimitsSource[] {
  const pluginSources = listLimitsSourceEntries().map((e) => e.entry)
  const ordered = [...pluginSources, ...LIMITS_SOURCES]
  return ordered.filter((s) => s.matches(q))
}
