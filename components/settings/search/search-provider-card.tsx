"use client"

import { useCallback } from "react"
import {
  Eye,
  EyeOff,
  ExternalLink,
  Check,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import {
  type SearchProviderType,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  validateApiKey,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@cognia/web-search/types"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.search.provider")

export interface ProviderTestState {
  testing: boolean
  result: "success" | "error" | null
}

interface SearchProviderCardProps {
  providerId: SearchProviderType
  isExpanded: boolean
  showKey: boolean
  testState: ProviderTestState
  onToggleExpand: () => void
  onToggleKey: () => void
  onTestConnection: () => void
}

export function SearchProviderCard({
  providerId,
  isExpanded,
  showKey,
  testState,
  onToggleExpand,
  onToggleKey,
  onTestConnection,
}: SearchProviderCardProps) {
  const t = useTranslations("searchSettings")
  const config = SEARCH_PROVIDERS[providerId]

  const settings =
    useSettingsStore((s) => s.settings?.searchProviders?.[providerId]) ??
    DEFAULT_SEARCH_PROVIDER_SETTINGS[providerId]
  const setSearchProviderSettings = useSettingsStore((s) => s.setSearchProviderSettings)
  const setSearchProviderApiKey = useSettingsStore((s) => s.setSearchProviderApiKey)
  const setSearchProviderEnabled = useSettingsStore((s) => s.setSearchProviderEnabled)
  const setSearchProviderPriority = useSettingsStore((s) => s.setSearchProviderPriority)

  const isValidKey = settings?.apiKey ? validateApiKey(providerId, settings.apiKey) : false
  const isActive = !!settings?.enabled && isProviderConfigured(providerId, settings)
  const canEnable =
    providerId === "google" ? !!settings?.apiKey && !!settings?.cx?.trim() : !!settings?.apiKey

  const adjustPriority = useCallback(
    (delta: number) => {
      const current = settings?.priority ?? 5
      const next = Math.max(1, Math.min(10, current + delta))
      void setSearchProviderPriority(providerId, next)
      log.info("provider_priority_changed", { providerId, priority: next })
    },
    [settings?.priority, providerId, setSearchProviderPriority]
  )

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
      <div
        className={cn(
          "border rounded-lg transition-colors",
          isActive && "border-primary/30 bg-primary/[0.02]",
          !settings?.enabled && !isExpanded && "opacity-70"
        )}
      >
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium">{config.name}</span>
                  {isActive && (
                    <Badge variant="default" className="text-[10px] px-1 py-0">
                      {t("active")}
                    </Badge>
                  )}
                  {config.features.aiAnswer && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      AI
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground line-clamp-1">
                  {config.description}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={settings?.enabled ?? false}
                onCheckedChange={(v) => {
                  log.info("provider_enabled_changed", { providerId, enabled: v })
                  void setSearchProviderEnabled(providerId, v)
                }}
                disabled={!settings?.enabled && !canEnable}
                onClick={(e) => e.stopPropagation()}
              />
              {isExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-3 border-t pt-3">
            {/* API Key */}
            <div className="space-y-1.5">
              <Label htmlFor={`${providerId}-key`} className="text-xs">
                {t("apiKey")}
              </Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id={`${providerId}-key`}
                    type={showKey ? "text" : "password"}
                    placeholder={config.apiKeyPlaceholder}
                    value={settings?.apiKey ?? ""}
                    onChange={(e) => void setSearchProviderApiKey(providerId, e.target.value)}
                    onBlur={(e) =>
                      log.info("provider_api_key_changed", {
                        providerId,
                        hasKey: Boolean(e.target.value),
                        valid: e.target.value ? validateApiKey(providerId, e.target.value) : false,
                      })
                    }
                    className="pr-10"
                    autoComplete="new-password"
                    data-form-type="other"
                    data-lpignore="true"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full"
                    onClick={onToggleKey}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  onClick={onTestConnection}
                  disabled={!settings?.apiKey || testState.testing}
                >
                  {testState.testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("testConnection")
                  )}
                </Button>
              </div>
              {testState.result === "success" && (
                <p className="flex items-center gap-1 text-xs text-green-600">
                  <Check className="h-3.5 w-3.5" /> {t("connectionSuccess")}
                </p>
              )}
              {testState.result === "error" && (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" /> {t("connectionFailed")}
                </p>
              )}
              {settings?.apiKey && !isValidKey && (
                <p className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertCircle className="h-3.5 w-3.5" /> {t("invalidKeyFormat")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("getApiKey")}{" "}
                <a
                  href={config.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {config.name} <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>

            {/* Google cx */}
            {providerId === "google" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${providerId}-cx`} className="text-xs">
                  {t("googleCx")}
                </Label>
                <Input
                  id={`${providerId}-cx`}
                  type="text"
                  placeholder={t("googleCxPlaceholder")}
                  value={settings?.cx ?? ""}
                  onChange={(e) =>
                    void setSearchProviderSettings(providerId, { cx: e.target.value })
                  }
                  onBlur={(e) =>
                    log.info("provider_cx_changed", {
                      providerId,
                      hasCx: Boolean(e.target.value.trim()),
                    })
                  }
                  autoComplete="off"
                  data-form-type="other"
                />
                <p className="text-[10px] text-muted-foreground">{t("googleCxHelp")}</p>
              </div>
            )}

            {/* Priority */}
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">
                {t("priority")}: P{settings?.priority ?? 5}
              </Label>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => adjustPriority(-1)}
                      disabled={!settings?.enabled}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t("higherPriority")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => adjustPriority(1)}
                      disabled={!settings?.enabled}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t("lowerPriority")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Features + Pricing */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex flex-wrap gap-1">
                {config.features.aiAnswer && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.aiAnswer")}
                  </Badge>
                )}
                {config.features.newsSearch && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.news")}
                  </Badge>
                )}
                {config.features.imageSearch && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.images")}
                  </Badge>
                )}
                {config.features.academicSearch && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.academic")}
                  </Badge>
                )}
                {config.features.recencyFilter && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.recencyFilter")}
                  </Badge>
                )}
                {config.features.domainFilter && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.domainFilter")}
                  </Badge>
                )}
                {config.features.contentExtraction && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("features.contentExtraction")}
                  </Badge>
                )}
              </div>
              {config.pricing && (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {config.pricing.freeCredits && (
                    <>{t("pricingFreeCredits", { credits: config.pricing.freeCredits })} </>
                  )}
                  {config.pricing.pricePerSearch && (
                    <>{t("pricingPerSearch", { price: config.pricing.pricePerSearch })}</>
                  )}
                </span>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
