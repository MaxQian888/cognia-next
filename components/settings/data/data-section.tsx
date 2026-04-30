"use client"

// Tabbed shell for the Data & Privacy settings section. Each tab is a self-
// contained surface — see `./tabs/`. The active tab is reflected in the URL
// `?dataTab=` param (separate from `?section=` which the outer settings shell
// owns) so deep-linking lands on the right pane.

import { useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { DatabaseIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataOverviewTab, BackupRestoreTab, DomainTransferTab, MaintenanceTab } from "./tabs"

const DATA_TAB_PARAM = "dataTab"

export type DataTabId = "overview" | "backup" | "domain" | "maintenance"

const TAB_IDS: DataTabId[] = ["overview", "backup", "domain", "maintenance"]

function isDataTab(value: string | null): value is DataTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

const noopSubscribe = () => () => {}

function readTabFromUrl(): DataTabId {
  const params = new URLSearchParams(window.location.search)
  const requested = params.get(DATA_TAB_PARAM)
  return isDataTab(requested) ? requested : "overview"
}

export function DataSection() {
  const t = useTranslations("settings.data")
  // Hydrate from `?dataTab=` via useSyncExternalStore (no setState-in-effect),
  // then track local mutations through `userTab`. In embedded mode (settings
  // dialog) the URL is shared with the host page; we use a scoped param name
  // to avoid clobbering the outer `?section=`.
  const initialTab = useSyncExternalStore(
    noopSubscribe,
    readTabFromUrl,
    () => "overview" as DataTabId
  )
  const [userTab, setUserTab] = useState<DataTabId | null>(null)
  const activeTab = userTab ?? initialTab

  const onTabChange = (value: string) => {
    if (!isDataTab(value)) return
    setUserTab(value)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set(DATA_TAB_PARAM, value)
      window.history.replaceState({}, "", url.toString())
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <DatabaseIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="backup">{t("tabs.backup")}</TabsTrigger>
          <TabsTrigger value="domain">{t("tabs.domain")}</TabsTrigger>
          <TabsTrigger value="maintenance">{t("tabs.maintenance")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <DataOverviewTab />
        </TabsContent>
        <TabsContent value="backup" className="mt-4">
          <BackupRestoreTab />
        </TabsContent>
        <TabsContent value="domain" className="mt-4">
          <DomainTransferTab />
        </TabsContent>
        <TabsContent value="maintenance" className="mt-4">
          <MaintenanceTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
