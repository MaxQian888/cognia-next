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
import { MeSection } from "@/components/mobile/me/me-section"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

export function NotificationsSection() {
  const t = useTranslations("mobile.notifications.section")
  const [queueOpen, setQueueOpen] = useState(false)
  useBackDismiss(queueOpen, () => setQueueOpen(false))
  return (
    <div className="space-y-3" data-testid="mobile-settings-notifications">
      <NotificationPermissionCta />
      {/* The row used to sit bare at `px-0` under a hand-rolled h3, so the one
          entry on this block was the only /me row with no surface under it. */}
      <MeSection title={t("title")} description={t("description")}>
        <Item
          size="sm"
          className="px-3 py-2.5"
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
            <ItemTitle className="flex items-center gap-1.5 text-sm">
              <BellIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("queueRowTitle")}
            </ItemTitle>
            <ItemDescription className="text-xs">{t("queueRowDescription")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </ItemActions>
        </Item>
      </MeSection>
      <NotificationsQueueSheet open={queueOpen} onOpenChange={setQueueOpen} />
    </div>
  )
}
