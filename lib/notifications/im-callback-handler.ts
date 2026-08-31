/**
 * Handle a click on a Notification Center card that was pushed into a chat.
 *
 * Mirrors `lib/issues/im/callback-handler.ts`: the press is applied directly
 * and answered without a model turn, because the record already says what each
 * button does.
 *
 * ## Why the payload carries only two ids
 *
 * A card is persisted on the platform and can be pressed long after it was
 * sent. Baking the `command` and its `args` into the button would let a stale
 * card run work the record no longer offers, so the payload names the record
 * and the action, and the command is read back off the centre row at click
 * time. A record whose action has since been removed resolves to nothing and
 * is audited rather than guessed at.
 */

import { appendAudit } from "@/lib/connectors/audit"
import { dispatchNotificationCommand } from "@/lib/notifications/action-registry"
import { getNotification } from "@/lib/db/notifications"

export interface NotificationActionCallbackInput {
  binding: { bindingPayload?: unknown }
  adapterId: string
  conversationKey?: string
}

function readPayload(value: unknown): { notificationId: string; actionId: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { notificationId, actionId } = value as Record<string, unknown>
  if (typeof notificationId !== "string" || typeof actionId !== "string") return undefined
  return { notificationId, actionId }
}

/**
 * Returns true when the press was applied. A false return means the card
 * referenced something that no longer exists, which is audited by the caller.
 */
export async function handleNotificationActionCallback(
  input: NotificationActionCallbackInput
): Promise<boolean> {
  const payload = readPayload(input.binding.bindingPayload)
  if (!payload) return false

  const record = await getNotification(payload.notificationId).catch(() => undefined)
  const action = record?.actions?.find((a) => a.id === payload.actionId)
  if (!action) {
    await appendAudit({
      adapterId: input.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: input.conversationKey,
      reason: record ? "notification_action_missing" : "notification_missing",
      fields: { notificationId: payload.notificationId, actionId: payload.actionId },
    }).catch(() => undefined)
    return false
  }

  // `dispatchNotificationCommand` swallows an unregistered command and a
  // throwing handler, both of which it logs. That is the right posture here
  // too: a chat button must not surface a stack trace, and the record stays in
  // the centre for the operator to answer in the app.
  await dispatchNotificationCommand({
    notificationId: payload.notificationId,
    command: action.command,
    args: action.args,
  })
  return true
}
