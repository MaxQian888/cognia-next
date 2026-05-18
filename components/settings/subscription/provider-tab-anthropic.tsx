"use client"

// Claude provider tab. Combines the multi-account list with the four
// historical Anthropic-specific panes (Overview, Account, Usage, Settings).
// The four panes are kept as inner Tabs under this provider tab so the
// existing UX (live rate-limit gauges, probe configuration) is preserved.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { SubscriptionAccountTab } from "./tabs/account-tab"
import { SubscriptionOverviewTab } from "./tabs/overview-tab"
import { SubscriptionSettingsTab } from "./tabs/settings-tab"
import { SubscriptionUsageTab } from "./tabs/usage-tab"

import { AccountList } from "./account-list"
import { PresetPicker } from "./preset-picker"
import { AnthropicAddAccountDialog } from "./add-account-dialog/anthropic"

export type AnthropicInnerTab = "overview" | "account" | "usage" | "settings"

export interface ProviderTabAnthropicProps {
  /** Inner-tab id reflected in the URL `?innerTab=` param. */
  innerTab?: AnthropicInnerTab
  /** Invoked on inner-tab change so the parent can keep the URL in sync. */
  onInnerTabChange?: (next: AnthropicInnerTab) => void
}

const INNER_TABS: AnthropicInnerTab[] = ["overview", "account", "usage", "settings"]

function isInnerTab(value: string): value is AnthropicInnerTab {
  return (INNER_TABS as string[]).includes(value)
}

export function ProviderTabAnthropic({ innerTab, onInnerTabChange }: ProviderTabAnthropicProps) {
  const t = useTranslations("subscription")
  const [addOpen, setAddOpen] = useState(false)
  const active: AnthropicInnerTab = innerTab && isInnerTab(innerTab) ? innerTab : "overview"

  return (
    <div className="space-y-4">
      <AccountList provider="anthropic" onAdd={() => setAddOpen(true)} />
      <PresetPicker provider="anthropic" />
      <Tabs
        value={active}
        onValueChange={(v) => {
          if (isInnerTab(v)) onInnerTabChange?.(v)
        }}
      >
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="account">{t("tabs.account")}</TabsTrigger>
            <TabsTrigger value="usage">{t("tabs.usage")}</TabsTrigger>
            <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <SubscriptionOverviewTab onRequestAddAccount={() => setAddOpen(true)} />
        </TabsContent>
        <TabsContent value="account" className="mt-4">
          <SubscriptionAccountTab onRequestAddAccount={() => setAddOpen(true)} />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <SubscriptionUsageTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SubscriptionSettingsTab />
        </TabsContent>
      </Tabs>

      <AnthropicAddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
