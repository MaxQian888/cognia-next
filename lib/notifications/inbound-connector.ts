// Connector inbound → Notification Center bridge (ADR-0042). Subscribes a
// passive observer to the ConnectorBus and turns user-meaningful inbound
// messages into center notifications. Focus-aware: when the user is already
// viewing that conversation (and the window is focused), the OS channel is
// suppressed while the center still records — Slack/Notion behaviour.

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { NotificationChannel } from "@/types/notifications"
import { getBus } from "@/lib/connectors/bus"
import { resolvePreferences } from "./preferences"
import { isViewingConversation } from "@/stores/inbox/active-conversation-store"
import { notify } from "./runtime"
import { useSettingsStore } from "@/stores/settings"

const PREVIEW_MAX = 140

function previewOf(text: string): string {
  const t = text.trim()
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t
}

/** Only "create" message events are user-meaningful; skip edits/deletes/system. */
function isNotifiable(event: NormalizedInboundEvent): boolean {
  if (event.kind && event.kind !== "create") return false
  // Skip the bot's own outbound echoes.
  if (event.sender?.remoteUserId && event.sender.remoteUserId === event.selfId) return false
  // Need at least some text to preview.
  return Boolean(event.plainText && event.plainText.trim())
}

export function buildConnectorNotification(event: NormalizedInboundEvent): {
  title: string
  body: string
  directed: boolean
  href: string
  groupKey: string
} {
  const who = event.sender?.displayName || "New message"
  const where = event.channel?.name
  const title = where ? `${who} · ${where}` : who
  const directed = event.mentions?.selfMentioned === true || event.channel?.kind === "private"
  return {
    title,
    body: previewOf(event.plainText),
    directed,
    href: `/inbox/c?key=${encodeURIComponent(event.conversationKey)}`,
    groupKey: event.conversationKey,
  }
}

let dispose: (() => void) | null = null

/** Subscribe the connector inbound observer (idempotent). */
export function installConnectorNotificationBridge(): void {
  if (dispose) return
  dispose = getBus().subscribeInbound((event) => {
    if (!isNotifiable(event)) return

    const prefs = resolvePreferences(useSettingsStore.getState().settings?.notificationPreferences)
    const { title, body, directed, href, groupKey } = buildConnectorNotification(event)

    // Focus-aware OS suppression: viewing this conversation → center+toast only.
    let channels: NotificationChannel[] | undefined
    if (prefs.connectorFocusAware && isViewingConversation(event.conversationKey)) {
      channels = ["center", "toast"]
    }

    void notify({
      source: "connector",
      level: "info",
      title,
      body,
      directed,
      href,
      channels,
      dedupeKey: event.conversationKey,
      groupKey,
      sourceRef: { kind: "conversation", id: event.conversationKey },
    })
  })
}

export function __uninstallConnectorNotificationBridge(): void {
  dispose?.()
  dispose = null
}
