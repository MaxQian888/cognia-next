/**
 * Telling the person a new device is waiting (ADR-0215 phase 2): a center
 * row with a toast and an OS notification, valid until the request expires,
 * whose action opens the approval dialog. It goes through `notify()` with
 * explicit local channels and never through `emitNotification`, so no
 * subscription can route an approval prompt to IM, a companion push or a
 * webhook: the code must be compared on the devices themselves.
 * `approval-notifications.test.ts` pins that.
 */

import type { NotificationChannel } from "@/types/notifications"
import { findByDedupeKey } from "@/lib/db/notifications"
import { notify } from "@/lib/notifications/runtime"
import { useNotificationStore } from "@/stores/notifications/notification-store"

/** The command a notification's action dispatches (`registerNotificationCommand`). */
export const OPEN_APPROVAL_COMMAND = "account-sync.open-approval"

/** The only channels an approval prompt may use. */
export const APPROVAL_CHANNELS: readonly NotificationChannel[] = ["center", "toast", "os"]

export interface RequestNotificationText {
  title: string
  body: string
  open: string
}

export interface NotifiableRequest {
  requestId: string
  expiresAt: number
}

export function requestNotificationKey(requestId: string): string {
  return `account-sync:request:${requestId}`
}

export async function notifyIncomingRequest(
  request: NotifiableRequest,
  text: RequestNotificationText
): Promise<string> {
  const key = requestNotificationKey(request.requestId)
  return notify({
    source: "system",
    level: "warning",
    title: text.title,
    body: text.body,
    channels: [...APPROVAL_CHANNELS],
    dedupeKey: key,
    logicalKey: key,
    directed: true,
    validUntil: request.expiresAt,
    icon: "smartphone",
    actions: [
      {
        id: "open",
        label: text.open,
        command: OPEN_APPROVAL_COMMAND,
        args: { requestId: request.requestId },
        variant: "primary",
      },
    ],
  })
}

/** Archives the prompt once the request is approved, denied, cancelled or expired. */
export async function clearRequestNotification(requestId: string): Promise<void> {
  const record = await findByDedupeKey(requestNotificationKey(requestId), 0)
  if (record) await useNotificationStore.getState().markDone(record.id)
}
