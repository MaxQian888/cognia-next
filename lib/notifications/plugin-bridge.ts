// Plugin → Notification Center bridge (ADR-0042). Wires the previously-dangling
// `setToastDispatcher` so plugin notifications become first-class, persistent
// center entries (with history) instead of ephemeral in-memory toasts. The
// plugin action closure is registered as a serializable command so it survives
// persistence and still fires from the center row / toast button.

import { setToastDispatcher } from "@/lib/plugin/api/notification-api"
import type { NotificationLevel } from "@/types/notifications"
import { registerNotificationCommand } from "./action-registry"
import { notify } from "./runtime"

const TYPE_TO_LEVEL: Record<"info" | "success" | "warning" | "error", NotificationLevel> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
}

let installed = false

/** Install the plugin notification bridge once (idempotent). */
export function installPluginNotificationBridge(): void {
  if (installed) return
  installed = true

  setToastDispatcher(({ id, pluginId, title, message, type, duration, action }) => {
    let actions: { id: string; label: string; command: string }[] | undefined
    if (action) {
      const command = `plugin:${id}:0`
      registerNotificationCommand(command, () => action.onClick())
      actions = [{ id: "0", label: action.label, command }]
    }
    void notify({
      source: "plugin",
      pluginId,
      level: TYPE_TO_LEVEL[type],
      title,
      body: message,
      ttlMs: duration,
      actions,
      dedupeKey: id,
      groupKey: pluginId,
      sourceRef: { kind: "plugin", id: pluginId },
    })
  })
}

/** Test-only: allow re-installation. */
export function __resetPluginBridgeForTesting(): void {
  installed = false
}
