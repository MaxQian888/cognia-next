"use client"

/**
 * The scheduler's visual vocabulary, in one place (ADR-0179).
 *
 * Every pane used to carry its own copy of the kind icon table and its own
 * literal `green-500 / yellow-500 / red-500` status palette, so the list, the
 * three detail compositions and the run sheet each drifted a shade. The
 * tokens here follow `components/bots/bot-visuals.tsx`: a tinted plate for
 * the kind, one dot and one badge for the item status, one tone map for
 * attention severity.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  BotIcon,
  CalendarClockIcon,
  CogIcon,
  PlugIcon,
  SendIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatInterval } from "@/lib/scheduler/format-utils"
import type { AttentionSeverity } from "@/lib/scheduler/attention"
import type {
  ScheduledItemKind,
  UnifiedItemStatus,
  UnifiedScheduledItem,
  UnifiedTriggerSummary,
} from "@/types/scheduler/unified"

export const KIND_ICON: Record<ScheduledItemKind, LucideIcon> = {
  app: CalendarClockIcon,
  workflow: WorkflowIcon,
  backup: ArchiveIcon,
  plugin: PlugIcon,
  system: CogIcon,
  connector: SendIcon,
}

/** A tinted plate behind the kind icon, the way `/bots` plates its executor. */
export const KIND_PLATE: Record<ScheduledItemKind, string> = {
  app: "bg-primary/10 text-primary",
  workflow: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  backup: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  plugin: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  system: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  connector: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
}

export function KindIcon({ kind, className }: { kind: ScheduledItemKind; className?: string }) {
  const Icon = KIND_ICON[kind]
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden="true" />
}

/** The kind icon on its plate, for a masthead. */
export function KindPlate({ kind, className }: { kind: ScheduledItemKind; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        KIND_PLATE[kind],
        className
      )}
      data-testid={`kind-plate-${kind}`}
    >
      <KindIcon kind={kind} className="size-4.5 text-current" />
    </span>
  )
}

const STATUS_DOT: Record<UnifiedItemStatus, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  disabled: "bg-muted-foreground/50",
  expired: "bg-red-500",
  unknown: "bg-muted-foreground/30",
}

const STATUS_BADGE: Record<UnifiedItemStatus, string> = {
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  paused: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  disabled: "border-border bg-muted text-muted-foreground",
  expired: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  unknown: "border-border bg-muted text-muted-foreground",
}

export function ItemStatusDot({
  status,
  className,
}: {
  status: UnifiedItemStatus
  className?: string
}) {
  const t = useTranslations("scheduler.statuses")
  return (
    <span
      role="img"
      aria-label={t(status)}
      data-testid={`item-status-dot-${status}`}
      className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status], className)}
    />
  )
}

export function ItemStatusBadge({ status }: { status: UnifiedItemStatus }) {
  const t = useTranslations("scheduler.statuses")
  return (
    <Badge
      variant="outline"
      className={cn("h-5 px-1.5 text-[10px] font-medium", STATUS_BADGE[status])}
      data-testid={`item-status-badge-${status}`}
    >
      {t(status)}
    </Badge>
  )
}

/** Who scheduled it, when it was not the user. */
export function AuthoredByBadge({ source }: { source: UnifiedScheduledItem["createdBySource"] }) {
  const t = useTranslations("scheduler.authoredBy")
  if (source !== "agent" && source !== "plugin") return null
  return (
    <Badge
      variant="outline"
      className="h-4 gap-1 px-1 text-[10px] font-normal text-muted-foreground"
      title={t(`${source}Hint`)}
      data-testid={`authored-by-${source}`}
    >
      <BotIcon className="size-2.5" aria-hidden="true" />
      {t(source)}
    </Badge>
  )
}

/** Tone classes for an attention severity: text, and a dot. */
export const SEVERITY_TONE: Record<
  AttentionSeverity,
  { text: string; dot: string; border: string }
> = {
  critical: {
    text: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
    border: "border-red-500/30",
  },
  attention: {
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    border: "border-amber-500/30",
  },
  info: {
    text: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    border: "border-sky-500/30",
  },
}

/**
 * One line for a trigger. The cron expression when there is one, an
 * interval in units a reader can parse, the event name, or the type's label.
 */
export function useTriggerText(): (trigger: UnifiedTriggerSummary) => string {
  const t = useTranslations("scheduler")
  return (trigger) => {
    switch (trigger.type) {
      case "cron":
        return trigger.cron ?? t("triggerTypes.cron")
      case "interval":
        return t("every", { interval: formatInterval(trigger.intervalMs) })
      case "once":
        return trigger.runAtMs ? new Date(trigger.runAtMs).toLocaleString() : t("triggerTypes.once")
      case "event":
        return trigger.eventType ?? t("triggerTypes.event")
      default:
        return trigger.type
    }
  }
}
