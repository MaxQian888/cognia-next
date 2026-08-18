/**
 * Is one inbound connector event worth telling a human about?
 *
 * Extracted from `lib/notifications/inbound-connector.ts` (ADR-0042) so the
 * ADR-0131 cross-shell relay can apply the SAME predicate before publishing
 * `connector://message-added`. Two consumers, one rule — otherwise a paired
 * phone gets woken by edits, deletes, reactions and the bot's own outbound
 * echoes that the desktop Notification Center deliberately drops.
 *
 * Pure: no Dexie, no stores, no platform globals.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"

/**
 * Only "create" message events with real text are user-meaningful.
 *
 * - `kind` other than `"create"` is an edit / delete / recall / reaction — the
 *   conversation already showed the original.
 * - An event whose sender is the adapter's own bot identity is the outbound
 *   echo the platform reflects back; notifying on it makes every reply the
 *   operator sends buzz their own phone.
 * - Attachment-only events carry nothing to preview, and the relay push
 *   deliberately never ships media.
 */
export function isNotifiableInboundEvent(event: NormalizedInboundEvent): boolean {
  if (event.kind && event.kind !== "create") return false
  if (event.sender?.remoteUserId && event.sender.remoteUserId === event.selfId) return false
  return Boolean(event.plainText && event.plainText.trim())
}
