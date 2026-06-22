/**
 * Plugin SDK helper for the `im-rate-source` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineImRateSource()` checks the shape (an `ImRateSource` —
 * key/matches/evaluate — plus a registry `id`) against `PluginImRateSourceDef`.
 * An IM-rate source can BLOCK an inbound-triggered AI reply for a conversation.
 */

import type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"

export function defineImRateSource(def: PluginImRateSourceDef): PluginImRateSourceDef {
  return def
}
