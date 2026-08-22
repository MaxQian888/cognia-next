/**
 * OneBot's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 *
 * `segments.ts` maps a `[CQ:image]` / v12 `image` segment to
 * `{ type: "image", url }` using whatever the implementation reported, and
 * nothing resolved it. `inboundEventToSendContent` then degrades an image with
 * no bytes to the literal text `[image: …]`, so a picture sent into a QQ group
 * reached the model as a URL string it cannot open.
 *
 * ## Why this platform needs `allowPrivateHost`
 *
 * Every other adapter downloads from a vendor CDN, so the shared floor
 * (`isPublicHttpUrl`) is exactly right. OneBot is different: the operator runs
 * the implementation themselves, and NapCat / Lagrange / LLOneBot routinely
 * rewrite media URLs to their OWN HTTP file server — which is normally on the
 * LAN or on localhost. Refusing private hosts outright would block the common,
 * intended configuration.
 *
 * So the floor is widened by exactly one host: the one in `forwardWsUrl`, the
 * address the operator typed into the connector's own settings. A private
 * address that arrives inside a message and does not match it is still
 * refused, which is the case that actually matters — an inbound message must
 * never be able to point the app at the host's own network.
 *
 * In `reverse-ws` mode (the default, where the implementation dials cognia)
 * there is no configured address to trust, so only public URLs are fetched.
 *
 * v12 `file_id` references are NOT resolved here: reading one takes a `get_file`
 * action over the connection, which is a different shape of work from a
 * download. Those segments keep their marker, exactly as before.
 */

import {
  enrichInboundMedia,
  stableMediaRef,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface EnrichOneBotMediaDeps extends InboundMediaDeps {
  /**
   * The `forward-ws` URL the operator configured, when the adapter dials the
   * implementation. Absent in `reverse-ws` mode.
   */
  forwardWsUrl?: string
}

/** True for an absolute http(s) URL — the only thing worth trying to download. */
export function isHttpUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * A predicate that accepts only the host the operator configured for this
 * connection. `undefined` when there is no such host (`reverse-ws`), which
 * leaves the public-only floor in place.
 */
export function operatorHostAllowance(
  forwardWsUrl: string | undefined
): ((url: string) => boolean) | undefined {
  if (!forwardWsUrl) return undefined
  let host: string
  try {
    host = new URL(forwardWsUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (!host) return undefined
  return (candidate: string) => {
    try {
      return new URL(candidate).hostname.toLowerCase() === host
    } catch {
      return false
    }
  }
}

/** Enrich an inbound OneBot event's media segments in place. Never throws. */
export async function enrichOneBotInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichOneBotMediaDeps = {}
): Promise<void> {
  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) =>
        isHttpUrl(seg.url) ? stableMediaRef("onebot", seg.url) : undefined,
      source: (seg: EnrichableSegment) => ({ url: seg.url }),
      allowPrivateHost: operatorHostAllowance(deps.forwardWsUrl),
      extractLabel: "onebot-inbound",
    },
    deps
  )
}
