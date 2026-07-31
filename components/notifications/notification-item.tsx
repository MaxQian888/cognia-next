"use client"

// One notification row in the center (ADR-0042). Shows source icon, level
// styling, unread affordance, coalesced count, inline actions, relative time,
// and a row menu (mark read / archive / snooze / remove). Pure presentational —
// all mutations come in as handlers from the center.

import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  BellIcon,
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  MessageSquareIcon,
  MoreVerticalIcon,
  PuzzleIcon,
  RotateCcwIcon,
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
  onRestore?: (id: string) => void
  /** Archived rows only expose actions that remain valid for done records. */
  archived?: boolean
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
  onRestore,
  archived = false,
  menuAlwaysVisible = false,
}: NotificationItemProps) {
  const t = useTranslations("notificationCenter")
  const format = useFormatter()
  // Anchor relative timestamps to a single render-time "now" so next-intl
  // doesn't fall back to an implicit current time (ENVIRONMENT_FALLBACK).
  const now = useNow()
  const Icon = SOURCE_ICON[record.source] ?? BellIcon
  const unread = record.readState === "unseen" || record.readState === "seen"

  return (
    <div
      className={cn(
        "group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2.5 overflow-hidden px-3 py-3 text-sm",
        unread ? "bg-accent/30" : "bg-transparent"
      )}
      data-testid="notification-item"
      data-unread={unread}
    >
      <div className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon aria-hidden className={cn("size-4", LEVEL_CLASS[record.level])} />
        <span
          aria-hidden
          className={cn(
            "absolute -top-0.5 -right-0.5 size-2 rounded-full border-2 border-popover",
            !unread && "opacity-0",
            record.directed ? "bg-destructive" : "bg-muted-foreground"
          )}
        />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-1">
          <button
            type="button"
            onClick={() => onOpen(record)}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <div className="flex min-w-0 items-start gap-1.5">
              <span
                className={cn(
                  "line-clamp-2 min-w-0 [overflow-wrap:anywhere]",
                  unread ? "font-medium text-foreground" : "font-normal"
                )}
              >
                {record.title}
              </span>
              {record.count > 1 && (
                <span className="mt-0.5 shrink-0 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                  {t("center.groupCount", { count: record.count - 1 })}
                </span>
              )}
            </div>
            {record.body && (
              <p className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-xs leading-relaxed text-muted-foreground">
                {record.body}
              </p>
            )}
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="truncate">{t(`sources.${record.source}`)}</span>
              <span aria-hidden>·</span>
              <time className="shrink-0" dateTime={new Date(record.createdAt).toISOString()}>
                {format.relativeTime(new Date(record.createdAt), now)}
              </time>
            </div>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "size-7 shrink-0 data-[state=open]:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100",
                  menuAlwaysVisible
                    ? "opacity-100"
                    : "opacity-70 sm:opacity-0 sm:group-hover:opacity-100"
                )}
                aria-label={t("center.itemActions")}
              >
                <MoreVerticalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {archived ? (
                <>
                  <DropdownMenuItem onClick={() => onRestore?.(record.id)}>
                    <RotateCcwIcon className="size-3.5" />
                    {t("center.restore")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : (
                <>
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
                </>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(record.id)}>
                <TrashIcon className="size-3.5" />
                {t("center.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {!archived && record.actions && record.actions.length > 0 && (
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5" data-testid="notification-actions">
            {record.actions.slice(0, 2).map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={a.variant === "primary" ? "default" : "outline"}
                className="h-7 max-w-full min-w-0 px-2.5 text-xs"
                onClick={() => onAction(record, a.command, a.args)}
              >
                <span className="truncate">{a.label}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
