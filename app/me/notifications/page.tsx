"use client"

import { useTranslations } from "next-intl"

import { NotificationsSection } from "@/components/mobile/me/notifications-section"
import { NotificationFeedMobile } from "@/components/mobile/notifications/notification-feed-mobile"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileNotificationsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("notificationsRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-notifications-page"
    >
      <div className="space-y-6">
        <NotificationFeedMobile />
        <NotificationsSection />
      </div>
    </SubPageShell>
  )
}
