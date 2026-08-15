"use client"

import { useEffect } from "react"
import { installRemoteNotificationListener } from "@/lib/notifications/remote-subscription"

/**
 * Mounts the `notification://remote` listener for this client so notifications
 * raised on a headless cognia-server (a scheduled task finished, a workflow
 * failed, …) land in this device's Notification Center. Which transport is
 * watched depends on the host profile — see
 * `lib/notifications/remote-subscription.ts`; on hosts without a remote
 * (web-standalone, the brain itself) the install is a no-op.
 */
export function RemoteNotificationInitializer() {
  useEffect(() => installRemoteNotificationListener(), [])
  return null
}
