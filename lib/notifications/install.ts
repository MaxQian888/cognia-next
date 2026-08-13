// One-shot installer for the Unified Notification Center bridges (ADR-0042).
// Mounted once at app startup (see the root provider). Wires the inbound
// sources that funnel into the single `notify()` pipe: plugin notifications,
// and connector inbound messages. Mobile push is installed by the Capacitor
// boot provider after native plugin registration. The session-completion
// source is a React hook (`useSessionNotifications`) mounted separately.
// Idempotent — each bridge guards its own re-installation.

import { installPluginNotificationBridge } from "./plugin-bridge"
import { installConnectorNotificationBridge } from "./inbound-connector"

let installed = false

export function installNotificationBridges(): void {
  if (installed) return
  installed = true
  installPluginNotificationBridge()
  installConnectorNotificationBridge()
}

export function __resetNotificationBridgesForTesting(): void {
  installed = false
}
