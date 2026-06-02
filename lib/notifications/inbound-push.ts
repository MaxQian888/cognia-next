// Mobile push → Notification Center bridge (ADR-0042). Wires the previously
// dangling `subscribeToPushNotifications` consumer. Inbound push that arrives
// in the BACKGROUND was already shown by the OS, so we only record it to the
// center (no re-fire). FOREGROUND push (app open) records + toasts. Deep-links
// via the server `data.href`. No-op on web/desktop (the Capacitor plugin is
// absent there and `subscribeToPushNotifications` returns a no-op disposer).

import type { PushDelivery } from "@/lib/push/push-notifications"
import { subscribeToPushNotifications } from "@/lib/push/push-notifications"
import type { NotificationChannel, NotificationSource } from "@/types/notifications"
import { notify } from "./runtime"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function pushToInput(delivery: PushDelivery) {
  const title = delivery.title ?? delivery.body
  if (!title) return null // nothing meaningful to show
  const conversationKey = str(delivery.data?.conversationKey)
  const source = (str(delivery.data?.source) as NotificationSource | undefined) ?? "connector"
  // Background push was already shown by the OS → center only. Foreground → +toast.
  const channels: NotificationChannel[] = delivery.foreground ? ["center", "toast"] : ["center"]
  return {
    source,
    level: "info" as const,
    title,
    body: delivery.title ? delivery.body : undefined,
    href: str(delivery.data?.href),
    channels,
    dedupeKey: conversationKey,
    groupKey: conversationKey,
    sourceRef: conversationKey ? { kind: "conversation", id: conversationKey } : undefined,
  }
}

let dispose: (() => Promise<void>) | null = null

/** Subscribe inbound push → center (idempotent). Safe to call on any platform. */
export async function installPushNotificationBridge(): Promise<void> {
  if (dispose) return
  dispose = await subscribeToPushNotifications((delivery) => {
    const input = pushToInput(delivery)
    if (input) void notify(input)
  })
}

export async function __uninstallPushNotificationBridge(): Promise<void> {
  await dispose?.()
  dispose = null
}
