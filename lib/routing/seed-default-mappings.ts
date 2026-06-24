/**
 * One-time seeding of default model-routing tier aliases for fresh users.
 *
 * The alias-routing engine inside `resolveSendOptions` only activates when
 * `appSettings.modelMappings.length > 0` (`lib/claude/build-options.ts`). A
 * brand-new user has no mappings, so the whole engine — strategies, filters,
 * circuit breaker, fallback chains — stays invisible. Seeding the
 * provider-filtered tier defaults (`fast`/`balanced`/`powerful`/`reasoning`)
 * once on first load unblocks it transparently, following the same
 * persist-only-if-changed pattern as `repairImportedVscodeThemes`.
 */

import type { AppSettings } from "@/lib/claude/types"
import { generateDefaultMappings } from "@cognia/provider-routing/default-mappings"

/**
 * Derive the set of provider ids the user has enabled, reusing the exact
 * logic the routing-preset activation path relies on: a built-in provider is
 * enabled unless its `providerSettings` entry says `enabled === false`,
 * Anthropic is always enabled unless explicitly disabled (it works via the
 * sidecar OAuth/API key without a `providerSettings` row), and custom
 * providers carry their own `enabled` flag.
 */
export function computeEnabledProviderIds(s: AppSettings | null | undefined): Set<string> {
  const enabledIds = new Set<string>()
  for (const [id, ps] of Object.entries(s?.providerSettings ?? {})) {
    if (ps?.enabled !== false) enabledIds.add(id)
  }
  if (s?.providerSettings?.["anthropic"]?.enabled !== false) enabledIds.add("anthropic")
  for (const cp of s?.customProviders ?? []) {
    if (cp.enabled !== false) enabledIds.add(cp.id)
  }
  return enabledIds
}

/**
 * Return a settings object with default tier-alias mappings seeded when the
 * user has none, or the SAME reference when no seed is needed — so callers can
 * cheaply detect "did anything change?" by identity and skip the persist.
 *
 * Idempotent: once `modelMappings` is non-empty (seeded or user-edited) this
 * never reseeds, so no separate "has been seeded" flag is required.
 */
export function seedDefaultMappingsIfNeeded(s: AppSettings): AppSettings {
  if (s.modelMappings && s.modelMappings.length > 0) return s
  const enabledIds = computeEnabledProviderIds(s)
  if (enabledIds.size === 0) return s
  const seeded = generateDefaultMappings(enabledIds)
  if (seeded.length === 0) return s
  return { ...s, modelMappings: seeded }
}
