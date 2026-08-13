// Mobile push → Notification Center bridge (ADR-0042). Wires the previously
// dangling `subscribeToPushNotifications` consumer. Inbound push that arrives
// in the BACKGROUND was already shown by the OS, so we only record it to the
// center (no re-fire). FOREGROUND push is presented natively by Capacitor and
// is also recorded here, without a duplicate toast. Deep-links via the server
// `data.href`. No-op on web/desktop (the Capacitor plugin is absent there and
// `subscribeToPushNotifications` returns a no-op disposer).

import type { PushDelivery } from "@/lib/push/push-notifications"
import { subscribeToPushNotifications } from "@/lib/push/push-notifications"
import {
  NOTIFICATION_LEVELS,
  NOTIFICATION_SOURCES,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationSource,
} from "@/types/notifications"
import { notify } from "./runtime"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function pushToInput(delivery: PushDelivery) {
  const title = delivery.title ?? delivery.body
  if (!title) return null // nothing meaningful to show
  const conversationKey = str(delivery.data?.conversationKey)
  const notificationId = str(delivery.data?.notificationId)
  const groupingKey = conversationKey ?? notificationId
  const rawSource = str(delivery.data?.source)
  const source = NOTIFICATION_SOURCES.includes(rawSource as NotificationSource)
    ? (rawSource as NotificationSource)
    : "connector"
  const rawLevel = str(delivery.data?.level)
  const level = NOTIFICATION_LEVELS.includes(rawLevel as NotificationLevel)
    ? (rawLevel as NotificationLevel)
    : "info"
  // APNs/FCM presents background delivery, while Capacitor presentationOptions
  // presents foreground delivery. The unified pipe records both without
  // adding a second in-app toast.
  const channels: NotificationChannel[] = ["center"]
  return {
    source,
    level,
    title,
    body: delivery.title ? delivery.body : undefined,
    href: str(delivery.data?.href),
    channels,
    dedupeKey: groupingKey,
    groupKey: groupingKey,
    sourceRef: conversationKey ? { kind: "conversation", id: conversationKey } : undefined,
  }
}

let dispose: (() => Promise<void>) | null = null

export type PushDeliveryObserver = (delivery: PushDelivery) => void

/** Subscribe inbound push → center (idempotent). Safe to call on any platform. */
export async function installPushNotificationBridge(
  onDelivery?: PushDeliveryObserver
): Promise<() => Promise<void>> {
  if (dispose) return async () => {}

  const subscription = await subscribeToPushNotifications((delivery) => {
    const input = pushToInput(delivery)
    if (input) void notify(input)
    onDelivery?.(delivery)
  })
  dispose = subscription

  return async () => {
    if (dispose !== subscription) return
    dispose = null
    await subscription()
  }
}

export async function __uninstallPushNotificationBridge(): Promise<void> {
  const subscription = dispose
  dispose = null
  await subscription?.()
}
