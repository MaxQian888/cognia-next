"use client"

/**
 * The run's notification deliveries, inside the run cockpit.
 *
 * Every external notification the coordinator minted for this run — a Feishu
 * webhook post, a connector message — is a durable intent. This tab surfaces
 * them: which target each went to, what it was for, and where it stands
 * (queued / sending / accepted / failed / delivery-unknown). It reads the
 * intent ledger reactively, so a send that lands while the reader watches
 * updates in place. Runs that produced no external notifications show a calm
 * empty state rather than an error — most runs notify only in-app.
 */

import { useMemo } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  BellOffIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  LoaderIcon,
  SendIcon,
  WebhookIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useClientLiveQuery } from "@/hooks/data"
import { listNotificationDeliveriesForRun } from "@/lib/notifications/api"
import { getNotificationTarget } from "@/lib/db/notification-targets"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type {
  NotificationDeliveryIntent,
  NotificationIntentStatus,
} from "@/types/notifications/delivery"

const STATUS_ICON: Record<NotificationIntentStatus, LucideIcon> = {
  prepared: SendIcon,
  queued: SendIcon,
  sending: LoaderIcon,
  accepted: CheckCheckIcon,
  rejected: CircleAlertIcon,
  failed: CircleAlertIcon,
  "delivery-unknown": CircleAlertIcon,
  superseded: LoaderIcon,
  cancelled: BellOffIcon,
  expired: BellOffIcon,
}

const STATUS_CLASS: Record<NotificationIntentStatus, string> = {
  prepared: "text-muted-foreground",
  queued: "text-muted-foreground",
  sending: "text-muted-foreground",
  accepted: "text-emerald-600 dark:text-emerald-400",
  rejected: "text-destructive",
  failed: "text-destructive",
  "delivery-unknown": "text-amber-600 dark:text-amber-400",
  superseded: "text-muted-foreground",
  cancelled: "text-muted-foreground",
  expired: "text-muted-foreground",
}

export interface RunNotificationsTabProps {
  row: UnifiedExecutionRow
}

export function RunNotificationsTab({ row }: RunNotificationsTabProps) {
  const t = useTranslations("agentRuns.notifications")
  const format = useFormatter()
  const now = useNow()

  const intents = useClientLiveQuery(
    () =>
      row.runId
        ? listNotificationDeliveriesForRun(row.runId)
        : Promise.resolve([] as NotificationDeliveryIntent[]),
    [row.runId],
    [] as NotificationDeliveryIntent[]
  )

  // Join each intent to its target's operator label. Intents freeze the
  // address but not the label, so the live target row supplies it — a target
  // renamed or deleted since send still names the destination the user meant.
  const targetLabels = useClientLiveQuery(
    async () => {
      const map = new Map<string, string>()
      for (const intent of intents ?? []) {
        if (map.has(intent.targetId)) continue
        const target = await getNotificationTarget(intent.targetId)
        map.set(intent.targetId, target?.label ?? intent.targetId)
      }
      return map
    },
    [intents],
    new Map<string, string>()
  )

  const sorted = useMemo(
    () => [...(intents ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [intents]
  )

  if (intents === undefined) {
    return <p className="py-4 text-center text-xs text-muted-foreground">{t("loading")}</p>
  }
  if (sorted.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 py-8 text-center"
        data-testid="run-notifications-empty"
      >
        <BellOffIcon className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5" data-testid="run-notifications-tab">
      {sorted.map((intent) => {
        const StatusIcon = STATUS_ICON[intent.status]
        return (
          <div
            key={intent.id}
            className="flex items-center justify-between rounded-md border px-3 py-2"
            data-testid="run-notification-intent"
            data-status={intent.status}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                {intent.targetAddress.kind === "feishu-webhook" ? (
                  <WebhookIcon className="size-3.5" />
                ) : (
                  <SendIcon className="size-3.5" />
                )}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {targetLabels?.get(intent.targetId) ?? intent.targetId}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t(`purpose.${intent.purpose}`)} · {t(`kind.${intent.targetAddress.kind}`)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <time
                className="text-[11px] text-muted-foreground"
                dateTime={new Date(intent.createdAt).toISOString()}
              >
                {format.relativeTime(new Date(intent.createdAt), now)}
              </time>
              <span
                className={cn("flex items-center gap-1 text-[11px]", STATUS_CLASS[intent.status])}
              >
                <StatusIcon aria-hidden className="size-3" />
                {t(`status.${intent.status}`)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
