"use client"

import React from "react"
import { Settings, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"

interface ProviderDetailPanelProvider {
  id: string
  name: string
  icon?: string | React.ReactNode
  modelCount?: number
}

interface ProviderDetailPanelProps {
  provider: ProviderDetailPanelProvider | null
  onTest?: () => void
  onToggleEnabled?: (enabled: boolean) => void
  onDelete?: () => void
  isEnabled?: boolean
  isTesting?: boolean
  isCustom?: boolean
  connectionStatus?: "connected" | "error" | "not-configured" | "warning"
  /** Tab content slots — passed by parent to inject actual tab components */
  configTab?: React.ReactNode
  modelsTab?: React.ReactNode
  costTab?: React.ReactNode
  advancedTab?: React.ReactNode
}

export function ProviderDetailPanel({
  provider,
  onToggleEnabled,
  onDelete,
  isEnabled,
  isCustom,
  connectionStatus,
  configTab,
  modelsTab,
  costTab,
  advancedTab,
}: ProviderDetailPanelProps) {
  const t = useTranslations("providers")

  if (provider === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Settings className="mx-auto h-12 w-12 text-muted-foreground/30" />
          <h3 className="mt-4 text-base font-semibold text-foreground">
            {t("detailPanel.emptyTitle")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("detailPanel.emptyDescription")}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
          {provider.icon ?? provider.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{provider.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {t("detailPanel.modelsAvailable", { count: provider.modelCount ?? 0 })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connectionStatus === "connected" && (
            <Badge
              variant="outline"
              className="border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
            >
              {t("detailPanel.connected") || "Connected"}
            </Badge>
          )}
          {connectionStatus === "error" && (
            <Badge
              variant="outline"
              className="border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
            >
              {t("detailPanel.connectionFailed") || "Error"}
            </Badge>
          )}
          {isCustom && onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Switch checked={isEnabled} onCheckedChange={onToggleEnabled} />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="config" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="w-full shrink-0 justify-start rounded-none border-b bg-transparent px-4">
          <TabsTrigger value="config">{t("tabs.config")}</TabsTrigger>
          <TabsTrigger value="models">{t("tabs.models")}</TabsTrigger>
          <TabsTrigger value="cost">{t("tabs.cost")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("tabs.advanced")}</TabsTrigger>
        </TabsList>
        <div className="flex-1 overflow-y-auto">
          <TabsContent value="config" className="m-0 p-4">
            {configTab ?? <div>Config placeholder</div>}
          </TabsContent>
          <TabsContent value="models" className="m-0 p-4">
            {modelsTab ?? <div>Models placeholder</div>}
          </TabsContent>
          <TabsContent value="cost" className="m-0 p-4">
            {costTab ?? <div>Cost placeholder</div>}
          </TabsContent>
          <TabsContent value="advanced" className="m-0 p-4">
            {advancedTab ?? <div>Advanced placeholder</div>}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
