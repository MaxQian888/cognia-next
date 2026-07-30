"use client"

import { useTranslations } from "next-intl"
import { Bell } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { TaskNotificationConfig } from "@/types/scheduler"

interface TaskNotificationDisplayProps {
  notification: TaskNotificationConfig | undefined
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

export function TaskNotificationDisplay({ notification, className }: TaskNotificationDisplayProps) {
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
  ]

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Bell className="h-4 w-4 text-amber-500" />
          {t("notificationConfig")}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div key={item.label} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {item.label}
              </span>
              <span className="text-sm font-mono text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
