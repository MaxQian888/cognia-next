"use client"

// Status-bar notification bell (ADR-0042). A popover trigger with a two-tier
// badge — a red numeric badge for "directed at you" unread (mentions,
// approvals, critical), a plain dot for ambient activity — opening the
// notification center. Styled to sit in the desktop status bar footer.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { BellIcon as AnimatedBellIcon } from "@/components/ui/bell"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useNotifications } from "@/hooks/notifications/use-notifications"
import { NotificationCenter } from "./notification-center"

export function NotificationBell({ className }: { className?: string }) {
  const t = useTranslations("notificationCenter")
  const { directedUnread, ambientUnseen } = useNotifications()
  const [open, setOpen] = useState(false)

  const hasDirected = directedUnread > 0
  const hasAmbient = !hasDirected && ambientUnseen > 0
  const ariaLabel = hasDirected ? t("bell.unreadAria", { count: directedUnread }) : t("bell.label")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-notifications"
          aria-label={ariaLabel}
          className={cn(
            "relative flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
            className
          )}
        >
          <AnimatedActionIcon icon={AnimatedBellIcon} size={12} />
          {hasDirected && (
            <span
              data-testid="notification-badge-count"
              className="flex min-w-3.5 items-center justify-center rounded-pill bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground"
            >
              {directedUnread > 99 ? "99+" : directedUnread}
            </span>
          )}
          {hasAmbient && (
            <span
              data-testid="notification-badge-dot"
              aria-label={t("bell.hasActivity")}
              className="size-1.5 rounded-full bg-muted-foreground/70"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="w-auto max-w-[calc(100vw-0.5rem)] overflow-hidden p-0"
      >
        <NotificationCenter onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
