/**
 * The plugin contract's share of `lib/platform/capabilities.ts`, which re-exports these.
 */
import type { CORE_CAPABILITY_IDS } from "@/lib/platform/capabilities"

export type CoreCapabilityId = (typeof CORE_CAPABILITY_IDS)[number]

/**
 * Full capability id space: core ids plus `plugin:<pluginId>` tags a plugin
 * may declare for its own nodes ("this node needs my plugin active here").
 */
export type CapabilityId = CoreCapabilityId | `plugin:${string}`
