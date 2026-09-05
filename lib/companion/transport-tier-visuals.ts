/**
 * One colour vocabulary for the companion transport tier.
 *
 * Three mobile surfaces (the connection-state pill, the `/me` transport row
 * and the diagnostics sheet) each kept a private `Record<TransportTier,
 * string>`, and they had already drifted: a TURN relay read amber on two of
 * them and emerald on the third, so the same connection looked "fine" on one
 * screen and "degraded" on the next. The tier is one fact. Its colour lives
 * here, in the three shapes those surfaces need (an icon stroke, a filled
 * dot, a bordered chip), and every consumer reads it.
 *
 * Direct RTC is the best case (emerald). A TURN relay works but is slower and
 * costs a relay hop (amber). LAN WebSocket is the ordinary case (sky). A
 * tunnel works from anywhere but through a third party (violet). The Cognia
 * relay (ADR-0170) is the zero-configuration WAN path: it works, it is
 * encrypted end to end, and it is the slowest carrier, so it shares amber
 * with the TURN relay. Offline is neutral.
 */

import type { TransportTier } from "@/lib/tauri/transport-companion"

export interface TransportTierTone {
  /** Icon stroke colour, for a `lucide` glyph next to a label. */
  text: string
  /** Filled dot: `fill-*` plus `text-*` for a `CircleIcon`. */
  dot: string
  /** Bordered chip: border, tint and text for a pill. */
  chip: string
}

export const TRANSPORT_TIER_TONES: Readonly<Record<TransportTier, TransportTierTone>> =
  Object.freeze({
    "rtc-direct": {
      text: "text-emerald-500",
      dot: "fill-emerald-500 text-emerald-500",
      chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    "rtc-relay": {
      text: "text-amber-500",
      dot: "fill-amber-500 text-amber-500",
      chip: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    "ws-lan": {
      text: "text-sky-500",
      dot: "fill-sky-500 text-sky-500",
      chip: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    },
    "ws-tunnel": {
      text: "text-violet-500",
      dot: "fill-violet-500 text-violet-500",
      chip: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    },
    relay: {
      text: "text-amber-500",
      dot: "fill-amber-500 text-amber-500",
      chip: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    offline: {
      text: "text-zinc-500",
      dot: "fill-muted-foreground text-muted-foreground",
      chip: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    },
  })

/** Every tier the vocabulary knows, in quality order (best first). */
export const TRANSPORT_TIER_ORDER: readonly TransportTier[] = Object.freeze([
  "rtc-direct",
  "ws-lan",
  "rtc-relay",
  "ws-tunnel",
  "relay",
  "offline",
])

export function transportTierTone(tier: TransportTier): TransportTierTone {
  return TRANSPORT_TIER_TONES[tier] ?? TRANSPORT_TIER_TONES.offline
}
