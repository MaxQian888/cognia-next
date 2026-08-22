/**
 * Discord's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 *
 * Discord is the easy case and was still broken: the CDN URL on an attachment
 * is a real, publicly fetchable link, so nobody noticed that handing it to a
 * model does nothing. `inboundEventToSendContent` turns an image with no bytes
 * into the literal text `[image: https://cdn.discordapp.com/…]` — the model
 * has no fetcher, so someone posting a screenshot and asking "what's wrong
 * here?" got an answer written from the file name. Inbound OCR never ran
 * either; it only looks at segments carrying inline bytes.
 *
 * Two Discord specifics:
 *
 *   - **Signed URLs.** Attachment links carry `?ex=&is=&hm=` and Discord
 *     re-signs them, so the query is not part of the file's identity. The
 *     cache is keyed on the path (`stableMediaRef`), which makes a redelivery
 *     or an edit of the same message a cache hit.
 *   - **No auth.** The signature *is* the authorisation, so unlike Slack or
 *     Lark the download needs no header. A token here would be a leak, not a
 *     requirement.
 *
 * Only the live gateway path is enriched. `fetchHistory` deliberately is not:
 * a backfill walks up to a few hundred messages, and downloading every image
 * in one is a cost the operator did not ask for.
 */

import {
  enrichInboundMedia,
  stableMediaRef,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** Discord CDN hosts whose links this pass is willing to download. */
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"])

/**
 * True for a URL this pass should fetch.
 *
 * Restricted to Discord's own CDN on purpose: a segment's URL can come from an
 * embed or a proxied link, and the pass must not turn the bot into a fetcher
 * for arbitrary hosts an inbound message names.
 */
export function isDiscordCdnUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return CDN_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Enrich an inbound Discord event's media segments in place. Never throws. */
export async function enrichDiscordInboundMedia(
  event: NormalizedInboundEvent,
  deps: InboundMediaDeps = {}
): Promise<void> {
  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) =>
        isDiscordCdnUrl(seg.url) ? stableMediaRef("discord", seg.url) : undefined,
      // The signed URL is the download; no header, no second round trip.
      source: (seg: EnrichableSegment) => ({ url: seg.url }),
      extractLabel: "discord-inbound",
    },
    deps
  )
}
