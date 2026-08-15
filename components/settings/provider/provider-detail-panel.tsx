"use client"

import React from "react"
import { Settings, Star, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { hasBrandIcon } from "@/components/icons/brand-icon"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { cn } from "@/lib/utils"

/** Tab order. A tab renders only when its slot is filled (Config is always on). */
const TAB_KEYS = ["config", "models", "cost", "diagnostics", "advanced"] as const

type TabKey = (typeof TAB_KEYS)[number]

interface ProviderDetailPanelProvider {
  id: string
  name: string
  icon?: string | React.ReactNode
  modelCount?: number
}

interface ProviderDetailPanelProps {
  provider: ProviderDetailPanelProvider | null
  onToggleEnabled?: (enabled: boolean) => void
  onDelete?: () => void
  /** This provider is the app-wide default for new chats. */
  isDefault?: boolean
  /**
   * Make this provider the app-wide default (`AppSettings.defaultProvider`).
   * Omit to hide the action (e.g. read-only contexts).
   */
  onSetDefault?: () => void
  /**
   * Why "Set default" is unavailable right now. When given (and `onSetDefault`
   * is not), the button still renders — disabled, with this as its tooltip —
   * so the user learns what to do instead of the action silently vanishing.
   */
  setDefaultBlockedReason?: string
  isEnabled?: boolean
  /** Whether an incomplete disabled provider may be enabled. */
  canEnable?: boolean
  /** Why the enable switch is disabled (readiness reason) — shown as a tooltip. */
  enableBlockedReason?: string
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
  setDefaultBlockedReason,
  isEnabled,
  canEnable = true,
  enableBlockedReason,
  isCustom,
  connectionStatus,
  configTab,
  modelsTab,
  costTab,
  diagnosticsTab,
  advancedTab,
}: ProviderDetailPanelProps) {
  const t = useTranslations("providers")
  const [activeTab, setActiveTab] = React.useState<string>("config")

  const slots: Record<Exclude<TabKey, "config">, React.ReactNode> = {
    models: modelsTab,
    cost: costTab,
    diagnostics: diagnosticsTab,
    advanced: advancedTab,
  }
  // A provider swap can take the active tab's slot away with it (local engines
  // ship Config only). Derive the effective tab instead of syncing state in an
  // effect, so the panel never lands on a tab that has no trigger to leave it.
  const visibleTabs = TAB_KEYS.filter((key) => key === "config" || slots[key] != null)
  const activeTabValue = visibleTabs.includes(activeTab as TabKey) ? activeTab : "config"
  const modelsTabActive = activeTabValue === "models"

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
        {/* Own TooltipProvider so the panel is self-sufficient in stories and
            tests; nesting inside the app-level provider is harmless. */}
        <TooltipProvider>
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
            ) : setDefaultBlockedReason ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button swallows pointer events, so the tooltip
                    anchors on a span that still receives hover/focus. */}
                  <span
                    tabIndex={0}
                    className="inline-flex"
                    data-testid="provider-set-default-blocked"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="pointer-events-none h-7 gap-1.5 text-xs"
                      disabled
                      aria-label={t("detailPanel.setDefaultAria")}
                    >
                      <Star className="h-3 w-3" />
                      {t("detailPanel.setDefault")}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64 text-xs">
                  {setDefaultBlockedReason}
                </TooltipContent>
              </Tooltip>
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
            {!isEnabled && !canEnable && enableBlockedReason ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex" data-testid="provider-enable-blocked">
                    <Switch
                      checked={false}
                      disabled
                      className="pointer-events-none"
                      aria-label={t("detailPanel.enableSwitchAria")}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64 text-xs">
                  {enableBlockedReason}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Switch
                checked={isEnabled}
                disabled={!isEnabled && !canEnable}
                onCheckedChange={onToggleEnabled}
                aria-label={t("detailPanel.enableSwitchAria")}
              />
            )}
          </div>
        </TooltipProvider>
      </div>

      {/* Tabs. Controlled, because the Models tab is scroll-owning: the shared
          `ScrollArea` below has to be taken out of the layout entirely while
          Models is active, or it would claim half the pane as an empty box. */}
      <Tabs
        value={activeTabValue}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {/* A tab appears only when its slot is filled. Local inference engines
            have no cloud models/cost/routing story, so they render just Config
            — and still keep the shared header (enable switch, default badge,
            status) instead of replacing the whole panel with a foreign shell. */}
        {/* Triggers divide the pane rather than overflowing it: `min-w-0` +
            `truncate` let a label give up width on a narrow pane instead of
            pushing the strip past the right edge, where it was clipped with no
            scroll affordance. `title` keeps the full label reachable. */}
        <TabsList className="flex w-full min-w-0 shrink-0 justify-start rounded-none border-b bg-transparent px-4">
          {visibleTabs.map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              title={t(`tabs.${key}`)}
              className="min-w-0 flex-1 px-1.5"
            >
              <span className="truncate">{t(`tabs.${key}`)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Themed `ScrollArea`, matching this feature's dialogs — a native
            scrollbar here made the pane and the dialogs look unrelated.

            `max-w-4xl`: the providers section opts out of the settings shell's
            `max-w-5xl` cap (it owns a fill-height master/detail frame), so on an
            ultrawide window these forms stretched edge to edge. The cap lives
            here, once, rather than in each of Config / Models / Cost / Advanced.
            Container queries still resolve against `@container/provider-pane`
            one level up, so the cost tab's `@3xl` grid is unaffected. */}
        {/* The Models tab owns its own scrolling: its toolbar (search, refresh,
            filters, batch actions) has to stay pinned while only the model list
            moves, which is impossible from inside a single pane-wide
            `ScrollArea`. So it renders as a fill-height flex child and every
            other tab keeps the shared scroller below. */}
        {modelsTab && (
          <TabsContent value="models" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden">
              {modelsTab}
            </div>
          </TabsContent>
        )}
        <ScrollArea className={cn("min-h-0 flex-1", modelsTabActive && "hidden")}>
          <div className="mx-auto w-full max-w-4xl">
            <TabsContent value="config" className="m-0 p-4">
              {configTab ?? <div>{t("detailPanel.configPlaceholder")}</div>}
            </TabsContent>
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
