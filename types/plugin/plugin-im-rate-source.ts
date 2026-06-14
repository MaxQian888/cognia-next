/**
 * Plugin IM rate-source contract (`im-rate-source` capability).
 *
 * A plugin contributes a per-conversation send gate for IM connectors. Mirrors
 * the `limits-source` plugin def shape (an `ImRateSource` plus a registry `id`)
 * but for the IM-scoped `evaluate → {allow}` contract, not provider credit.
 * Registered into `im-rate-source-registry` on enable and consulted by
 * `resolveImRateSources` ahead of any built-in sources (there are none today).
 */

import type { ImRateSource } from "@/types/connectors/im-rate-source"

export interface PluginImRateSourceDef extends ImRateSource {
  /** Stable registry id (e.g. `<pluginId>:<source>`). Distinct from `key`. */
  id: string
  /** Optional display name for diagnostics and the capability summary. */
  name?: string
}
