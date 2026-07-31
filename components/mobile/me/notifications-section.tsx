"use client"

/**
 * Notifications block for the mobile profile screen. Pairs the permission
 * CTA (which auto-hides when granted) with an entry that opens the queue
 * sheet so users can audit / cancel scheduled reminders. The sheet itself
 * handles the unsupported / loaded / error states.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon, ChevronRightIcon } from "lucide-react"

import { NotificationPermissionCta } from "@/components/mobile/notifications/notification-permission-cta"
import { NotificationsQueueSheet } from "@/components/mobile/notifications/notifications-queue-sheet"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

export function NotificationsSection() {
  const t = useTranslations("mobile.notifications.section")
  const [queueOpen, setQueueOpen] = useState(false)
  useBackDismiss(queueOpen, () => setQueueOpen(false))
  return (
    <section className="space-y-3 pt-2" data-testid="mobile-settings-notifications">
      <div className="space-y-0.5">
        <h3 className="text-xs font-semibold">{t("title")}</h3>
        <p className="text-[11px] text-muted-foreground">{t("description")}</p>
      </div>
      <NotificationPermissionCta />
      <Item
        size="sm"
        className="px-0"
        data-testid="mobile-settings-notifications-queue-entry"
        onClick={() => setQueueOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setQueueOpen(true)
          }
        }}
      >
        <ItemContent>
          <ItemTitle className="flex items-center gap-1.5 text-xs">
            <BellIcon className="size-3.5" aria-hidden="true" />
            {t("queueRowTitle")}
          </ItemTitle>
          <ItemDescription className="text-[11px]">{t("queueRowDescription")}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        </ItemActions>
      </Item>
      <NotificationsQueueSheet open={queueOpen} onOpenChange={setQueueOpen} />
    </section>
  )
}
