"use client"

/**
 * Gate for turning ON a notification channel that this phone itself has to
 * deliver (ADR-0056 mobile preferences).
 *
 * The `os` ("System notifications") and `push` ("Push notifications") channel
 * switches on the phone used to be plain preference writes: they flipped ON
 * while Android's POST_NOTIFICATIONS was still ungranted, and on a device with
 * no push transport (e.g. a Huawei build without Google Play services) the push
 * switch read ON for a delivery path that cannot exist. Enabling either now
 * asks the platform first:
 *
 *   - `os`   → local-notification permission (shows the system prompt).
 *   - `push` → full push registration (permission + FCM/APNs token), because
 *              a granted permission alone does not mean a token can be minted.
 *
 * Off the native shell the channels are preferences for the paired host, not
 * for this device, so the gate lets every change through. `toast` and turning
 * a channel OFF never need the platform.
 */

import { isNativeMobile } from "@/lib/platform/detect"
import {
  emitNotificationPermissionGranted,
  requestPermission as requestLocalNotificationPermission,
} from "@/lib/capacitor/local-notifications"
import { registerPushNotifications } from "@/lib/push/push-notifications"
import type { NotificationChannel } from "@/types/notifications"

/**
 * - `allowed`     — the channel can be switched on.
 * - `denied`      — the user (or the system) refused permission; recover in
 *                   the app's system settings.
 * - `unavailable` — this device cannot deliver the channel at all (no push
 *                   transport, plugin missing, bridge error).
 */
export type DeviceChannelGateOutcome =
  { kind: "allowed" } | { kind: "denied" } | { kind: "unavailable"; reason: string }

export interface DeviceChannelGateDeps {
  isNativeMobile?: () => boolean
  requestLocalPermission?: typeof requestLocalNotificationPermission
  registerPush?: typeof registerPushNotifications
  onPermissionGranted?: () => void
}

/** Ask the platform whether `channel` may be switched on for this device. */
export async function ensureDeviceChannelReady(
  channel: NotificationChannel,
  deps: DeviceChannelGateDeps = {}
): Promise<DeviceChannelGateOutcome> {
  const onMobile = (deps.isNativeMobile ?? isNativeMobile)()
  if (!onMobile || (channel !== "os" && channel !== "push")) return { kind: "allowed" }
  const granted = deps.onPermissionGranted ?? (() => void emitNotificationPermissionGranted())

  if (channel === "os") {
    const out = await (deps.requestLocalPermission ?? requestLocalNotificationPermission)()
    if (out.kind === "ok") {
      if (out.value === "granted") {
        granted()
        return { kind: "allowed" }
      }
      return { kind: "denied" }
    }
    return {
      kind: "unavailable",
      reason: out.kind === "error" ? out.message : "local notifications unsupported",
    }
  }

  const out = await (deps.registerPush ?? registerPushNotifications)({ requestPermission: true })
  switch (out.kind) {
    case "registered":
      // The boot provider listens for this and reports the token to the host.
      granted()
      return { kind: "allowed" }
    case "permission_denied":
    case "permission_required":
      return { kind: "denied" }
    case "unsupported":
      return { kind: "unavailable", reason: "push notifications unsupported" }
    case "registration_failed":
      return { kind: "unavailable", reason: out.message }
  }
}
