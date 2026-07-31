/**
 * Public helper for proactive IM notifications (control-plane notifications).
 *
 * Any subsystem with a bound IM conversation (the connector runtime, a team /
 * goal / loop runner, a workflow) calls this to push an event back to the user
 * over IM. It funnels through the one Notification Center pipe (`notify`) with
 * `channels: ["center", "im"]` and a `conversation` sourceRef, so the event
 * ALWAYS lands in the durable center feed and ADDITIONALLY pushes to IM when
 * the conversation opted in (see `im-deliver.ts`). DND, dedup, and PII gating
 * are handled downstream.
 */

import type {
  NotificationAction,
  NotificationLevel,
  NotificationSource,
} from "@/types/notifications"
import { notify } from "./runtime"

export interface NotifyConversationInput {
  conversationKey: string
  title: string
  body?: string
  level?: NotificationLevel
  /** Defaults to `"connector"`. */
  source?: NotificationSource
  /** Coalesce repeats (e.g. `airun-error:<key>`). */
  dedupeKey?: string
  actions?: NotificationAction[]
  /** Counts toward the directed/red-badge tally (e.g. input-required). */
  directed?: boolean
  icon?: string
}

/**
 * Emit a proactive notification targeted at an IM conversation. Resolves to the
 * Notification Center record id. The IM push itself is best-effort + opt-in;
 * the center record is always written.
 */
export async function notifyConversationOverIM(input: NotifyConversationInput): Promise<string> {
  return notify({
    source: input.source ?? "connector",
    level: input.level ?? "info",
    title: input.title,
    body: input.body,
    channels: ["center", "im"],
    dedupeKey: input.dedupeKey,
    actions: input.actions,
    directed: input.directed,
    icon: input.icon,
    sourceRef: { kind: "conversation", id: input.conversationKey },
  })
}
