"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { SubscriptionSection } from "@/components/settings/subscription/subscription-section"

export default function MobileSubscriptionPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("subscriptionRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-subscription-page"
    >
      <SubscriptionSection />
    </SubPageShell>
  )
}
