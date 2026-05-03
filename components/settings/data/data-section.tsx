"use client"

// Tabbed shell for the Data & Privacy settings section. Each tab is a self-
// contained surface — see `./tabs/`. The active tab is reflected in the URL
// `?dataTab=` param (separate from `?section=` which the outer settings shell
// owns) so deep-linking lands on the right pane.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
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

export function DataSection() {
  const t = useTranslations("settings.data")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(DATA_TAB_PARAM)
  const activeTab: DataTabId = isDataTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isDataTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(DATA_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
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
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="backup">{t("tabs.backup")}</TabsTrigger>
            <TabsTrigger value="domain">{t("tabs.domain")}</TabsTrigger>
            <TabsTrigger value="maintenance">{t("tabs.maintenance")}</TabsTrigger>
          </TabsList>
        </div>
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
