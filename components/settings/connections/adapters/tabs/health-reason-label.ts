/**
 * Map an adapter `health().reason` machine code to a localized label.
 *
 * Adapters emit stable codes (e.g. `credentials_missing`) instead of
 * human sentences so the reason stays language-agnostic until the
 * renderer localizes it. Unknown values — most commonly a raw error
 * message already surfaced by the transport layer — pass through
 * unchanged so nothing is lost.
 *
 * `t` is the `settings.connections.adapters.health` translator (the same
 * one `health-detail.tsx` already holds), so keys live under `reason.*`.
 */

/** Codes the adapters emit and this module localizes. */
export const KNOWN_HEALTH_REASONS = [
  "credentials_missing",
  "credentials_unavailable",
  "no_data",
  "transport_error",
] as const

export type KnownHealthReason = (typeof KNOWN_HEALTH_REASONS)[number]

function isKnownHealthReason(reason: string): reason is KnownHealthReason {
  return (KNOWN_HEALTH_REASONS as readonly string[]).includes(reason)
}

export function healthReasonLabel(
  t: (key: string) => string,
  reason: string | undefined
): string | undefined {
  if (!reason) return undefined
  return isKnownHealthReason(reason) ? t(`reason.${reason}`) : reason
}
