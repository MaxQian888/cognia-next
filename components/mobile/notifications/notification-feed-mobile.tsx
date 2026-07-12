"use client"

// Mobile notification center feed (ADR-0042) — the touch entry point. Renders
// the unified active feed full-width with always-visible row menus (no hover on
// touch), a mark-all-read action, and a refresh button (the store is reactive,
// but refresh re-surfaces snooze-elapsed rows). Reuses NotificationItem.

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { BellOffIcon, CheckCheckIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useNotifications } from "@/hooks/notifications/use-notifications"
import { dispatchNotificationCommand } from "@/lib/notifications/action-registry"
import type { NotificationRecord } from "@/types/notifications"
import { NotificationItem } from "@/components/notifications/notification-item"

export function NotificationFeedMobile() {
  const t = useTranslations("notificationCenter")
  const router = useRouter()
  const { items, markRead, markDone, markAllRead, snooze, remove, refresh } = useNotifications()

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = (record: NotificationRecord) => {
    void markRead(record.id)
    if (record.href) router.push(record.href)
  }

  const runAction = (record: NotificationRecord, command: string, args?: Record<string, unknown>) => {
    void dispatchNotificationCommand({ notificationId: record.id, command, args })
    void markRead(record.id)
  }

  return (
    <div className="flex flex-col" data-testid="notification-feed-mobile">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-sm font-medium">{t("center.title")}</span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t("center.markAllRead")}
            onClick={() => void markAllRead()}
          >
            <CheckCheckIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t("center.refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <div
          className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="notification-feed-empty"
        >
          <BellOffIcon className="size-6 opacity-50" aria-hidden />
          <span>{t("center.empty")}</span>
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {items.map((record) => (
            <NotificationItem
              key={record.id}
              record={record}
              menuAlwaysVisible
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
    </div>
  )
}
