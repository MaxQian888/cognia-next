/**
 * Inbound merged-forward (合并转发) enrichment for the OneBot adapter.
 *
 * A QQ merged-forward arrives inline as a `forward` segment. NapCat often
 * ships only the forward `id` without the nested nodes, in which case the
 * synchronous segment mapper can only render a generic `[合并转发消息]`
 * marker (see `segments.ts:summarizeForward`). This module resolves the real
 * body via a `get_forward_msg` round-trip and splices the returned nodes back
 * into the raw event's `forward` segment BEFORE parsing — so the pure,
 * synchronous parse/segment layers stay transport-agnostic and the mapper's
 * existing inlined-content branch renders `nickname: text` lines.
 *
 * Design mirrors Lark's inbound-media enrichment: async I/O is localised next
 * to the transport, never leaking into the parser.
 *
 * Best-effort and bounded:
 *   - only top-level `forward` segments are resolved (no recursion into
 *     nested forwards);
 *   - a fetch failure / non-ok response leaves the segment untouched so the
 *     `[合并转发消息]` fallback still renders;
 *   - segments that already carry inlined `content` are skipped (zero RPC).
 */

import type { OneBotTransport } from "./transport"
import { serializeGetForwardMsgV11 } from "./serialize"

interface RawSegment {
  type?: unknown
  data?: Record<string, unknown>
}

function hasInlineContent(data: Record<string, unknown>): boolean {
  return Array.isArray(data.content) && data.content.length > 0
}

/**
 * Given a raw inbound OneBot event and the live transport, resolve any
 * unresolved top-level `forward` segment via `get_forward_msg` and splice the
 * fetched nodes into `segment.data.content`. Returns the (mutated) event so
 * the caller can hand it straight to `parseOneBotEvent`.
 *
 * The raw event is ephemeral (freshly JSON-parsed per frame), so mutating in
 * place is safe and avoids a deep clone on the hot path.
 */
export async function resolveForwardContent(
  rawEvent: unknown,
  transport: OneBotTransport
): Promise<unknown> {
  if (typeof rawEvent !== "object" || rawEvent === null) return rawEvent
  const message = (rawEvent as { message?: unknown }).message
  // CQ-code string forwards are not enriched (array format is the norm).
  if (!Array.isArray(message)) return rawEvent

  for (const seg of message as RawSegment[]) {
    if (!seg || seg.type !== "forward") continue
    const data = (seg.data ?? {}) as Record<string, unknown>
    if (hasInlineContent(data)) continue

    const id = data.id
    if (typeof id !== "string" || id === "") continue

    try {
      const resp = await transport.send(serializeGetForwardMsgV11(id))
      if (resp.status !== "ok" || !resp.data || typeof resp.data !== "object") continue
      const payload = resp.data as { messages?: unknown; message?: unknown }
      const nodes = payload.messages ?? payload.message
      if (Array.isArray(nodes) && nodes.length > 0) {
        data.content = nodes
        seg.data = data
      }
    } catch {
      // Best-effort — leave the marker fallback in place.
    }
  }

  return rawEvent
}
