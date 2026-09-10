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
 * v12 file_id references resolve over get_file, with inline data preferred
 * and URL fallback for implementations that cannot return bytes.
 */

import {
  enrichInboundMedia,
  stableMediaRef,
  MAX_INLINE_BYTES,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { OneBotTransport } from "./transport"
import { connectorsAttachmentRead } from "@/lib/connectors/tauri/commands"

export interface EnrichOneBotMediaDeps extends InboundMediaDeps {
  /**
   * The `forward-ws` URL the operator configured, when the adapter dials the
   * implementation. Absent in `reverse-ws` mode.
   */
  forwardWsUrl?: string
  transport?: Pick<OneBotTransport, "send">
  supportedActions?: () => Promise<ReadonlySet<string>>
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
  const inline = new Map<string, string>()
  const headers = new Map<string, Record<string, string>>()
  if (
    deps.transport &&
    event.segments.some(
      (segment) =>
        segment.type === "image" ||
        segment.type === "file" ||
        segment.type === "voice" ||
        segment.type === "video"
    )
  ) {
    let supported = false
    try {
      supported = (await deps.supportedActions?.())?.has("get_file") ?? true
    } catch {
      /* keep unresolved refs */
    }
    if (supported) {
      for (const segment of event.segments) {
        if (!(
          segment.type === "image" ||
          segment.type === "file" ||
          segment.type === "voice" ||
          segment.type === "video"
        ))
          continue
        const fileId = segment.url
        if (!fileId) continue
        try {
          let result = await deps.transport.send({
            action: "get_file",
            params: { file_id: fileId, type: "data" },
            echo: `file:${crypto.randomUUID()}`,
          })
          if (result.retcode === 10004)
            result = await deps.transport.send({
              action: "get_file",
              params: { file_id: fileId, type: "url" },
              echo: `file:${crypto.randomUUID()}`,
            })
          if (
            result.status !== "ok" ||
            result.retcode !== 0 ||
            !result.data ||
            typeof result.data !== "object"
          )
            continue
          const data = result.data as {
            data?: string
            name?: string
            url?: string
            headers?: Record<string, string>
            sha256?: string
          }
          if (segment.type === "file" && typeof data.name === "string" && data.name)
            segment.name = data.name
          if (typeof data.data === "string") {
            if (data.data.length > Math.ceil((deps.maxInlineBytes ?? MAX_INLINE_BYTES) / 3) * 4)
              continue
            const decoded = atob(data.data)
            if (decoded.length > (deps.maxInlineBytes ?? MAX_INLINE_BYTES)) continue
            if (data.sha256) {
              const digest = await crypto.subtle.digest(
                "SHA-256",
                Uint8Array.from(decoded, (character) => character.charCodeAt(0))
              )
              const hex = Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0")
              ).join("")
              if (hex !== data.sha256.toLowerCase()) continue
            }
            segment.rawUrl = fileId
            if (segment.type === "voice" || segment.type === "video")
              segment.url = `data:${segment.mimeType ?? "application/octet-stream"};base64,${data.data}`
            else {
              inline.set(fileId, data.data)
            }
          } else if (isHttpUrl(data.url)) {
            segment.rawUrl = fileId
            segment.url = data.url!
            if (
              data.headers &&
              Object.values(data.headers).every((value) => typeof value === "string")
            )
              headers.set(segment.url, data.headers)
          }
        } catch {
          /* A failed file must not discard the message or other files. */
        }
      }
    }
  }
  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) =>
        inline.has(seg.url)
          ? `onebot-file:${seg.url}`
          : isHttpUrl(seg.url)
            ? stableMediaRef("onebot", seg.url)
            : undefined,
      source: (seg: EnrichableSegment) => ({ url: seg.url, headers: headers.get(seg.url) }),
      allowPrivateHost: operatorHostAllowance(deps.forwardWsUrl),
      // `segments.ts` names no media type — the CQ code carries only a URL — so
      // without this the shared fallback would declare every QQ picture
      // `image/png`, and QQ media is overwhelmingly JPEG. The bytes still get
      // the last word; this only covers a format the sniffer cannot name.
      defaultImageMime: "image/jpeg",
      extractLabel: "onebot-inbound",
    },
    {
      ...deps,
      readAttachment: async (adapterId, ref, maxBytes) =>
        inline.get(ref.replace(/^onebot-file:/, "")) ??
        (deps.readAttachment ?? connectorsAttachmentRead)(adapterId, ref, maxBytes),
    }
  )
  for (const segment of event.segments) {
    if (segment.type === "file" && inline.has(segment.url))
      segment.dataBase64 = inline.get(segment.url)
  }
}
