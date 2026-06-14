/**
 * Plugin SDK helper for the `limits-source` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineLimitsSource()` checks the shape (a `LimitsSource` —
 * key/matches/fetch — plus a registry `id`) against `PluginLimitsSourceDef`.
 */

import type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"

export function defineLimitsSource(def: PluginLimitsSourceDef): PluginLimitsSourceDef {
  return def
}
