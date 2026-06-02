"use client"

// One notification row in the center (ADR-0042). Shows source icon, level
// styling, unread affordance, coalesced count, inline actions, relative time,
// and a row menu (mark read / archive / snooze / remove). Pure presentational —
// all mutations come in as handlers from the center.

import { useFormatter, useTranslations } from "next-intl"
import {
  BellIcon,
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  MessageSquareIcon,
  MoreVerticalIcon,
  PuzzleIcon,
  SparklesIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SNOOZE_PRESETS_MS, type SnoozePreset } from "@/lib/notifications/snooze"
import type {
  NotificationRecord,
  NotificationSource,
  NotificationLevel,
} from "@/types/notifications"

const SOURCE_ICON: Record<NotificationSource, LucideIcon> = {
  scheduler: CalendarClockIcon,
  "agent-team": UsersIcon,
  plugin: PuzzleIcon,
  connector: MessageSquareIcon,
  session: SparklesIcon,
  workflow: WorkflowIcon,
  system: SettingsIcon,
}

const LEVEL_CLASS: Record<NotificationLevel, string> = {
  info: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
  critical: "text-destructive",
}

const SNOOZE_ORDER: SnoozePreset[] = ["15m", "1h", "3h", "1d"]

export interface NotificationItemProps {
  record: NotificationRecord
  onOpen: (record: NotificationRecord) => void
  onMarkRead: (id: string) => void
  onMarkDone: (id: string) => void
  onSnooze: (id: string, durationMs: number) => void
  onRemove: (id: string) => void
  onAction: (record: NotificationRecord, command: string, args?: Record<string, unknown>) => void
  /** Keep the row menu always visible (touch surfaces have no hover). */
  menuAlwaysVisible?: boolean
}

export function NotificationItem({
  record,
  onOpen,
  onMarkRead,
  onMarkDone,
  onSnooze,
  onRemove,
  onAction,
  menuAlwaysVisible = false,
}: NotificationItemProps) {
  const t = useTranslations("notificationCenter")
  const format = useFormatter()
  const Icon = SOURCE_ICON[record.source] ?? BellIcon
  const unread = record.readState === "unseen" || record.readState === "seen"

  return (
    <div
      className={cn(
        "group relative flex gap-2.5 px-3 py-2.5 text-sm",
        unread ? "bg-accent/30" : "bg-transparent"
      )}
      data-testid="notification-item"
      data-unread={unread}
    >
      {/* Unread dot — red for directed, muted for ambient. */}
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          !unread && "opacity-0",
          record.directed ? "bg-destructive" : "bg-muted-foreground/60"
        )}
      />

      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", LEVEL_CLASS[record.level])} />

      <button
        type="button"
        onClick={() => onOpen(record)}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <div className="flex items-center gap-1.5">
          <span className={cn("truncate", unread ? "font-medium" : "font-normal")}>
            {record.title}
          </span>
          {record.count > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("groupCount", { count: record.count - 1 })}
            </span>
          )}
        </div>
        {record.body && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{record.body}</p>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{t(`sources.${record.source}`)}</span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(record.createdAt).toISOString()}>
            {format.relativeTime(new Date(record.createdAt))}
          </time>
        </div>
      </button>

      <div className="flex shrink-0 items-start gap-1">
        {record.actions?.slice(0, 2).map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={a.variant === "primary" ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => onAction(record, a.command, a.args)}
          >
            {a.label}
          </Button>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                "size-6 data-[state=open]:opacity-100",
                menuAlwaysVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-label={t("center.settings")}
            >
              <MoreVerticalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {unread && (
              <DropdownMenuItem onClick={() => onMarkRead(record.id)}>
                <CheckIcon className="size-3.5" />
                {t("center.markRead")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onMarkDone(record.id)}>
              <CheckIcon className="size-3.5" />
              {t("center.markDone")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <ClockIcon className="size-3.5" />
              {t("center.snooze")}
            </DropdownMenuLabel>
            {SNOOZE_ORDER.map((preset) => (
              <DropdownMenuItem
                key={preset}
                onClick={() => onSnooze(record.id, SNOOZE_PRESETS_MS[preset])}
              >
                {t(`snoozePresets.${preset}`)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onRemove(record.id)}>
              <TrashIcon className="size-3.5" />
              {t("center.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
