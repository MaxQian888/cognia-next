"use client"

// Tabs shell for Settings → Subscription. Mirrors the pattern in
// components/settings/ccswitch/ccswitch-section.tsx — each tab is a
// self-contained surface under ./tabs/. The active tab is reflected in the
// URL `?subTab=` param so deep-linking lands on the right pane.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ZapIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { SubscriptionOverviewTab } from "./tabs/overview-tab"
import { SubscriptionAccountTab } from "./tabs/account-tab"
import { SubscriptionUsageTab } from "./tabs/usage-tab"
import { SubscriptionSettingsTab } from "./tabs/settings-tab"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

const SUBSCRIPTION_TAB_PARAM = "subTab"

export type SubscriptionTabId = "overview" | "account" | "usage" | "settings"

const TAB_IDS: SubscriptionTabId[] = ["overview", "account", "usage", "settings"]

function isSubscriptionTab(value: string | null): value is SubscriptionTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function SubscriptionSection() {
  const t = useTranslations("subscription")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(SUBSCRIPTION_TAB_PARAM)
  const activeTab: SubscriptionTabId = isSubscriptionTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isSubscriptionTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(SUBSCRIPTION_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ZapIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="subscription" targets={CLAUDE_CODE_RELATED} />

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="account">{t("tabs.account")}</TabsTrigger>
            <TabsTrigger value="usage">{t("tabs.usage")}</TabsTrigger>
            <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <SubscriptionOverviewTab />
        </TabsContent>
        <TabsContent value="account" className="mt-4">
          <SubscriptionAccountTab />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <SubscriptionUsageTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SubscriptionSettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
