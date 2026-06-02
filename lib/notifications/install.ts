// One-shot installer for the Unified Notification Center bridges (ADR-0042).
// Mounted once at app startup (see the root provider). Wires the inbound
// sources that funnel into the single `notify()` pipe: plugin notifications,
// connector inbound messages, and mobile push. The session-completion source
// is a React hook (`useSessionNotifications`) mounted separately. Idempotent —
// each bridge guards its own re-installation.

import { installPluginNotificationBridge } from "./plugin-bridge"
import { installConnectorNotificationBridge } from "./inbound-connector"
import { installPushNotificationBridge } from "./inbound-push"

let installed = false

export function installNotificationBridges(): void {
  if (installed) return
  installed = true
  installPluginNotificationBridge()
  installConnectorNotificationBridge()
  // Push is async (Capacitor plugin probe); fire-and-forget, no-op off mobile.
  void installPushNotificationBridge()
}

export function __resetNotificationBridgesForTesting(): void {
  installed = false
}
