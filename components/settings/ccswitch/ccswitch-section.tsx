"use client"

// Tabbed shell for the Settings → CCSwitch section. Mirrors the pattern in
// components/settings/data/data-section.tsx — each tab is a self-contained
// surface under ./tabs/. The active tab is reflected in the URL
// `?ccswitchTab=` param so deep-linking lands on the right pane.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeftRightIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import {
  CcswitchOverviewTab,
  CcswitchProvidersTab,
  CcswitchMcpTab,
  CcswitchPromptsTab,
  CcswitchSkillsTab,
  CcswitchSyncTab,
} from "./tabs"

const CCSWITCH_TAB_PARAM = "ccswitchTab"

export type CcswitchTabId = "overview" | "providers" | "mcp" | "prompts" | "skills" | "sync"

const TAB_IDS: CcswitchTabId[] = ["overview", "providers", "mcp", "prompts", "skills", "sync"]

function isCcswitchTab(value: string | null): value is CcswitchTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function CcswitchSection() {
  const t = useTranslations("ccswitch")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(CCSWITCH_TAB_PARAM)
  const activeTab: CcswitchTabId = isCcswitchTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isCcswitchTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(CCSWITCH_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ArrowLeftRightIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="providers">{t("tabs.providers")}</TabsTrigger>
            <TabsTrigger value="mcp">{t("tabs.mcp")}</TabsTrigger>
            <TabsTrigger value="prompts">{t("tabs.prompts")}</TabsTrigger>
            <TabsTrigger value="skills">{t("tabs.skills")}</TabsTrigger>
            <TabsTrigger value="sync">{t("tabs.sync")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <CcswitchOverviewTab />
        </TabsContent>
        <TabsContent value="providers" className="mt-4">
          <CcswitchProvidersTab />
        </TabsContent>
        <TabsContent value="mcp" className="mt-4">
          <CcswitchMcpTab />
        </TabsContent>
        <TabsContent value="prompts" className="mt-4">
          <CcswitchPromptsTab />
        </TabsContent>
        <TabsContent value="skills" className="mt-4">
          <CcswitchSkillsTab />
        </TabsContent>
        <TabsContent value="sync" className="mt-4">
          <CcswitchSyncTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
