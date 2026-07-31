/**
 * Inbound reply-snippet enrichment for the OneBot adapter.
 *
 * A v11 `reply` segment carries only the referenced message's `id` — the
 * wire has no snippet, so `replyTo.snippet` used to stay "" and downstream
 * consumers (quote rendering, AI context) lost the quoted text. This module
 * resolves the referenced message via a `get_msg` round-trip and injects a
 * truncated plain-text snippet into the raw segment's `data.snippet` BEFORE
 * parsing, so the pure, synchronous parse/segment layers stay
 * transport-agnostic (mirrors `inbound-forward.ts`'s get_forward_msg
 * enrichment pattern).
 *
 * Best-effort and bounded:
 *   - only the first top-level `reply` segment is resolved (a message carries
 *     at most one reply reference);
 *   - v11 shape only — `get_msg` is a v11 action, and v12 reply segments use
 *     `message_id` (no `data.id`), so they are skipped naturally;
 *   - a fetch failure / timeout / non-ok response leaves the segment
 *     untouched so the empty-snippet fallback still applies;
 *   - the snippet is truncated to {@link REPLY_SNIPPET_MAX_CHARS} chars.
 */

import type { OneBotTransport } from "./transport"
import { serializeGetMsgV11 } from "./serialize"
import { parseCqCodeString, fromOneBotSegments, type OneBotSegment } from "./segments"

export const REPLY_SNIPPET_MAX_CHARS = 120

interface RawSegment {
  type?: unknown
  data?: Record<string, unknown>
}

/**
 * Project a `get_msg` response payload to plain text: text segments joined
 * (array format), CQ string parsed through the shared CQ parser, else the
 * `raw_message` fallback.
 */
function extractPlainText(data: Record<string, unknown>): string {
  const message = data.message
  if (typeof message === "string") {
    return parseCqCodeString(message, "v11")
      .map((s) => (s.type === "text" ? s.text : ""))
      .join("")
  }
  if (Array.isArray(message)) {
    return fromOneBotSegments(message as OneBotSegment[], "v11")
      .map((s) => (s.type === "text" ? s.text : ""))
      .join("")
  }
  const raw = data.raw_message
  return typeof raw === "string" ? raw : ""
}

/**
 * Given a raw inbound OneBot event and the live transport, resolve the first
 * `reply` segment's referenced message via `get_msg` and inject the plain-text
 * snippet as `segment.data.snippet` (read by `segments.ts:fromV11Segment`).
 * Returns the (mutated) event so the caller can hand it straight to
 * `parseOneBotEvent`. The raw event is ephemeral (freshly JSON-parsed per
 * frame), so mutating in place is safe — same rationale as
 * `resolveForwardContent`.
 */
export async function resolveReplySnippet(
  rawEvent: unknown,
  transport: OneBotTransport
): Promise<unknown> {
  if (typeof rawEvent !== "object" || rawEvent === null) return rawEvent
  const message = (rawEvent as { message?: unknown }).message
  // CQ-code string replies are not enriched (array format is the norm).
  if (!Array.isArray(message)) return rawEvent

  for (const seg of message as RawSegment[]) {
    if (!seg || seg.type !== "reply") continue
    const data = (seg.data ?? {}) as Record<string, unknown>
    if (typeof data.snippet === "string" && data.snippet !== "") break // already enriched
    const id = data.id
    if ((typeof id !== "string" && typeof id !== "number") || id === "") break

    try {
      const resp = await transport.send(serializeGetMsgV11(String(id)))
      if (resp.status !== "ok" || !resp.data || typeof resp.data !== "object") break
      const text = extractPlainText(resp.data as Record<string, unknown>).trim()
      if (text !== "") {
        data.snippet =
          text.length > REPLY_SNIPPET_MAX_CHARS
            ? `${text.slice(0, REPLY_SNIPPET_MAX_CHARS)}…`
            : text
        seg.data = data
      }
    } catch {
      // Best-effort — keep the empty-snippet fallback.
    }
    break // at most one reply segment per message; bound the RPCs either way
  }

  return rawEvent
}
