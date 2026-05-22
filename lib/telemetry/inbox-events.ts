/**
 * Convenience emit API for the Inbox breadcrumb telemetry layer.
 *
 * Wraps `lib/db/inbox-telemetry.ts:append` so emit sites stay terse:
 *
 *   await trackInboxEvent("outbound.sent", { adapterId, conversationKey, ms })
 *
 * versus the raw form which requires the caller to mint an id, capture
 * `Date.now()`, and pass the full row shape. The wrapper is intentionally
 * **best-effort**: a telemetry append failure must never block the runtime
 * pipeline that emitted it, so this function swallows errors and logs.
 *
 * The kind union is re-exported here so emit sites don't have to know the
 * persistence module exists — they import everything from one place.
 */

import { append } from "@/lib/db/inbox-telemetry"
import type { InboxTelemetryEventRow, InboxTelemetryKind } from "@/lib/db/inbox-telemetry-types"

export type { InboxTelemetryKind } from "@/lib/db/inbox-telemetry-types"

export interface TrackInboxEventInput {
  /** Adapter the event is associated with; omit for cross-adapter events. */
  adapterId?: string
  /** Conversation key when scoped to one conversation. */
  conversationKey?: string
  /** Per-kind structured payload. */
  fields?: Record<string, unknown>
  /** Override the timestamp (tests; otherwise defaults to `Date.now()`). */
  at?: number
}

/**
 * Append one breadcrumb row. Returns the persisted row on success, or
 * `null` if the persistence layer rejected the write (DB closed during
 * shutdown, IndexedDB unavailable on SSR, etc.). Callers MUST NOT branch
 * on the return value — telemetry is fire-and-forget.
 */
export async function trackInboxEvent(
  kind: InboxTelemetryKind,
  input: TrackInboxEventInput = {}
): Promise<InboxTelemetryEventRow | null> {
  try {
    return await append({
      kind,
      at: input.at ?? Date.now(),
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      fields: input.fields,
    })
  } catch {
    // Best-effort — never block the caller on a telemetry write.
    return null
  }
}
