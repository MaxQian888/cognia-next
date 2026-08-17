/**
 * Issue lifecycle → Notification Center (+ IM push) — ADR-0130 slice ③.
 *
 * One funnel: `notify()` (`lib/notifications/runtime.ts`), the app's only
 * notification entry. Every emitted record carries `source: "issue"`, a
 * `dedupeKey` per issue+kind, and an `issue.open` action; when the issue has
 * an IM origin (or a conversation is bound to its project via
 * `ConversationOverrideRow.issueProjectId`) the record additionally targets
 * that conversation, so `im-deliver.ts` pushes it — gated as ever by the
 * conversation's `proactivePush` opt-in and the PII gate. Nothing here talks
 * to a connector directly.
 *
 * Which events notify (grill decision Q18): assigned / reassigned, run
 * succeeded / failed, status → in_review / done / canceled, and comments by
 * anyone other than the local human. Everything else stays in the activity
 * trail only.
 *
 * Wiring: `installIssueNotifications` watches `issueEvents` (Dexie liveQuery)
 * from a boot-time watermark, so every mutation site — board, IM callback,
 * run bridge — is covered without each one calling notify. The CRUD layer
 * stays mechanical.
 */

import { liveQuery } from "dexie"
import type { Issue, IssueActor, IssueEvent, IssueEventPayload } from "@/types/issues"
import type { NotificationInput, NotificationLevel } from "@/types/notifications"
import { getDb } from "@/lib/db/schema"
import type { notify as notifyRuntime } from "@/lib/notifications/runtime"
import { registerNotificationCommand } from "@/lib/notifications/action-registry"
import { issueHref } from "@/lib/issues/sources/local-source"
import { SELF_ACTOR_KEY } from "@/lib/issues/run/running"
import { actorKey } from "@/lib/issues/board-model"

export const ISSUE_OPEN_COMMAND = "issue.open"

/** Translator shape — `useTranslations("issues")` from React, or the English fallback. */
export type IssueNotifyTranslate = (key: string, values?: Record<string, string | number>) => string

/**
 * English fallback used when no translator is injected (headless hosts, tests).
 * The React initializer passes `useTranslations("issues")`, whose keys live
 * under `issues.notify.*` in `i18n/messages/{en,zh-CN}/issues.json`.
 */
export const DEFAULT_ISSUE_NOTIFY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "notify.open": "Open issue",
  "notify.assigned.title": "{identifier} assigned to {to}",
  "notify.assigned.body": "{title}",
  "notify.reassigned.title": "{identifier} reassigned to {to}",
  "notify.reassigned.body": "{title}",
  "notify.run_succeeded.title": "{identifier} run finished — ready for review",
  "notify.run_succeeded.body": "{title}",
  "notify.run_failed.title": "{identifier} run failed",
  "notify.run_failed.body": "{error}",
  "notify.status_changed.title": "{identifier} moved to {to}",
  "notify.status_changed.body": "{title}",
  "notify.commented.title": "New comment on {identifier} from {by}",
  "notify.commented.body": "{body}",
  "notify.status.in_review": "In review",
  "notify.status.done": "Done",
  "notify.status.canceled": "Canceled",
  "notify.actor.human": "you",
  "notify.actor.agent": "an agent",
  "notify.actor.team": "a squad",
})

export function defaultIssueNotifyTranslate(
  key: string,
  values: Record<string, string | number> = {}
): string {
  const template = DEFAULT_ISSUE_NOTIFY_TEXT[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""))
}

function actorLabel(actor: IssueActor | undefined, t: IssueNotifyTranslate): string {
  if (!actor) return t("notify.actor.human")
  return actor.label ?? t(`notify.actor.${actor.kind}`)
}

/** Statuses whose arrival is worth a notification. */
const NOTIFY_ON_STATUS = new Set(["in_review", "done", "canceled"])

/**
 * Pure projection: which notification (if any) an issue event deserves.
 * Returns `null` for events that stay in the activity trail only.
 */
export function issueEventToNotification(
  issue: Pick<Issue, "id" | "identifier" | "title">,
  payload: IssueEventPayload,
  t: IssueNotifyTranslate = defaultIssueNotifyTranslate
): Omit<NotificationInput, "source" | "sourceRef" | "channels"> | null {
  const base = {
    href: issueHref(issue.id),
    actions: [
      {
        id: "open",
        label: t("notify.open"),
        command: ISSUE_OPEN_COMMAND,
        args: { issueId: issue.id },
        variant: "primary" as const,
      },
    ],
    icon: "circle-dot",
    groupKey: `issue:${issue.id}`,
  }
  const values = { identifier: issue.identifier, title: issue.title }
  const build = (
    kind: string,
    level: NotificationLevel,
    extra: Record<string, string>,
    directed: boolean
  ) => ({
    ...base,
    level,
    title: t(`notify.${kind}.title`, { ...values, ...extra }),
    body: t(`notify.${kind}.body`, { ...values, ...extra }),
    dedupeKey: `issue:${issue.id}:${kind}`,
    directed,
  })

  switch (payload.kind) {
    case "assigned":
      return build("assigned", "info", { to: actorLabel(payload.to, t) }, true)
    case "reassigned":
      return build("reassigned", "info", { to: actorLabel(payload.to, t) }, true)
    case "run_succeeded":
      return build("run_succeeded", "success", {}, true)
    case "run_failed":
      return build("run_failed", "error", { error: payload.error }, true)
    case "status_changed":
      if (!NOTIFY_ON_STATUS.has(payload.to)) return null
      return build("status_changed", "info", { to: t(`notify.status.${payload.to}`) }, false)
    case "commented":
      if (actorKey(payload.by) === SELF_ACTOR_KEY) return null
      return build(
        "commented",
        "info",
        { by: actorLabel(payload.by, t), body: payload.body.slice(0, 280) },
        true
      )
    default:
      return null
  }
}

/**
 * Conversations that should hear about this issue: its IM origin plus every
 * conversation bound to its delivery container. Deduped, order-stable.
 */
export async function resolveIssueConversationKeys(
  issue: Pick<Issue, "issueProjectId" | "origin">
): Promise<string[]> {
  const keys: string[] = []
  if (issue.origin?.kind === "im") keys.push(issue.origin.conversationKey)
  const bound = await getDb()
    .conversationOverrides.filter((row) => row.issueProjectId === issue.issueProjectId)
    .toArray()
  for (const row of bound) if (!keys.includes(row.conversationKey)) keys.push(row.conversationKey)
  return keys
}

export interface NotifyIssueEventDeps {
  notify: typeof notifyRuntime
  translate: IssueNotifyTranslate
  conversationKeysFor: typeof resolveIssueConversationKeys
}

/**
 * `lib/notifications/runtime.ts` drags the IM delivery chain (connectors,
 * delivery gateway) in at import time; load it lazily so the tracker's boot
 * graph stays light and headless hosts without a connector runtime still boot.
 */
async function loadNotify(): Promise<typeof notifyRuntime> {
  return (await import("@/lib/notifications/runtime")).notify
}

/**
 * Emit the notification(s) for one issue event. Always one durable center
 * record; additionally one IM-targeted record per bound conversation. Returns
 * the record ids (empty when the event does not notify).
 */
export async function notifyIssueEvent(
  issue: Pick<Issue, "id" | "identifier" | "title" | "issueProjectId" | "origin">,
  payload: IssueEventPayload,
  deps: Partial<NotifyIssueEventDeps> = {}
): Promise<string[]> {
  const notify = deps.notify ?? (await loadNotify())
  const translate = deps.translate ?? defaultIssueNotifyTranslate
  const conversationKeysFor = deps.conversationKeysFor ?? resolveIssueConversationKeys

  const projected = issueEventToNotification(issue, payload, translate)
  if (!projected) return []
  const conversationKeys = await conversationKeysFor(issue)
  if (conversationKeys.length === 0) {
    return [
      await notify({ ...projected, source: "issue", sourceRef: { kind: "issue", id: issue.id } }),
    ]
  }
  const ids: string[] = []
  for (const conversationKey of conversationKeys) {
    ids.push(
      await notify({
        ...projected,
        // One row per conversation; the key keeps them from coalescing into each other.
        dedupeKey: `${projected.dedupeKey}:${conversationKey}`,
        source: "issue",
        channels: ["center", "im"],
        sourceRef: { kind: "conversation", id: conversationKey },
      })
    )
  }
  return ids
}

export interface InstallIssueNotificationsOptions {
  translate?: IssueNotifyTranslate
  /** Events at or before this ts are history, not news. Defaults to install time. */
  since?: number
  notify?: typeof notifyRuntime
  onError?: (error: unknown) => void
}

let installedWatcher: (() => void) | null = null

/**
 * Watch `issueEvents` and notify for every event appended after boot. Returns
 * a disposer; idempotent per process.
 */
export function installIssueNotifications(
  options: InstallIssueNotificationsOptions = {}
): () => void {
  if (installedWatcher) return installedWatcher
  // Fixed at boot: the query is "everything after boot", `seen` keeps each
  // event to one notification. Not advanced afterwards — event timestamps are
  // only monotonic per writer, so a moving watermark could skip a row.
  const watermark = options.since ?? Date.now()
  const seen = new Set<string>()
  const onError = options.onError ?? (() => {})
  let disposed = false

  const subscription = liveQuery(() =>
    getDb().issueEvents.where("ts").above(watermark).toArray()
  ).subscribe({
    next: (events: IssueEvent[]) => {
      if (disposed) return
      const fresh = events
        .filter((event) => !seen.has(event.id))
        .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
      if (fresh.length === 0) return
      for (const event of fresh) seen.add(event.id)
      void (async () => {
        for (const event of fresh) {
          try {
            const issue = await getDb().issues.get(event.issueId)
            if (!issue) continue
            await notifyIssueEvent(issue, event.payload, {
              translate: options.translate,
              notify: options.notify,
            })
          } catch (error) {
            onError(error)
          }
        }
      })()
    },
    error: onError,
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    subscription.unsubscribe()
    installedWatcher = null
  }
  installedWatcher = dispose
  return dispose
}

export interface IssueNotificationCommandDeps {
  navigate: (path: string) => void
}

/** Register the `issue.open` action executor. Returns the unregister function. */
export function installIssueNotificationCommands(deps: IssueNotificationCommandDeps): () => void {
  return registerNotificationCommand(ISSUE_OPEN_COMMAND, (ctx) => {
    const issueId = ctx.args?.issueId
    if (typeof issueId !== "string" || !issueId) return
    deps.navigate(issueHref(issueId))
  })
}

/** Test-only. */
export function __resetIssueNotificationsForTesting(): void {
  installedWatcher?.()
  installedWatcher = null
}
