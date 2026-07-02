"use client"

/**
 * Settings → Network Proxy. Tabs: General (mode + protocol + host/port +
 * auth + bypass), Detection (one-click probe + Apply), Test (try a URL via
 * the configured proxy and surface latency/status).
 *
 * The active tab is reflected in the URL `?networkTab=` param so deep-links
 * land on the right pane. Mirrors the convention of every other tabbed
 * settings section under `components/settings/`.
 */

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { NetworkIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { NetworkGeneralTab } from "./tabs/general-tab"
import { NetworkDetectionTab } from "./tabs/detection-tab"
import { NetworkTestTab } from "./tabs/test-tab"
import { NetworkIpInfoTab } from "./tabs/ip-info-tab"

const NETWORK_TAB_PARAM = "networkTab"

export type NetworkTabId = "general" | "detection" | "test" | "ipinfo"
const TAB_IDS: NetworkTabId[] = ["general", "detection", "test", "ipinfo"]

function isNetworkTab(value: string | null): value is NetworkTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function NetworkSection() {
  const t = useTranslations("settings.network")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(NETWORK_TAB_PARAM)
  const activeTab: NetworkTabId = isNetworkTab(requested) ? requested : "general"

  const onTabChange = (value: string) => {
    if (!isNetworkTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(NETWORK_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <NetworkIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="general">{t("tabs.general")}</TabsTrigger>
            <TabsTrigger value="detection">{t("tabs.detection")}</TabsTrigger>
            <TabsTrigger value="test">{t("tabs.test")}</TabsTrigger>
            <TabsTrigger value="ipinfo">{t("tabs.ipInfo")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="general" className="mt-4">
          <NetworkGeneralTab />
        </TabsContent>
        <TabsContent value="detection" className="mt-4">
          <NetworkDetectionTab />
        </TabsContent>
        <TabsContent value="test" className="mt-4">
          <NetworkTestTab />
        </TabsContent>
        <TabsContent value="ipinfo" className="mt-4">
          <NetworkIpInfoTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
