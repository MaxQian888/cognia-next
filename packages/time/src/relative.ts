/**
 * Tiny relative-time formatter — five buckets, no `date-fns` dependency.
 *
 * Used by surfaces that want a "x ago" stamp without bringing in a full
 * i18n date library. Pair with `Intl.RelativeTimeFormat` only when the
 * surface needs proper localisation.
 */
export function formatRelative(epochMs: number, now: number = Date.now()): string {
  const delta = now - epochMs
  if (delta < 0) return "just now"
  if (delta < 60_000) return "just now"
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`
}
