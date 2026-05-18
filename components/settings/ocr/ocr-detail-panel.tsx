"use client"

/**
 * OCR detail panel — sibling of `provider-detail-panel.tsx`.
 *
 * Header (icon + label + category subtitle + status badge + enable switch) +
 * tabs (Config / Models / Advanced) with content slots passed by the parent.
 */

import React from "react"
import { useTranslations } from "next-intl"
import { Check, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { OcrProviderCategory } from "@/lib/ocr/types"
import { ocrProviderInitial, type OcrProviderStatus } from "./ocr-sidebar-item"

export interface OcrDetailPanelProvider {
  id: string
  name: string
  category: OcrProviderCategory
}

interface OcrDetailPanelProps {
  provider: OcrDetailPanelProvider
  status: OcrProviderStatus
  isEnabled: boolean
  onToggleEnabled: (next: boolean) => void
  configTab: React.ReactNode
  modelsTab: React.ReactNode
  advancedTab: React.ReactNode
}

export function OcrDetailPanel({
  provider,
  status,
  isEnabled,
  onToggleEnabled,
  configTab,
  modelsTab,
  advancedTab,
}: OcrDetailPanelProps): React.ReactElement {
  const t = useTranslations()

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="ocr-detail-panel">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
          {ocrProviderInitial(provider.id)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{provider.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {t(`ocr.categories.${provider.category}`)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={status} label={t(`ocr.status.${statusKey(status)}`)} />
          <Switch
            checked={isEnabled}
            onCheckedChange={onToggleEnabled}
            aria-label={t("ocr.detail.enable")}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="config" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="w-full shrink-0 justify-start rounded-none border-b bg-transparent px-4">
          <TabsTrigger value="config">{t("ocr.detail.tabsConfig")}</TabsTrigger>
          <TabsTrigger value="models">{t("ocr.detail.tabsModels")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("ocr.detail.tabsAdvanced")}</TabsTrigger>
        </TabsList>
        <div className="flex-1 overflow-y-auto">
          <TabsContent value="config" className="m-0 p-4">
            {configTab}
          </TabsContent>
          <TabsContent value="models" className="m-0 p-4">
            {modelsTab}
          </TabsContent>
          <TabsContent value="advanced" className="m-0 p-4">
            {advancedTab}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

function StatusPill({ status, label }: { status: OcrProviderStatus; label: string }) {
  const className = (() => {
    switch (status) {
      case "ready":
      case "connected":
        return "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
      case "error":
        return "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
      case "unsupported":
        return "border-muted-foreground/30 bg-muted/40 text-muted-foreground"
      case "not-configured":
      default:
        return "border-muted-foreground/20 bg-muted/50 text-muted-foreground"
    }
  })()
  const Icon = status === "error" ? X : Check
  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn("gap-1 text-[10px] px-1.5 py-0", className)}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  )
}

function statusKey(status: OcrProviderStatus): string {
  switch (status) {
    case "not-configured":
      return "notConfigured"
    default:
      return status
  }
}
