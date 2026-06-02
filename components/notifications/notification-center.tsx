"use client"

// The notification center panel (ADR-0042) — the content of the status-bar
// bell popover. Lists the active feed (newest-first), supports source
// filtering, bulk mark-all-read, an archived view, per-row triage, and opening
// a notification (navigate via href + mark read). Reads the reactive store via
// `useNotifications`; archived rows are loaded on demand.

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { CheckCheckIcon, BellOffIcon, SettingsIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useNotifications } from "@/hooks/notifications/use-notifications"
import { dispatchNotificationCommand } from "@/lib/notifications/action-registry"
import { listNotifications } from "@/lib/db/notifications"
import {
  NOTIFICATION_SOURCES,
  type NotificationRecord,
  type NotificationSource,
} from "@/types/notifications"
import { NotificationItem } from "./notification-item"

export interface NotificationCenterProps {
  /** Called after navigating (e.g. to close the popover). */
  onNavigate?: () => void
}

export function NotificationCenter({ onNavigate }: NotificationCenterProps) {
  const t = useTranslations("notificationCenter")
  const router = useRouter()
  const {
    items,
    markRead,
    markDone,
    markAllRead,
    snooze,
    remove,
    sourceFilter,
    setSourceFilter,
    refresh,
  } = useNotifications()

  const [showDone, setShowDone] = useState(false)
  const [doneItems, setDoneItems] = useState<NotificationRecord[]>([])

  // Re-pull the active feed when the panel mounts so snooze-elapsed rows reappear.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!showDone) return
    void listNotifications({ includeDone: true, readStates: ["done"], limit: 100 }).then(
      setDoneItems
    )
  }, [showDone])

  const open = useCallback(
    (record: NotificationRecord) => {
      void markRead(record.id)
      if (record.href) {
        router.push(record.href)
        onNavigate?.()
      }
    },
    [markRead, router, onNavigate]
  )

  const runAction = useCallback(
    (record: NotificationRecord, command: string, args?: Record<string, unknown>) => {
      void dispatchNotificationCommand({ notificationId: record.id, command, args })
      void markRead(record.id)
    },
    [markRead]
  )

  const visible = showDone
    ? doneItems.filter((r) => !sourceFilter || r.source === sourceFilter)
    : items
  const empty = visible.length === 0

  return (
    <div className="flex max-h-[70vh] w-[22rem] flex-col" data-testid="notification-center">
      <header className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">{t("center.title")}</span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                {sourceFilter ? t(`sources.${sourceFilter}`) : t("center.filterAll")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuCheckboxItem
                checked={!sourceFilter}
                onCheckedChange={() => setSourceFilter(undefined)}
              >
                {t("center.filterAll")}
              </DropdownMenuCheckboxItem>
              {NOTIFICATION_SOURCES.map((s: NotificationSource) => (
                <DropdownMenuCheckboxItem
                  key={s}
                  checked={sourceFilter === s}
                  onCheckedChange={() => setSourceFilter(s)}
                >
                  {t(`sources.${s}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("center.markAllRead")}
            onClick={() => void markAllRead()}
          >
            <CheckCheckIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("center.settings")}
            onClick={() => {
              router.push("/settings?section=notifications")
              onNavigate?.()
            }}
          >
            <SettingsIcon className="size-4" />
          </Button>
        </div>
      </header>

      <Separator />

      <ScrollArea className="flex-1">
        {empty ? (
          <div
            className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground"
            data-testid="notification-empty"
          >
            <BellOffIcon className="size-6 opacity-50" aria-hidden />
            <span>{t("center.empty")}</span>
          </div>
        ) : (
          <div className="divide-y">
            {visible.map((record) => (
              <NotificationItem
                key={record.id}
                record={record}
                onOpen={open}
                onMarkRead={(id) => void markRead(id)}
                onMarkDone={(id) => void markDone(id)}
                onSnooze={(id, ms) => void snooze(id, ms)}
                onRemove={(id) => void remove(id)}
                onAction={runAction}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <Separator />
      <footer className="px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full justify-start text-xs text-muted-foreground"
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? t("center.hideDone") : t("center.showDone")}
        </Button>
      </footer>
    </div>
  )
}
