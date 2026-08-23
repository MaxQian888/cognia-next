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
 * So the floor is widened by exactly one address — host AND port — the one in
 * `forwardWsUrl`, which the operator typed into the connector's own settings.
 * A private address that arrives inside a message and does not match it is
 * still refused, which is the case that actually matters — an inbound message
 * must never be able to point the app at the host's own network.
 *
 * In `reverse-ws` mode (the default, where the implementation dials cognia)
 * there is no configured address to trust, so only public URLs are fetched.
 * The adapter therefore only hands `forwardWsUrl` to this pass when the
 * transport is ACTUALLY dialling it: a URL left behind on the config after a
 * switch back to reverse-ws is not an address anything is talking to.
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

/** Scheme defaults, so `ws://h` and `http://h:80` compare equal. */
const DEFAULT_PORTS: Record<string, string> = {
  "ws:": "80",
  "wss:": "443",
  "http:": "80",
  "https:": "443",
}

/** `host:port` with the scheme's default filled in, or `undefined`. */
function hostAndPort(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    const port = url.port || DEFAULT_PORTS[url.protocol]
    if (!url.hostname || !port) return undefined
    return `${url.hostname.toLowerCase()}:${port}`
  } catch {
    return undefined
  }
}

/**
 * A predicate that accepts only the address the operator configured for this
 * connection. `undefined` when there is no such address (`reverse-ws`), which
 * leaves the public-only floor in place.
 *
 * The PORT is part of the address, and dropping it is not a detail: the common
 * configuration puts `forwardWsUrl` on `ws://127.0.0.1:3001`, so a
 * hostname-only match hands an inbound message every other port on the
 * loopback interface — `http://127.0.0.1:8080/admin/export` would be
 * downloaded into the attachment cache and read to the model. What the
 * operator typed is one address, and that is exactly what is trusted.
 *
 * The consequence is deliberate: an implementation serving media from a
 * DIFFERENT port than its WS endpoint is refused, and the segment keeps its
 * marker. Widening that needs a media host the operator names, not an
 * inference from a message.
 */
export function operatorHostAllowance(
  forwardWsUrl: string | undefined
): ((url: string) => boolean) | undefined {
  if (!forwardWsUrl) return undefined
  const configured = hostAndPort(forwardWsUrl)
  if (!configured) return undefined
  return (candidate: string) => hostAndPort(candidate) === configured
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
      // `segments.ts` names no media type — the CQ code carries only a URL — so
      // without this the shared fallback would declare every QQ picture
      // `image/png`, and QQ media is overwhelmingly JPEG. The bytes still get
      // the last word; this only covers a format the sniffer cannot name.
      defaultImageMime: "image/jpeg",
      extractLabel: "onebot-inbound",
    },
    deps
  )
}
