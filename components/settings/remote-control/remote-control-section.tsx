"use client"

// Tabbed shell for the Remote Control settings section. Mirrors
// `data/data-section.tsx` 1:1 — only the param name (`?remoteControlTab=`)
// and the tab ids differ. The four tab implementations live in `./tabs/`.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { RadioTowerIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EventsTab, InboundTab, OutboundTab, OverviewTab } from "./tabs"

const REMOTE_CONTROL_TAB_PARAM = "remoteControlTab"

export type RemoteControlTabId = "overview" | "inbound" | "outbound" | "events"

const TAB_IDS: RemoteControlTabId[] = ["overview", "inbound", "outbound", "events"]

function isRemoteControlTab(value: string | null): value is RemoteControlTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function RemoteControlSection() {
  const t = useTranslations("settings.remoteControl")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(REMOTE_CONTROL_TAB_PARAM)
  const activeTab: RemoteControlTabId = isRemoteControlTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isRemoteControlTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(REMOTE_CONTROL_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <RadioTowerIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="inbound">{t("tabs.inbound")}</TabsTrigger>
          <TabsTrigger value="outbound">{t("tabs.outbound")}</TabsTrigger>
          <TabsTrigger value="events">{t("tabs.events")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="inbound" className="mt-4">
          <InboundTab />
        </TabsContent>
        <TabsContent value="outbound" className="mt-4">
          <OutboundTab />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
