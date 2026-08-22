/**
 * Slack's half of the shared inbound rich-media pass
 * (`_shared/inbound-media.ts` — see there for what the pass does and why).
 *
 * Slack's `url_private` looks like a normal link and is not one: fetching it
 * without `Authorization: Bearer <bot token>` returns Slack's HTML sign-in
 * page, not the file. So the bytes were unreachable to everything downstream,
 * and `inboundEventToSendContent` handed the model the literal text
 * `[image: https://files.slack.com/…]` — a link the model cannot open and
 * would get a login page from if it could. Inbound OCR never ran either; it
 * only looks at segments carrying inline bytes.
 *
 * The download is restricted to Slack's own file host. A message can name any
 * URL it likes, and the one thing this pass must never do is attach a
 * workspace bot token to a request aimed at a host a stranger chose.
 *
 * Only the live event paths (socket mode and webhook) are enriched.
 * `fetchHistory` deliberately is not: a backfill walks up to a few hundred
 * messages, and downloading every image in one is a cost the operator did not
 * ask for.
 */

import {
  enrichInboundMedia,
  onceAsync,
  stableMediaRef,
  type EnrichableSegment,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** The only host this pass will send the bot token to. */
const FILE_HOST = "files.slack.com"

export interface EnrichSlackMediaDeps extends InboundMediaDeps {
  /** Resolve the bot token — `url_private` is a 302 to a login page without it. */
  botToken: () => Promise<string>
}

/** True for a Slack-hosted private file URL. */
export function isSlackFileUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).hostname === FILE_HOST
  } catch {
    return false
  }
}

/** Enrich an inbound Slack event's media segments in place. Never throws. */
export async function enrichSlackInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichSlackMediaDeps
): Promise<void> {
  // One post shares one token; a locked keyring must cost one read, not one
  // per attached file.
  const token = onceAsync(deps.botToken)

  await enrichInboundMedia(
    event,
    {
      ref: (seg: EnrichableSegment) =>
        isSlackFileUrl(seg.url) ? stableMediaRef("slack", seg.url) : undefined,
      source: async (seg: EnrichableSegment) => ({
        url: seg.url,
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      extractLabel: "slack-inbound",
    },
    deps
  )
}
