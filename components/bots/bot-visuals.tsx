"use client"

/**
 * Shared vocabulary for the `/bots` console: how a status, an executor, a
 * trigger kind and a resolution problem look wherever they appear.
 *
 * Same discipline as `components/devices/device-visuals.tsx`. A console reads
 * wrong when the same state is one colour in the rail and another in the
 * detail, so the mapping lives here once instead of being re-picked per
 * component. The hues are the ones the rest of the app already uses, so a user
 * who has learned "amber means look at this" does not relearn it here.
 *
 * Every one of these maps is exhaustive over a closed union on purpose:
 * adding a trigger kind or an executor is then a type error here rather than a
 * blank cell on screen.
 */

import {
  ActivityIcon,
  CalendarClockIcon,
  MessagesSquareIcon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareFunctionIcon,
  Users2Icon,
  UserRoundPenIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { BotTriggerKind } from "@/lib/bot/console/bot-rows"
import type { BotResolutionProblem } from "@/lib/bot/installed-bot"
import type { BotDefinitionSource, BotInstallationStatus } from "@/lib/db/bot-types"
import type { PluginBotExecutor } from "@/types/plugin/plugin-bot"
import { cn } from "@/lib/utils"

/**
 * `needs_setup` is amber rather than red: the installation is one binding away
 * from working, which is a task, not a failure. `disabled` is muted because
 * turning something off is an answer and should not compete for attention.
 */
const STATUS_TONE: Record<BotInstallationStatus, string> = {
  enabled: "text-emerald-600 dark:text-emerald-400",
  needs_setup: "text-amber-600 dark:text-amber-400",
  disabled: "text-muted-foreground",
}

const STATUS_DOT: Record<BotInstallationStatus, string> = {
  enabled: "bg-emerald-500",
  needs_setup: "bg-amber-500",
  disabled: "bg-muted-foreground/40",
}

const EXECUTOR_ICON: Record<PluginBotExecutor, LucideIcon> = {
  workflow: WorkflowIcon,
  squad: Users2Icon,
  "agent-turn": SparklesIcon,
  handler: SquareFunctionIcon,
}

const TRIGGER_ICON: Record<BotTriggerKind, LucideIcon> = {
  interaction: MessagesSquareIcon,
  event: ZapIcon,
  schedule: CalendarClockIcon,
  poll: RefreshCwIcon,
  derivedState: ActivityIcon,
  manual: PlayIcon,
}

const SOURCE_ICON: Record<BotDefinitionSource, LucideIcon> = {
  plugin: PlugIcon,
  local: UserRoundPenIcon,
}

export function BotStatusDot({
  status,
  className,
}: {
  status: BotInstallationStatus
  className?: string
}) {
  const t = useTranslations("bots")
  return (
    <span
      role="img"
      aria-label={t(`status.${status}`)}
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status], className)}
      data-status={status}
    />
  )
}

export function BotStatusBadge({
  status,
  className,
}: {
  status: BotInstallationStatus
  className?: string
}) {
  const t = useTranslations("bots")
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal", STATUS_TONE[status], className)}
      data-testid="bot-status-badge"
      data-status={status}
    >
      <span aria-hidden className={cn("inline-block size-1.5 rounded-full", STATUS_DOT[status])} />
      {t(`status.${status}`)}
    </Badge>
  )
}

/**
 * An installation whose definition is gone.
 *
 * Deliberately its own badge rather than a fourth status: the installation is
 * inert, not disabled. A user who sees "disabled" reaches for a switch, and
 * there is no switch that brings a missing plugin back.
 */
export function BotOrphanBadge({ className }: { className?: string }) {
  const t = useTranslations("bots")
  return (
    <Badge
      variant="outline"
      className={cn("font-normal text-muted-foreground", className)}
      data-testid="bot-orphan-badge"
    >
      {t("problem.definition_missing.badge")}
    </Badge>
  )
}

export function BotExecutorIcon({
  executor,
  className,
}: {
  executor: PluginBotExecutor
  className?: string
}) {
  const t = useTranslations("bots")
  const Icon = EXECUTOR_ICON[executor]
  return (
    <Icon
      role="img"
      aria-label={t(`executor.${executor}`)}
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      data-executor={executor}
    />
  )
}

export function BotTriggerIcon({ kind, className }: { kind: BotTriggerKind; className?: string }) {
  const t = useTranslations("bots")
  const Icon = TRIGGER_ICON[kind]
  return (
    <Icon
      role="img"
      aria-label={t(`trigger.kind.${kind}`)}
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      data-trigger-kind={kind}
    />
  )
}

export function BotSourceIcon({
  source,
  className,
}: {
  source: BotDefinitionSource
  className?: string
}) {
  const t = useTranslations("bots")
  const Icon = SOURCE_ICON[source]
  return (
    <Icon
      role="img"
      aria-label={t(`source.${source}`)}
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      data-source={source}
    />
  )
}

/**
 * One problem, in words, with its severity.
 *
 * The three kinds are kept apart rather than folded into one "unavailable"
 * line, because they need three different actions: reinstall the plugin,
 * accept or re-pin a version, or fix a handler that never loaded.
 */
export function useBotProblemText() {
  const t = useTranslations("bots")
  return (problem: BotResolutionProblem): { text: string; severe: boolean } => {
    switch (problem.kind) {
      case "definition_missing":
        return { text: t("problem.definition_missing.body"), severe: false }
      case "version_drift":
        return {
          text: t("problem.version_drift.body", {
            pinned: problem.pinned,
            available: problem.available,
          }),
          severe: false,
        }
      case "handler_missing":
        return { text: t("problem.handler_missing.body"), severe: true }
    }
  }
}

/**
 * "Every 5m", for the two trigger kinds that carry an interval.
 *
 * A key per unit rather than one key taking a unit string: the unit belongs to
 * the sentence, and a locale that writes the number after it has nowhere to
 * put an interpolated "m". No plural either, because the value is already
 * rounded to a single figure and the Jest intl mock resolves only `=N` and
 * `other`, so a `one` branch would be untestable.
 */
export function useBotIntervalText(): (everyMs: number) => string {
  const t = useTranslations("bots")
  return (everyMs) => {
    if (!Number.isFinite(everyMs) || everyMs <= 0) return t("notAvailable")
    if (everyMs >= 3_600_000)
      return t("trigger.everyHours", { value: Math.round(everyMs / 3_600_000) })
    if (everyMs >= 60_000) return t("trigger.everyMinutes", { value: Math.round(everyMs / 60_000) })
    return t("trigger.everySeconds", { value: Math.round(everyMs / 1000) })
  }
}

/** Relative time, or "never" when nothing has happened yet. */
export function useBotRelativeTime(): (value: number | undefined) => string {
  const format = useFormatter()
  const t = useTranslations("bots")
  return (value) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return t("never")
    return format.relativeTime(new Date(value))
  }
}
