"use client"

/**
 * Shared status vocabulary for the public status page: colours, icons and the
 * small labels every section uses.
 *
 * Status is never colour alone: every label carries an icon and text. Unknown
 * has its own neutral style and is never drawn as operational. A stale
 * reading keeps its words ("last reported …") but loses its colour, so an old
 * green cannot pass for a current one.
 */

import type { ComponentProps, ComponentType, ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleXIcon,
  ClockAlertIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  formatPercent,
  type Confidence,
  type DisplayStatus,
  type MonitoringStatus,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

export type CellStatus = DisplayStatus | "no_data"

interface StatusStyle {
  /** Solid fill for history cells and dots. */
  dot: string
  /** Tinted pill background + ring. */
  soft: string
  text: string
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>
}

export const STATUS_STYLES: Record<CellStatus, StatusStyle> = {
  operational: {
    dot: "bg-emerald-500",
    soft: "bg-emerald-500/10 ring-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2Icon,
  },
  maintenance: {
    dot: "bg-sky-500",
    soft: "bg-sky-500/10 ring-sky-500/20",
    text: "text-sky-700 dark:text-sky-300",
    icon: WrenchIcon,
  },
  degraded: {
    dot: "bg-amber-500",
    soft: "bg-amber-500/10 ring-amber-500/20",
    text: "text-amber-800 dark:text-amber-300",
    icon: CircleAlertIcon,
  },
  partial_outage: {
    dot: "bg-orange-500",
    soft: "bg-orange-500/10 ring-orange-500/20",
    text: "text-orange-800 dark:text-orange-300",
    icon: TriangleAlertIcon,
  },
  major_outage: {
    dot: "bg-rose-600",
    soft: "bg-rose-500/10 ring-rose-500/20",
    text: "text-rose-700 dark:text-rose-300",
    icon: CircleXIcon,
  },
  unknown: {
    dot: "bg-muted-foreground/45",
    soft: "bg-muted ring-border",
    text: "text-muted-foreground",
    icon: CircleHelpIcon,
  },
  no_data: {
    dot: "bg-transparent border border-dashed border-muted-foreground/30",
    soft: "bg-transparent ring-border",
    text: "text-muted-foreground",
    icon: CircleDashedIcon,
  },
}

/** Neutral style for a reading that is no longer current. */
export const STALE_STYLE: StatusStyle = {
  dot: "bg-muted-foreground/45",
  soft: "bg-muted ring-border",
  text: "text-muted-foreground",
  icon: ClockAlertIcon,
}

/** Order for the legend: worst last, unknown and no data kept visible. */
export const LEGEND_ORDER: CellStatus[] = [
  "operational",
  "maintenance",
  "degraded",
  "partial_outage",
  "major_outage",
  "unknown",
  "no_data",
]

export function StatusLabel({
  status,
  stale = false,
  pill = false,
  className,
}: {
  status: CellStatus
  stale?: boolean
  /** Tinted, rounded pill (component rows, incidents) instead of bare text. */
  pill?: boolean
  className?: string
}) {
  const t = useTranslations("publicStatus")
  const style = stale ? STALE_STYLE : STATUS_STYLES[status]
  const Icon = style.icon
  const word = t(`statuses.${status}`)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        pill && "rounded-full px-2.5 py-1 ring-1 ring-inset",
        pill && style.soft,
        style.text,
        className
      )}
      data-status={status}
      data-stale={stale || undefined}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {stale ? t("stale.label", { status: word }) : word}
    </span>
  )
}

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const t = useTranslations("publicStatus.confidence")
  return (
    <Badge
      variant="outline"
      className="font-normal text-muted-foreground"
      title={t(`${confidence}Hint`)}
      data-confidence={confidence}
    >
      {t(confidence)}
    </Badge>
  )
}

const MONITORING_TONE: Record<MonitoringStatus, string> = {
  healthy: "text-emerald-700 dark:text-emerald-300",
  limited: "text-amber-800 dark:text-amber-300",
  degraded: "text-orange-800 dark:text-orange-300",
  unknown: "text-muted-foreground",
}

export function MonitoringLabel({ status }: { status: MonitoringStatus }) {
  const t = useTranslations("publicStatus.monitoring")
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className={cn("text-sm font-medium", MONITORING_TONE[status])}
        title={t(`statusHints.${status}`)}
        data-monitoring={status}
      >
        {t(`statuses.${status}`)}
      </span>
      {status === "limited" ? (
        <Badge variant="outline" className="font-normal">
          {t("singleObserver")}
        </Badge>
      ) : null}
    </span>
  )
}

/** `99.95%`, or the translated "No data" for a null figure (never 100). */
export function usePercentLabel(): (value: number | null) => string {
  const t = useTranslations("publicStatus.hero")
  return (value) => {
    const formatted = formatPercent(value)
    return formatted === null ? t("noData") : t("percent", { value: formatted })
  }
}

export function SectionHeading({
  id,
  icon: Icon,
  title,
  description,
  action,
}: {
  id?: string
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  description?: string
  /** Right-aligned control or summary (wraps below on narrow screens). */
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex max-w-3xl min-w-0 items-start gap-3.5">
        <IconTile icon={Icon} />
        <div className="min-w-0">
          <h2 id={id} className="text-xl font-semibold tracking-tight md:text-2xl">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {action ? <div className="min-w-0">{action}</div> : null}
    </div>
  )
}

export type IconTone = "neutral" | "success" | "info" | "warning" | "danger"

const ICON_TONES: Record<IconTone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  info: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  danger: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
}

/** Square icon tile used by section headings, dialogs and empty states. */
export function IconTile({
  icon: Icon,
  tone = "neutral",
  size = "md",
  className,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  tone?: IconTone
  size?: "md" | "lg"
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        "grid shrink-0 place-items-center border",
        size === "lg" ? "size-12 rounded-2xl" : "size-9 rounded-xl",
        ICON_TONES[tone],
        className
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} aria-hidden />
    </span>
  )
}

/** The card every page section sits in. */
export function StatusPanel({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** Empty state inside a panel: icon tile, the empty sentence and context. */
export function PanelEmpty({
  icon,
  tone = "neutral",
  title,
  description,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  tone?: IconTone
  title: string
  description?: string
}) {
  return (
    <div className="flex items-start gap-4 p-5 sm:p-6">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}
