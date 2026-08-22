/**
 * QQ Official's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 *
 * QQ hands the bot a plain CDN URL, which is why this looked fine and was not:
 * `inboundEventToSendContent` turns an image with no bytes into the literal
 * text `[image: https://gchat.qpic.cn/…]`, and the model has no fetcher. So a
 * user sending the bot a picture in a group got an answer written from nothing.
 *
 * The download is restricted to QQ's own media hosts. The attachment array is
 * platform-supplied rather than user-typed, but it is still remote data, and
 * the pass must not become a fetcher for a host named in an inbound payload.
 * A URL on any other host keeps its marker — the same thing that happens today
 * — so an unrecognised CDN degrades rather than breaking delivery.
 */

import {
  enrichInboundMedia,
  stableMediaRef,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** Host suffixes QQ serves group / C2C attachments from. */
const MEDIA_HOST_SUFFIXES = [".qpic.cn", ".qlogo.cn", ".qq.com", ".qq.com.cn"]

/** True for a URL on one of QQ's own media CDNs. */
export function isQQMediaUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  } catch {
    return false
  }
}

/** Enrich an inbound QQ Official event's media segments in place. Never throws. */
export async function enrichQQInboundMedia(
  event: NormalizedInboundEvent,
  deps: InboundMediaDeps = {}
): Promise<void> {
  await enrichInboundMedia(
    event,
    {
      // `parse.ts` normalises scheme-less `gchat.qpic.cn/...` URLs to https
      // before this runs, so the ref is stable across redeliveries.
      ref: (seg: EnrichableSegment) =>
        isQQMediaUrl(seg.url) ? stableMediaRef("qq", seg.url) : undefined,
      source: (seg: EnrichableSegment) => ({ url: seg.url }),
      extractLabel: "qq-inbound",
    },
    deps
  )
}
