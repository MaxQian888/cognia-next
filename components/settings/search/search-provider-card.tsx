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
import { BrandIcon } from "@/components/icons/brand-icon"
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
  getProviderState,
  getProviderConfigIssues,
  validateSearchEndpoint,
} from "@cognia/web-search/types"
import {
  getEffectiveSearchCapabilities,
  resolveEngine,
} from "@cognia/web-search/search-type-router"
import {
  GOOGLE_AI_GROUNDING_MODELS,
  GOOGLE_AI_DEFAULT_MODEL,
} from "@cognia/web-search/providers/google-ai"
import { SEARXNG_ENGINE_PATTERN } from "@cognia/web-search/providers/searxng"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { createLogger } from "@cognia/logging"
import type { ProviderKeyTestResult } from "@cognia/web-search/provider-test"
import { ApiKeyPoolInput } from "./_shared/api-key-pool-input"
import { ProviderDefaultsEditor } from "./_shared/provider-defaults-editor"

const log = createLogger("settings.search.provider")

export interface ProviderTestState {
  testing: boolean
  result: "success" | "error" | null
  /** Per-key results when the whole rotation pool was tested (index 0 = primary). */
  keyResults?: ProviderKeyTestResult[]
  testedAt?: string
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
  const state = getProviderState(providerId, settings)
  const retired = state === "retired"
  const issues = getProviderConfigIssues(providerId, settings)
  const capabilities = getEffectiveSearchCapabilities(providerId)
  const endpoint = validateSearchEndpoint(settings?.baseUrl)
  const engine = resolveEngine(providerId, settings, {})
  const invalidEngine = providerId === "searxng" && !!engine && !SEARXNG_ENGINE_PATTERN.test(engine)
  const invalidModel =
    providerId === "google-ai" &&
    !!settings?.model &&
    !GOOGLE_AI_GROUNDING_MODELS.some((model) => model === settings.model)
  const canEnable =
    !retired && isProviderConfigured(providerId, settings) && !invalidEngine && !invalidModel

  const adjustPriority = useCallback(
    (delta: number) => {
      const current = settings?.priority ?? 5
      const next = Math.max(1, Math.min(Object.keys(SEARCH_PROVIDERS).length, current + delta))
      void setSearchProviderPriority(providerId, next)
      log.info("provider_priority_changed", { providerId, priority: next })
    },
    [settings?.priority, providerId, setSearchProviderPriority]
  )

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
      <div
        id={`search-provider-${providerId}`}
        data-setting-id={`search-provider-${providerId}`}
        className={cn(
          "border rounded-lg transition-colors",
          isActive && "border-primary/30 bg-primary/[0.02]",
          ((!settings?.enabled && !isExpanded) || retired) && "opacity-70"
        )}
      >
        <div className="flex items-center gap-2 p-3">
          <CollapsibleTrigger asChild disabled={retired}>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-between gap-2 whitespace-normal p-0 text-left"
              aria-label={t("configureProvider", { provider: config.name })}
              disabled={retired}
            >
              <div className="flex items-center gap-2 min-w-0">
                <BrandIcon id={providerId} label={config.name} size={28} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium">{config.name}</span>
                    <Badge
                      variant={state === "configured" ? "default" : "outline"}
                      className="text-[10px] px-1 py-0"
                    >
                      {t(`states.${state}`)}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground line-clamp-1">
                    {t(`providerDescriptions.${providerId}`)}
                  </p>
                  {config.lifecycle.status === "legacy" && (
                    <p className="text-xs text-amber-600">
                      {t("legacyNotice", { date: config.lifecycle.endDate })}
                    </p>
                  )}
                  {retired && config.lifecycle.status === "retired" && (
                    <p className="text-xs text-muted-foreground">
                      {t("retiredNotice", { date: config.lifecycle.retiredOn })}
                    </p>
                  )}
                </div>
              </div>
              {isExpanded ? (
                <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>
          <Switch
            checked={!retired && (settings?.enabled ?? false)}
            aria-label={t("enableProvider", { provider: config.name })}
            onCheckedChange={(v) => {
              log.info("provider_enabled_changed", { providerId, enabled: v })
              void setSearchProviderEnabled(providerId, v)
            }}
            disabled={retired || (!settings?.enabled && !canEnable)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-3 border-t pt-3">
            {!retired && (
              <>
                {config.auth === "endpoint" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${providerId}-endpoint`}>{t("endpoint")}</Label>
                    <Input
                      id={`${providerId}-endpoint`}
                      value={settings?.baseUrl ?? ""}
                      placeholder={t("endpointPlaceholder")}
                      aria-invalid={!endpoint.ok}
                      aria-describedby={`${providerId}-endpoint-help`}
                      onChange={(e) =>
                        void setSearchProviderSettings(providerId, { baseUrl: e.target.value })
                      }
                    />
                    <p id={`${providerId}-endpoint-help`} className="text-xs text-muted-foreground">
                      {t("endpointHelp")}
                    </p>
                    {!endpoint.ok && (
                      <p role="status" className="text-xs text-destructive">
                        {t(`endpointIssues.${endpoint.issue}`)}
                      </p>
                    )}
                    {endpoint.isPrivate && (
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`${providerId}-private`}>{t("allowPrivateEndpoint")}</Label>
                        <Switch
                          id={`${providerId}-private`}
                          checked={settings?.allowPrivateEndpoint === true}
                          onCheckedChange={(allowPrivateEndpoint) =>
                            void setSearchProviderSettings(providerId, { allowPrivateEndpoint })
                          }
                        />
                      </div>
                    )}
                    {issues.includes("endpoint-not-granted") && (
                      <p role="status" className="text-xs text-destructive">
                        {t("endpointGrantRequired")}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {/* API Key */}
                    <div className="space-y-1.5">
                      <Label htmlFor={`${providerId}-key`} className="text-xs">
                        {t("apiKey")}
                      </Label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Input
                            id={`${providerId}-key`}
                            // secret-reveal-gate: components/settings/search/search-provider-grid.tsx
                            // This card is presentational — `onToggleKey` is owned by the
                            // grid, which routes the reveal through `useSecretReveal`.
                            type={showKey ? "text" : "password"}
                            placeholder={config.apiKeyPlaceholder}
                            value={settings?.apiKey ?? ""}
                            onChange={(e) =>
                              void setSearchProviderApiKey(providerId, e.target.value)
                            }
                            onBlur={(e) =>
                              log.info("provider_api_key_changed", {
                                providerId,
                                hasKey: Boolean(e.target.value),
                                valid: e.target.value
                                  ? validateApiKey(providerId, e.target.value)
                                  : false,
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
                            aria-label={t(showKey ? "hideKeys" : "showKeys")}
                          >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                      {testState.keyResults && testState.keyResults.length > 1 && (
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-muted-foreground">{t("keyPoolResults")}</p>
                          {testState.keyResults.map((row) => (
                            <p
                              key={row.index}
                              className={cn(
                                "flex items-center gap-1 text-xs",
                                row.ok ? "text-green-600" : "text-destructive"
                              )}
                            >
                              {row.ok ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <AlertCircle className="h-3 w-3" />
                              )}
                              {row.index === 0 ? t("keyPrimary") : t("keyBackup", { n: row.index })}
                              <span className="text-muted-foreground">…{row.keyHint}</span>
                            </p>
                          ))}
                        </div>
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

                    {/* Multi-key rotation pool — only meaningful once a primary key exists */}
                    {settings?.apiKey ? (
                      <ApiKeyPoolInput
                        keys={settings.apiKeys ?? []}
                        onChange={(apiKeys) => {
                          log.info("provider_backup_keys_changed", {
                            providerId,
                            count: apiKeys.length,
                          })
                          void setSearchProviderSettings(providerId, { apiKeys })
                        }}
                        rotationEnabled={settings.apiKeyRotationEnabled ?? false}
                        onRotationEnabledChange={(apiKeyRotationEnabled) => {
                          log.info("provider_rotation_toggled", {
                            providerId,
                            enabled: apiKeyRotationEnabled,
                          })
                          void setSearchProviderSettings(providerId, { apiKeyRotationEnabled })
                        }}
                        strategy={settings.apiKeyRotationStrategy ?? "round-robin"}
                        onStrategyChange={(apiKeyRotationStrategy) => {
                          log.info("provider_rotation_strategy_changed", {
                            providerId,
                            apiKeyRotationStrategy,
                          })
                          void setSearchProviderSettings(providerId, { apiKeyRotationStrategy })
                        }}
                        placeholder={config.apiKeyPlaceholder}
                        idPrefix={`${providerId}-backup-key`}
                      />
                    ) : null}
                  </>
                )}

                <Button
                  variant="outline"
                  onClick={onTestConnection}
                  disabled={!canEnable || testState.testing}
                >
                  {testState.testing && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  {t("testConnection")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("testCost")}</p>
                {testState.result && (
                  <div
                    role="status"
                    aria-live="polite"
                    className={cn(
                      "text-xs",
                      testState.result === "error" ? "text-destructive" : "text-green-600"
                    )}
                  >
                    <p>
                      {t(testState.result === "success" ? "connectionSuccess" : "connectionFailed")}
                    </p>
                    {testState.testedAt && (
                      <p>
                        {t("testedAt", { date: new Date(testState.testedAt).toLocaleString() })}
                      </p>
                    )}
                    <p className="text-muted-foreground">{t("testEvidence")}</p>
                  </div>
                )}

                {capabilities && capabilities.engines.length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${providerId}-engine`}>{t("engine")}</Label>
                    <Select
                      value={engine}
                      onValueChange={(engine) =>
                        void setSearchProviderSettings(providerId, { engine })
                      }
                    >
                      <SelectTrigger id={`${providerId}-engine`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {capabilities.engines.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {issues.includes("unsupported-engine") && (
                      <p role="status" className="text-xs text-destructive">
                        {t("invalidEngine")}
                      </p>
                    )}
                  </div>
                )}
                {capabilities?.freeFormEngines && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${providerId}-engine`}>{t("engine")}</Label>
                    <Input
                      id={`${providerId}-engine`}
                      value={settings?.engine ?? ""}
                      placeholder={t("enginePlaceholder")}
                      aria-invalid={invalidEngine}
                      onChange={(e) =>
                        void setSearchProviderSettings(providerId, { engine: e.target.value })
                      }
                    />
                    {invalidEngine && (
                      <p role="status" className="text-xs text-destructive">
                        {t("invalidEngine")}
                      </p>
                    )}
                  </div>
                )}
                {providerId === "google-ai" && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${providerId}-model`}>{t("groundingModel")}</Label>
                    <Select
                      value={settings?.model || GOOGLE_AI_DEFAULT_MODEL}
                      onValueChange={(model) =>
                        void setSearchProviderSettings(providerId, { model })
                      }
                    >
                      <SelectTrigger id={`${providerId}-model`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GOOGLE_AI_GROUNDING_MODELS.map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("groundingBilling")}</p>
                    {invalidModel && (
                      <p role="status" className="text-xs text-destructive">
                        {t("invalidModel")}
                      </p>
                    )}
                  </div>
                )}

                {/* Google cx */}
                {config.auth === "api-key+cx" && (
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
                          aria-label={t("higherPriority")}
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
                          aria-label={t("lowerPriority")}
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

                {/* Per-provider defaultOptions — override the global Behavior defaults */}
                <ProviderDefaultsEditor
                  providerId={providerId}
                  value={settings?.defaultOptions}
                  onChange={(defaultOptions) => {
                    log.info("provider_overrides_changed", {
                      providerId,
                      keys: Object.keys(defaultOptions ?? {}),
                    })
                    void setSearchProviderSettings(providerId, { defaultOptions })
                  }}
                />

                {/* Features + Pricing */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex flex-wrap gap-1">
                    {capabilities?.types.map((type) => (
                      <Badge key={type} variant="secondary" className="text-[10px]">
                        {t(`searchTypes.${type}`)}
                      </Badge>
                    ))}
                    {capabilities?.safeSearch.map((level) => (
                      <Badge key={level} variant="outline" className="text-[10px]">
                        {t(`safeSearchLevels.${level}`)}
                      </Badge>
                    ))}
                    {capabilities?.answer && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("features.aiAnswer")}
                      </Badge>
                    )}
                    {capabilities?.rawContent && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("features.contentExtraction")}
                      </Badge>
                    )}
                    {capabilities?.controls.recency && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("features.recencyFilter")}
                      </Badge>
                    )}
                    {capabilities?.controls.domains && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("features.domainFilter")}
                      </Badge>
                    )}
                    {capabilities?.controls.country && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("features.countryFilter")}
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
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
