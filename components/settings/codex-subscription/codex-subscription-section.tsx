"use client"

// Tabs shell for Settings → Codex Subscription. Parallel to the Claude
// Subscription section in `components/settings/subscription/`. Each tab is
// a self-contained surface under ./tabs/. The active tab is reflected in
// the URL `?subTab=` param so deep-linking lands on the right pane.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { SparklesIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { CodexSubscriptionOverviewTab } from "./tabs/overview-tab"
import { CodexSubscriptionAccountTab } from "./tabs/account-tab"
import { CodexSubscriptionUsageTab } from "./tabs/usage-tab"
import { CodexSubscriptionSettingsTab } from "./tabs/settings-tab"

const CODEX_SUBSCRIPTION_TAB_PARAM = "subTab"

export type CodexSubscriptionTabId = "overview" | "account" | "usage" | "settings"

const TAB_IDS: CodexSubscriptionTabId[] = ["overview", "account", "usage", "settings"]

function isCodexSubscriptionTab(value: string | null): value is CodexSubscriptionTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function CodexSubscriptionSection() {
  const t = useTranslations("codexSubscription")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(CODEX_SUBSCRIPTION_TAB_PARAM)
  const activeTab: CodexSubscriptionTabId = isCodexSubscriptionTab(requested)
    ? requested
    : "overview"

  const onTabChange = (value: string) => {
    if (!isCodexSubscriptionTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(CODEX_SUBSCRIPTION_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

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
          <CodexSubscriptionOverviewTab />
        </TabsContent>
        <TabsContent value="account" className="mt-4">
          <CodexSubscriptionAccountTab />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <CodexSubscriptionUsageTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <CodexSubscriptionSettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
