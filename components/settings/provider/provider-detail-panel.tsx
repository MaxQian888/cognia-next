"use client"

import React from "react"
import { Settings, Star, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { hasBrandIcon } from "@/components/icons/brand-icon"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"

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
  /** This provider is the app-wide default for new chats. */
  isDefault?: boolean
  /**
   * Make this provider the app-wide default (`AppSettings.defaultProvider`).
   * Omit to hide the action (e.g. read-only contexts).
   */
  onSetDefault?: () => void
  isEnabled?: boolean
  /** Whether an incomplete disabled provider may be enabled. */
  canEnable?: boolean
  isTesting?: boolean
  isCustom?: boolean
  connectionStatus?: "connected" | "error" | "not-configured" | "warning" | "limited" | "untested"
  /** Tab content slots — passed by parent to inject actual tab components */
  configTab?: React.ReactNode
  modelsTab?: React.ReactNode
  costTab?: React.ReactNode
  diagnosticsTab?: React.ReactNode
  advancedTab?: React.ReactNode
}

export function ProviderDetailPanel({
  provider,
  onToggleEnabled,
  onDelete,
  isDefault,
  onSetDefault,
  isEnabled,
  canEnable = true,
  isCustom,
  connectionStatus,
  configTab,
  modelsTab,
  costTab,
  diagnosticsTab,
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
        {hasBrandIcon(provider.id) || provider.icon == null ? (
          <ProviderIcon providerId={provider.id} label={provider.name} size={40} />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
            {provider.icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{provider.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {t("detailPanel.modelsAvailable", { count: provider.modelCount ?? 0 })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isDefault ? (
            <Badge variant="secondary" data-testid="provider-default-badge" className="gap-1">
              <Star className="h-3 w-3" />
              {t("detailPanel.defaultBadge")}
            </Badge>
          ) : onSetDefault ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              data-testid="provider-set-default"
              aria-label={t("detailPanel.setDefaultAria")}
              title={t("detailPanel.setDefaultAria")}
              onClick={onSetDefault}
            >
              <Star className="h-3 w-3" />
              {t("detailPanel.setDefault")}
            </Button>
          ) : null}
          {connectionStatus === "connected" && (
            <Badge
              variant="outline"
              className="border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
            >
              {t("detailPanel.connected")}
            </Badge>
          )}
          {connectionStatus === "error" && (
            <Badge
              variant="outline"
              className="border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
            >
              {t("detailPanel.connectionFailed")}
            </Badge>
          )}
          {connectionStatus === "limited" && (
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400"
            >
              {t("verificationLimitedShort")}
            </Badge>
          )}
          {connectionStatus === "untested" && (
            <Badge variant="outline" className="text-muted-foreground">
              {t("sidebar.statusUntested")}
            </Badge>
          )}
          {connectionStatus === "warning" && (
            <Badge
              variant="outline"
              title={t("detailPanel.warningHint")}
              className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400"
            >
              {t("detailPanel.warning")}
            </Badge>
          )}
          {connectionStatus === "not-configured" && (
            <Badge
              variant="outline"
              className="text-muted-foreground"
              title={t("detailPanel.notConfiguredHint")}
            >
              {t("detailPanel.notConfigured")}
            </Badge>
          )}
          {isCustom && onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label={t("delete")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Switch
            checked={isEnabled}
            disabled={!isEnabled && !canEnable}
            onCheckedChange={onToggleEnabled}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="config" className="flex flex-1 flex-col overflow-hidden">
        {/* A tab appears only when its slot is filled. Local inference engines
            have no cloud models/cost/routing story, so they render just Config
            — and still keep the shared header (enable switch, default badge,
            status) instead of replacing the whole panel with a foreign shell. */}
        <TabsList className="w-full shrink-0 justify-start rounded-none border-b bg-transparent px-4">
          <TabsTrigger value="config">{t("tabs.config")}</TabsTrigger>
          {modelsTab && <TabsTrigger value="models">{t("tabs.models")}</TabsTrigger>}
          {costTab && <TabsTrigger value="cost">{t("tabs.cost")}</TabsTrigger>}
          {diagnosticsTab && <TabsTrigger value="diagnostics">{t("tabs.diagnostics")}</TabsTrigger>}
          {advancedTab && <TabsTrigger value="advanced">{t("tabs.advanced")}</TabsTrigger>}
        </TabsList>
        {/* Themed `ScrollArea`, matching this feature's dialogs — a native
            scrollbar here made the pane and the dialogs look unrelated.

            `max-w-4xl`: the providers section opts out of the settings shell's
            `max-w-5xl` cap (it owns a fill-height master/detail frame), so on an
            ultrawide window these forms stretched edge to edge. The cap lives
            here, once, rather than in each of Config / Models / Cost / Advanced.
            Container queries still resolve against `@container/provider-pane`
            one level up, so the cost tab's `@3xl` grid is unaffected. */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-4xl">
            <TabsContent value="config" className="m-0 p-4">
              {configTab ?? <div>{t("detailPanel.configPlaceholder")}</div>}
            </TabsContent>
            {modelsTab && (
              <TabsContent value="models" className="m-0 p-4">
                {modelsTab}
              </TabsContent>
            )}
            {costTab && (
              <TabsContent value="cost" className="m-0 p-4">
                {costTab}
              </TabsContent>
            )}
            {diagnosticsTab && (
              <TabsContent value="diagnostics" className="m-0 p-4">
                {diagnosticsTab}
              </TabsContent>
            )}
            {advancedTab && (
              <TabsContent value="advanced" className="m-0 p-4">
                {advancedTab}
              </TabsContent>
            )}
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}
