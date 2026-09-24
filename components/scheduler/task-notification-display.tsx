"use client"

import { useTranslations } from "next-intl"
import { Bell } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { TaskNotificationConfig } from "@/types/scheduler"

interface TaskNotificationDisplayProps {
  notification: TaskNotificationConfig | undefined
  /**
   * `card` (default) draws its own titled card; `bare` renders only the
   * facts, for a host that already supplies the section title (the unified
   * item detail's ConsoleSection).
   */
  variant?: "card" | "bare"
  className?: string
}

type Translator = (key: string, values?: Record<string, string | number>) => string

function formatChannels(channels: string[] | undefined, t: Translator): string {
  if (!channels || channels.length === 0) return t("notifyChannels.none")
  return channels
    .map((ch) => {
      switch (ch) {
        case "desktop":
          return t("notifyChannels.desktop")
        case "toast":
          return t("notifyChannels.toast")
        case "webhook":
          return t("notifyChannels.webhook")
        case "im":
          return t("notifyChannels.im")
        default:
          return ch.charAt(0).toUpperCase() + ch.slice(1)
      }
    })
    .join(", ")
}

function formatNotifyOn(notification: TaskNotificationConfig | undefined, t: Translator): string {
  if (!notification) return t("notifyOnModes.never")
  const { onComplete, onError } = notification
  if (onComplete && onError) return t("notifyOnModes.always")
  if (onError && !onComplete) return t("notifyOnModes.failureOnly")
  if (onComplete && !onError) return t("notifyOnModes.successOnly")
  return t("notifyOnModes.never")
}

export function TaskNotificationDisplay({
  notification,
  className,
  variant = "card",
}: TaskNotificationDisplayProps) {
  const t = useTranslations("scheduler")

  const items = [
    {
      label: t("notificationChannels"),
      value: formatChannels(notification?.channels, t),
    },
    {
      label: t("notifyOn"),
      value: formatNotifyOn(notification, t),
    },
    // Read out only when armed: `onProgress` is off on every task that has no
    // mid-run reporter, and a row saying "off" on every one of them is noise.
    ...(notification?.onProgress
      ? [{ label: t("notifyOnProgress"), value: t("notifyOnModes.always") }]
      : []),
    // Same rule for the pet's due reminder: absent means on, so only the muted
    // state earns a row — it is also where a user who muted from the toast
    // finds the switch back.
    ...(notification?.dueReminder === false
      ? [{ label: t("notifyDueReminder"), value: t("dueReminderMuted") }]
      : []),
  ]

  const facts = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="task-notification-facts">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {item.label}
          </span>
          <span className="text-sm font-mono text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  )

  if (variant === "bare") return <div className={className}>{facts}</div>

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Bell className="h-4 w-4 text-amber-500" />
          {t("notificationConfig")}
        </h3>
        {facts}
      </CardContent>
    </Card>
  )
}
