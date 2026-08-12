/**
 * IM proactive-push delivery channel (control-plane notifications).
 *
 * The Notification Center fans a record to this channel when its resolved
 * channels include `"im"`. We route the record back to a bound IM conversation:
 *
 *   1. resolve the target conversation from `record.sourceRef` (kind
 *      `"conversation"`, id = conversationKey) → the bound ChatSession's
 *      `platformBinding` (adapterId + opaque conversationRef);
 *   2. enforce the per-conversation opt-in (`ConversationOverrideRow.
 *      proactivePush`), fail-closed default OFF — customer-facing IM must not
 *      get surprise pushes;
 *   3. PII-gate the title + body (the same fail-closed gate auto-mode replies
 *      use), dropping the IM channel (NOT the durable center record) on a hit;
 *   4. enqueue a plain-text outbound through the durable queue (idempotency-
 *      keyed on the record id so a coalesce bump never double-sends).
 *
 * Static-export safe: only Dexie writes + the outbound EventTarget wake bus —
 * zero Tauri IPC, identical to the inbound-connector path.
 */

import type { NotificationRecord } from "@/types/notifications"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { appendAudit } from "@/lib/connectors/audit"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { hasNoLeakingPii } from "@cognia/redact"

export interface ImDeliverDeps {
  findSession?: typeof findSessionByConversationKey
  readOverride?: typeof readForResolution
  enqueue?: typeof enqueueOutbound
  audit?: typeof appendAudit
  /** PII gate (defaults to `hasNoLeakingPii`). Returns true when SAFE to send. */
  isPiiSafe?: (text: string) => boolean
}

function bodyText(rec: NotificationRecord): string {
  return [rec.title, rec.body ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Build the `imDeliver` fn the Notification Center calls. Never throws — every
 * skip / block path audits and returns so a failed IM push can't break the
 * notification persist or the other channels.
 */
export function createImDeliver(
  deps: ImDeliverDeps = {}
): (rec: NotificationRecord) => Promise<void> {
  const findSession = deps.findSession ?? findSessionByConversationKey
  const readOverride = deps.readOverride ?? readForResolution
  const enqueue = deps.enqueue ?? enqueueOutbound
  const audit = deps.audit ?? appendAudit
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii

  return async (rec: NotificationRecord): Promise<void> => {
    try {
      const conversationKey = rec.sourceRef?.kind === "conversation" ? rec.sourceRef.id : undefined
      if (!conversationKey) return // not targeted at a conversation — nothing to do

      const session = await findSession(conversationKey)
      const binding = session?.platformBinding
      if (!binding) {
        // No bound session → we can't reliably target the platform; skip
        // silently (no adapterId to audit against).
        return
      }
      if (!binding.deliveryTarget) {
        await audit({
          adapterId: binding.adapterId,
          kind: "notify.im_skipped",
          at: Date.now(),
          conversationKey,
          reason: "delivery_target_missing",
          fields: { notificationId: rec.id },
        })
        return
      }

      const override = await readOverride(conversationKey).catch(() => undefined)
      if (override?.proactivePush !== true) {
        await audit({
          adapterId: binding.adapterId,
          kind: "notify.im_skipped",
          at: Date.now(),
          conversationKey,
          reason: "opt_in_off",
          fields: { notificationId: rec.id },
        })
        return
      }

      const text = bodyText(rec)
      if (!isPiiSafe(text)) {
        await audit({
          adapterId: binding.adapterId,
          kind: "notify.im_pii_blocked",
          at: Date.now(),
          conversationKey,
          reason: "pii_blocked",
          fields: { notificationId: rec.id },
        })
        return
      }

      await enqueue({
        adapterId: binding.adapterId,
        conversationKey,
        request: {
          conversationRef: binding.conversationRef,
          deliveryTarget: binding.deliveryTarget,
          segments: [{ type: "text", text: text || rec.title }],
          // Idempotency keyed on the record id → a coalesce bump re-delivering
          // the same record is deduped by the outbound runner.
          metadata: { idempotencyKey: `notify:${rec.id}` },
        },
        source: "ai-run",
      })
      await audit({
        adapterId: binding.adapterId,
        kind: "notify.im_pushed",
        at: Date.now(),
        conversationKey,
        fields: { notificationId: rec.id, level: rec.level },
      })
    } catch {
      // Fail-closed: a delivery error must never propagate into notify()'s
      // persist / other channels.
    }
  }
}
