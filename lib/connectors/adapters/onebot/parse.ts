/**
 * Auto-detecting OneBot parser.
 *
 * Determines whether an incoming payload is v11 or v12 based on the first
 * event seen for a given adapterId. v11 has `message_type` and numeric
 * `user_id`; v12 has `detail_type` and string `user_id`.
 *
 * The detected variant is cached per-adapterId so subsequent events skip
 * detection and go straight to the correct parser.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { parseV11Event, type OneBotV11Event } from "./v11"
import { parseV12Event, type OneBotV12Event } from "./v12"

/** Cached variant per adapterId. */
const variantCache = new Map<string, "v11" | "v12">()

function detectVariant(event: unknown): "v11" | "v12" | null {
  if (typeof event !== "object" || event === null) return null
  const e = event as Record<string, unknown>

  // v12 has `detail_type` and `self` object
  if ("detail_type" in e && typeof e.self === "object" && e.self !== null) {
    return "v12"
  }

  // v11 has `message_type` (or at minimum numeric `self_id`)
  if ("message_type" in e || (typeof e.self_id === "number" && "post_type" in e)) {
    return "v11"
  }

  return null
}

/**
 * Parse an incoming OneBot event frame.
 *
 * Returns `{variant, parsed}` where `parsed` may be null (non-message events),
 * or null if the frame cannot be classified as v11 or v12.
 */
export function parseOneBotEvent(
  adapterId: string,
  event: unknown
): { variant: "v11" | "v12"; parsed: NormalizedInboundEvent | null } | null {
  let variant = variantCache.get(adapterId)

  if (variant === undefined) {
    const detected = detectVariant(event)
    if (detected === null) return null
    variant = detected
    variantCache.set(adapterId, variant)
  }

  if (variant === "v11") {
    return { variant: "v11", parsed: parseV11Event(adapterId, event as OneBotV11Event) }
  } else {
    return { variant: "v12", parsed: parseV12Event(adapterId, event as OneBotV12Event) }
  }
}

/**
 * Clear the cached variant for a given adapterId.
 * Used when the adapter is stopped / restarted.
 */
export function clearVariantCache(adapterId: string): void {
  variantCache.delete(adapterId)
}

/**
 * Clear all cached variants.
 * Primarily for use in tests.
 */
export function clearAllVariantCaches(): void {
  variantCache.clear()
}
