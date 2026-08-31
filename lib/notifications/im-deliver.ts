/**
 * IM proactive-push delivery channel (control-plane notifications).
 *
 * The Notification Center fans a record to this channel when its resolved
 * channels include `"im"`. We route the record back to a bound IM conversation:
 *
 *   1. resolve the target conversation from the record (see
 *      {@link resolveConversationKey}) → the bound ChatSession's
 *      `platformBinding` (adapterId + opaque conversationRef);
 *   2. enforce the per-conversation opt-in (`ConversationOverrideRow.
 *      proactivePush`), fail-closed default OFF — customer-facing IM must not
 *      get surprise pushes;
 *   3. PII-gate the title + body (the same fail-closed gate auto-mode replies
 *      use), dropping the IM channel (NOT the durable center record) on a hit;
 *   4. enqueue through the durable queue (idempotency-keyed on the record id so
 *      a coalesce bump never double-sends): an A2UI card when the record
 *      carries actions, plain text when it does not.
 *
 * ## Why the card path exists
 *
 * A record can carry one to three inline actions, and this channel used to
 * drop them, so "Plan awaiting approval / Approve / Discard" arrived in a
 * group chat as one sentence with no way to answer it. The buttons carry a
 * `notification_action` binding, which `ConnectorBus.dispatchConnectorCallback`
 * short-circuits into `dispatchNotificationCommand` without a model turn,
 * exactly as it does for `issue_action`.
 *
 * Static-export safe: only Dexie writes + the outbound EventTarget wake bus —
 * zero Tauri IPC, identical to the inbound-connector path.
 */

import type { NotificationRecord } from "@/types/notifications"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { listExecutionRunBindings } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { hasNoLeakingPii } from "@cognia/redact"
import { buildNotificationCardSurface } from "./im-card"

export interface ImDeliverDeps {
  findSession?: typeof findSessionByConversationKey
  readOverride?: typeof readForResolution
  enqueue?: typeof enqueueOutbound
  audit?: typeof appendAudit
  /** PII gate (defaults to `hasNoLeakingPii`). Returns true when SAFE to send. */
  isPiiSafe?: (text: string) => boolean
  /** Session lookup by id, for the `session`/`groupKey` resolution step. */
  getSession?: (
    sessionId: string
  ) => Promise<{ platformBinding?: { conversationKey?: string } } | undefined>
  /** Run-binding lookup, for the run-kind resolution step. */
  listRunBindings?: typeof listExecutionRunBindings
}

/** `sourceRef.kind` values that name a durable run rather than a chat. */
const RUN_SOURCE_KINDS = new Set(["run", "team-run", "background-run"])

async function defaultGetSession(sessionId: string) {
  return getDb().sessions.get(sessionId)
}

/**
 * Which IM conversation this record belongs in, or `undefined` for one that
 * belongs in none.
 *
 * The gate used to be `sourceRef.kind === "conversation"` and a silent
 * `return`. Every other producer names its own domain entity, so a plan
 * awaiting approval (`kind: "plan"`), a finished team run, and a scheduled
 * task were all invisible in IM by construction, with nothing recorded to say
 * why. Each step below reads a table that already exists and already holds the
 * link, and a step that resolves nothing simply falls through.
 *
 * This widens WHERE a notification can land, never WHETHER one is pushed. The
 * `proactivePush` opt-in downstream is untouched and still fail-closed.
 */
async function resolveConversationKey(
  rec: NotificationRecord,
  deps: {
    getSession: NonNullable<ImDeliverDeps["getSession"]>
    listRunBindings: typeof listExecutionRunBindings
  }
): Promise<string | undefined> {
  const ref = rec.sourceRef
  if (ref?.kind === "conversation") return ref.id

  // A session id reaches the conversation through the binding the session
  // already carries. `groupKey` is the plan hub's spelling of the same thing
  // (`notifyPlanAwaitingApproval` sets it to `plan.sessionId`).
  const sessionId = ref?.kind === "session" ? ref.id : rec.groupKey
  if (sessionId) {
    const session = await deps.getSession(sessionId).catch(() => undefined)
    const key = session?.platformBinding?.conversationKey
    if (key) return key
  }

  // A run knows the conversation that started it: `ExecutionRunBinding` is
  // minted with `conversationKey` when the run is dispatched from IM. A run
  // started on the desktop has no binding, and resolves to nothing.
  if (ref && RUN_SOURCE_KINDS.has(ref.kind)) {
    const bindings = await deps.listRunBindings(ref.id).catch(() => [])
    const bound = bindings.find((b) => b.conversationKey)
    if (bound?.conversationKey) return bound.conversationKey
  }

  return undefined
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
  const getSession = deps.getSession ?? defaultGetSession
  const listRunBindings = deps.listRunBindings ?? listExecutionRunBindings

  return async (rec: NotificationRecord): Promise<void> => {
    try {
      const conversationKey = await resolveConversationKey(rec, { getSession, listRunBindings })
      if (!conversationKey) return // belongs in no IM conversation — nothing to do

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

      // A record with actions is a question, and a question needs its answers
      // attached. One without is a statement, and the plain-text path renders
      // it better on every platform, so the card is not forced on it.
      const segment =
        (rec.actions?.length ?? 0) > 0
          ? buildA2UISegment(
              `notification:${rec.id}`,
              buildNotificationCardSurface({ record: rec })
            )
          : { type: "text" as const, text: text || rec.title }

      await enqueue({
        adapterId: binding.adapterId,
        conversationKey,
        request: {
          conversationRef: binding.conversationRef,
          deliveryTarget: binding.deliveryTarget,
          segments: [segment],
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
