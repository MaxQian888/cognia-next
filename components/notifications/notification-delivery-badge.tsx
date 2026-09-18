"use client"

// Per-record external-delivery status. When a notification fact carries a
// `logicalKey`, this badge lazy-loads the durable intents the coordinator
// minted for it and surfaces the aggregate outcome — how many deliveries were
// attempted and the most severe status among them. Nothing renders when the
// fact never left the app (no intents), so legacy records stay clean.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCheckIcon,
  CircleAlertIcon,
  LoaderIcon,
  SendIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { listNotificationDeliveries } from "@/lib/notifications/api"
import type { NotificationIntentStatus } from "@/types/notifications/delivery"

type Aggregate = "pending" | "accepted" | "failed" | "mixed"

const STATUS_RANK: Record<NotificationIntentStatus, number> = {
  "delivery-unknown": 5,
  failed: 4,
  rejected: 3,
  sending: 2,
  queued: 2,
  prepared: 1,
  accepted: 0,
  superseded: -1,
  cancelled: -1,
  expired: -1,
}

const AGGREGATE_ICON: Record<Aggregate, LucideIcon> = {
  pending: SendIcon,
  accepted: CheckCheckIcon,
  failed: CircleAlertIcon,
  mixed: LoaderIcon,
}

const AGGREGATE_CLASS: Record<Aggregate, string> = {
  pending: "text-muted-foreground",
  accepted: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  mixed: "text-amber-600 dark:text-amber-400",
}

function aggregate(intents: { status: NotificationIntentStatus }[]): Aggregate | null {
  const live = intents.filter(
    (i) => i.status !== "superseded" && i.status !== "cancelled" && i.status !== "expired"
  )
  if (live.length === 0) return null
  const worst = Math.max(...live.map((i) => STATUS_RANK[i.status]))
  const anyPending = live.some(
    (i) => i.status === "prepared" || i.status === "queued" || i.status === "sending"
  )
  const anyFailed = live.some(
    (i) => i.status === "failed" || i.status === "rejected" || i.status === "delivery-unknown"
  )
  if (anyPending && anyFailed) return "mixed"
  if (worst >= 3) return "failed"
  if (anyPending) return "pending"
  return "accepted"
}

export function NotificationDeliveryBadge({ logicalKey }: { logicalKey: string }) {
  const t = useTranslations("notificationCenter.delivery")
  const [state, setState] = useState<{ count: number; agg: Aggregate } | null>(null)

  useEffect(() => {
    let cancelled = false
    void listNotificationDeliveries(logicalKey)
      .then((intents) => {
        if (cancelled) return
        const agg = aggregate(intents)
        if (agg !== null) setState({ count: intents.length, agg })
      })
      .catch(() => {
        /* diagnostics are best-effort — a failed read hides the badge */
      })
    return () => {
      cancelled = true
    }
  }, [logicalKey])

  if (!state) return null
  const Icon = AGGREGATE_ICON[state.agg]
  return (
    <span
      data-testid="delivery-badge"
      data-status={state.agg}
      title={t(`status.${state.agg}`, { count: state.count })}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-pill bg-muted px-1.5 text-[10px] leading-4",
        AGGREGATE_CLASS[state.agg]
      )}
    >
      <Icon aria-hidden className="size-2.5" />
      {t(`short.${state.agg}`, { count: state.count })}
    </span>
  )
}
