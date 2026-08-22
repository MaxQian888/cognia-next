/**
 * Lark's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 * Closes the ADR-0009 "Phase 1 / Phase 2 attachment caching" markers.
 *
 * `parse.ts:buildSegments` can only carry the platform media *ref* — an
 * `image_key` / `file_key`, not a URL. The bytes live behind
 * `/im/v1/messages/{message_id}/resources/{key}`, which needs a tenant access
 * token, so the cache ref is scoped to the message: on Lark a media key is only
 * fetchable through the message that carried it.
 */

import {
  enrichInboundMedia,
  onceAsync,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

export interface EnrichLarkMediaDeps extends InboundMediaDeps {
  /** Resolve a valid tenant (or user) access token for the download header. */
  getAccessToken: () => Promise<string>
}

/** Build the Lark message-resource download URL for a media key. */
function resourceUrl(messageId: string, key: string, type: "image" | "file"): string {
  return (
    `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}` +
    `/resources/${encodeURIComponent(key)}?type=${type}`
  )
}

/** Enrich an inbound Lark event's media segments in place. Never throws. */
export async function enrichLarkInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichLarkMediaDeps
): Promise<void> {
  const messageId = event.messageId
  if (!messageId) return

  // One post shares one token; a locked keyring must cost one read, not one
  // per attached image.
  const token = onceAsync(deps.getAccessToken)

  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) => (seg.url ? `lark:${messageId}:${seg.url}` : undefined),
      source: async (seg: EnrichableSegment) => ({
        url: resourceUrl(messageId, seg.url, seg.type === "image" ? "image" : "file"),
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      extractLabel: "lark-inbound",
    },
    deps
  )
}
