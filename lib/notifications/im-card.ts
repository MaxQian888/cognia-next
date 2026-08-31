/**
 * A2UI surface for a Notification Center record pushed into an IM chat.
 *
 * A `NotificationRecord` can carry one to three inline actions, persisted on
 * the centre row and dispatched at click time through
 * `lib/notifications/action-registry.ts`. The IM channel dropped them: it sent
 * `[{ type: "text" }]` and nothing else, so "Plan awaiting approval, Approve /
 * Discard" arrived in a group as one sentence with no way to answer it.
 *
 * Pure, like `lib/issues/im/card.ts` and the workflow / help surfaces. Every
 * Button carries `bindingKind: "notification_action"` plus the payload, the
 * platform-agnostic hint `adapters/_shared/a2ui-mapper.ts` turns into a
 * binding row, so a click short-circuits in `ConnectorBus` instead of becoming
 * a model digest turn.
 *
 * Strings default to English and are overridable, because this runs in the
 * headless connector runtime where `next-intl` does not exist.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { NotificationAction, NotificationRecord } from "@/types/notifications"

/** What one notification button does. Persisted as the binding payload. */
export interface NotificationActionPayload {
  notificationId: string
  actionId: string
}

export interface NotificationCardLabels {
  /** Prefix for the numbered mirror an adapter without buttons falls back to. */
  replyHint: string
}

export const DEFAULT_NOTIFICATION_CARD_LABELS: NotificationCardLabels = {
  replyHint: "Reply with the number to choose:",
}

/**
 * Slack allows one `primary` button per block and reserves `danger` for
 * destructive work. The record's own `variant` already carries the author's
 * intent, so the mapping is direct, with everything unset staying secondary.
 */
function buttonVariant(action: NotificationAction): "primary" | undefined {
  return action.variant === "primary" ? "primary" : undefined
}

export interface NotificationCardInput {
  record: Pick<NotificationRecord, "id" | "title" | "body" | "actions" | "href">
  labels?: Partial<NotificationCardLabels>
}

/**
 * Build the interactive notification card.
 *
 * Callers should only reach for this when the record HAS actions. A record
 * with none is a statement, not a question, and the plain-text path it already
 * had renders it better on every platform.
 */
export function buildNotificationCardSurface(input: NotificationCardInput): A2UISegmentContent {
  const labels = { ...DEFAULT_NOTIFICATION_CARD_LABELS, ...(input.labels ?? {}) }
  const { record } = input
  const actions = record.actions ?? []

  const components: Record<string, unknown> = {
    root: { component: "Card", title: record.title, children: [] as string[] },
  }
  const children: string[] = []
  const mirror: string[] = [`# ${record.title}`]

  if (record.body?.trim()) {
    components.body = { component: "Text", text: record.body.trim() }
    children.push("body")
    mirror.push(record.body.trim())
  }

  const actionIds: string[] = []
  let numeric = 1
  for (const action of actions) {
    // The component key is derived from the action id rather than its index,
    // so a card re-rendered after one action was removed does not re-point the
    // remaining buttons at different work.
    const id = `action_${action.id}`
    components[id] = {
      component: "Button",
      text: action.label,
      action: action.id,
      ...(buttonVariant(action) ? { variant: buttonVariant(action) } : {}),
      bindingKind: "notification_action",
      bindingPayload: { notificationId: record.id, actionId: action.id },
    }
    actionIds.push(id)
    mirror.push(`${numeric++}. ${action.label}`)
  }
  if (actionIds.length > 0) {
    components.actions = { component: "Row", children: actionIds }
    children.push("actions")
    // Only meaningful on the numeric-reply path, and harmless above it.
    mirror.splice(mirror.length - actionIds.length, 0, labels.replyHint)
  }

  // The deep link is the escape hatch for anyone who would rather answer in
  // the app, and the only affordance left when a platform renders neither
  // buttons nor a numbered reply.
  if (record.href) {
    components.open = { component: "Link", text: record.href, href: record.href, external: true }
    children.push("open")
    mirror.push(record.href)
  }

  ;(components.root as { children: string[] }).children = children

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title: record.title,
    widget: { fallbackText: mirror.filter(Boolean).join("\n") },
  }
}
