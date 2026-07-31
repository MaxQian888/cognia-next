"use client"

/**
 * OpenRouter Settings Component
 * Provides UI for BYOK, API key management, credits display, and provider ordering
 * https://openrouter.ai/docs
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { nanoid } from "nanoid"
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Loader2,
  DollarSign,
  Settings2,
  Shield,
  List,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useSettingsStore } from "@/stores"
import type {
  BYOKKeyEntry,
  BYOKProvider,
  OpenRouterProviderSettings,
  ProviderModelDiscoveryEntry,
} from "@cognia/provider-types"
import {
  getCredits,
  formatCredits,
  maskApiKey,
  OpenRouterError,
} from "@cognia/provider-core/providers/openrouter"
import {
  BYOK_PROVIDERS,
  getConfigPlaceholder,
  getConfigHelp,
} from "@cognia/provider-core/providers/openrouter-config"
import { useOpenRouterCatalog } from "@/hooks/settings/use-openrouter-catalog"

interface OpenRouterSettingsProps {
  className?: string
}

export function OpenRouterSettings({ className }: OpenRouterSettingsProps) {
  const t = useTranslations("providers")
  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const updateProviderSettings = useSettingsStore((state) => state.updateProviderSettings)

  const settings = providerSettings.openrouter
  const apiKey = settings?.apiKey
  // The OpenRouter model list now lives in the shared, auto-synced catalog
  // (Dexie v93) rather than per-provider `discoveredModels`, so the GUI and the
  // CLI render the same real-time `/models` list. See `use-openrouter-catalog`.
  const {
    row: catalogRow,
    isSyncing: isModelsLoading,
    error: catalogError,
    sync: syncCatalog,
  } = useOpenRouterCatalog()
  const openRouterSettings = useMemo(
    () => settings?.openRouterSettings || {},
    [settings?.openRouterSettings]
  )
  const creditsLastFetched = openRouterSettings.creditsLastFetched

  const [isCreditsLoading, setIsCreditsLoading] = useState(false)
  const [creditsError, setCreditsError] = useState<string | null>(null)
  const [isByokOpen, setIsByokOpen] = useState(false)
  const [isProviderOrderOpen, setIsProviderOrderOpen] = useState(false)
  const [isModelsOpen, setIsModelsOpen] = useState(false)
  const [newByokProvider, setNewByokProvider] = useState<BYOKProvider | "">("")
  const [newByokConfig, setNewByokConfig] = useState("")
  const [newByokName, setNewByokName] = useState("")

  const availableModels = useMemo<ProviderModelDiscoveryEntry[]>(
    () => catalogRow?.models || [],
    [catalogRow?.models]
  )
  const modelsError = catalogError

  const updateOpenRouterSettings = useCallback(
    (updates: Partial<OpenRouterProviderSettings>) => {
      updateProviderSettings("openrouter", {
        openRouterSettings: {
          ...openRouterSettings,
          ...updates,
        },
      })
    },
    [openRouterSettings, updateProviderSettings]
  )

  const fetchCredits = useCallback(async () => {
    if (!apiKey) return

    setIsCreditsLoading(true)
    setCreditsError(null)

    try {
      const creditsData = await getCredits(apiKey)
      updateOpenRouterSettings({
        credits: creditsData.credits,
        creditsUsed: creditsData.credits_used,
        creditsRemaining: creditsData.credits_remaining,
        creditsLastFetched: Date.now(),
      })
    } catch (error) {
      if (error instanceof OpenRouterError) {
        setCreditsError(error.message)
      } else {
        setCreditsError("Failed to fetch credits")
      }
    } finally {
      setIsCreditsLoading(false)
    }
  }, [apiKey, updateOpenRouterSettings])

  // Fetch credits on mount if API key exists
  useEffect(() => {
    if (!apiKey || creditsLastFetched) return
    const timer = setTimeout(() => {
      fetchCredits()
    }, 0)
    return () => clearTimeout(timer)
  }, [apiKey, creditsLastFetched, fetchCredits])

  // Refresh the shared catalog from the live `/models` endpoint. The configured
  // key is passed through so an account's extra models surface, but the endpoint
  // works keyless too (full public catalog). State persists to Dexie, so the CLI
  // picker reflects the same list.
  const fetchAvailableModels = useCallback(async () => {
    await syncCatalog(apiKey)
  }, [syncCatalog, apiKey])

  const addByokKey = useCallback(() => {
    if (!newByokProvider || !newByokConfig) return

    const newKey: BYOKKeyEntry = {
      id: nanoid(),
      provider: newByokProvider,
      config: newByokConfig,
      alwaysUse: false,
      enabled: true,
      name: newByokName || undefined,
    }

    const existingKeys = openRouterSettings.byokKeys || []
    updateOpenRouterSettings({
      byokKeys: [...existingKeys, newKey],
    })

    setNewByokProvider("")
    setNewByokConfig("")
    setNewByokName("")
  }, [
    newByokProvider,
    newByokConfig,
    newByokName,
    openRouterSettings.byokKeys,
    updateOpenRouterSettings,
  ])

  const removeByokKey = useCallback(
    (id: string) => {
      const existingKeys = openRouterSettings.byokKeys || []
      updateOpenRouterSettings({
        byokKeys: existingKeys.filter((k) => k.id !== id),
      })
    },
    [openRouterSettings.byokKeys, updateOpenRouterSettings]
  )

  const updateByokKey = useCallback(
    (id: string, updates: Partial<BYOKKeyEntry>) => {
      const existingKeys = openRouterSettings.byokKeys || []
      updateOpenRouterSettings({
        byokKeys: existingKeys.map((k) => (k.id === id ? { ...k, ...updates } : k)),
      })
    },
    [openRouterSettings.byokKeys, updateOpenRouterSettings]
  )

  const selectedProviderConfig = BYOK_PROVIDERS.find((p) => p.id === newByokProvider)

  if (!settings?.enabled) {
    return null
  }

  return (
    <div className={className}>
      {/* Credits Display */}
      {settings.apiKey && (
        <Card className="mb-2.5 gap-0 py-0">
          <CardHeader className="space-y-0 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-green-500" />
                <CardTitle className="text-sm">{t("openrouterSettings.credits")}</CardTitle>
              </div>
              <Button variant="ghost" size="sm" onClick={fetchCredits} disabled={isCreditsLoading}>
                {isCreditsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0 pb-2.5">
            {creditsError ? (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {creditsError}
              </div>
            ) : openRouterSettings.credits !== undefined ? (
              <div className="grid grid-cols-3 gap-2.5 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">{t("openrouterSettings.total")}</p>
                  <p className="font-medium">{formatCredits(openRouterSettings.credits || 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t("openrouterSettings.used")}</p>
                  <p className="font-medium">
                    {formatCredits(openRouterSettings.creditsUsed || 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("openrouterSettings.remaining")}
                  </p>
                  <p className="font-medium text-green-600">
                    {formatCredits(openRouterSettings.creditsRemaining || 0)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("clickRefreshToLoad")}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Available Models Section */}
      <Collapsible open={isModelsOpen} onOpenChange={setIsModelsOpen}>
        <Card className="mb-2.5 gap-0 py-0">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer space-y-0.5 hover:bg-muted/50 transition-colors py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <List className="h-4 w-4" />
                  <CardTitle className="text-sm">
                    {t("availableModels") || "Available Models"}
                  </CardTitle>
                  {availableModels.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {availableModels.length}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      fetchAvailableModels()
                    }}
                    disabled={isModelsLoading}
                  >
                    {isModelsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                  {isModelsOpen ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </div>
              <CardDescription className="text-[11px] leading-tight">
                {t("modelsAvailableThrough")}
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 pb-2.5">
              {modelsError ? (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {modelsError}
                </div>
              ) : availableModels.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {availableModels.slice(0, 50).map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <span className="font-mono text-xs block truncate">
                            {model.name || model.id}
                          </span>
                          {model.contextLength && (
                            <span className="text-[10px] text-muted-foreground">
                              {Math.round(model.contextLength / 1000)}K context
                            </span>
                          )}
                        </div>
                      </div>
                      {model.pricing && (
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          ${(model.pricing.promptPer1M ?? 0).toFixed(2)}/1M
                        </Badge>
                      )}
                    </div>
                  ))}
                  {availableModels.length > 50 && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      +{availableModels.length - 50} more models
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t("clickRefreshToLoad") || "Click refresh to load models"}
                </p>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* BYOK Section */}
      <Collapsible open={isByokOpen} onOpenChange={setIsByokOpen}>
        <Card className="gap-0 py-0">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer space-y-0.5 hover:bg-muted/50 transition-colors py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key className="h-4 w-4" />
                  <CardTitle className="text-sm">{t("openrouterSettings.byok")}</CardTitle>
                  {(openRouterSettings.byokKeys?.length || 0) > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {openRouterSettings.byokKeys?.length}
                    </Badge>
                  )}
                </div>
                {isByokOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </div>
              <CardDescription className="text-[11px] leading-tight">
                {t("openrouterSettings.byokDescription")}
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 pb-2.5">
              <div className="space-y-2.5">
                {/* Existing BYOK Keys */}
                {openRouterSettings.byokKeys?.map((key) => {
                  const providerInfo = BYOK_PROVIDERS.find((p) => p.id === key.provider)
                  return (
                    <div
                      key={key.id}
                      className="flex items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 py-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            {key.name || providerInfo?.name || key.provider}
                          </span>
                          {key.enabled && (
                            <Badge variant="outline" className="text-xs">
                              {t("active")}
                            </Badge>
                          )}
                          {key.alwaysUse && (
                            <Badge variant="secondary" className="text-xs">
                              {t("openrouterSettings.alwaysUse")}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {key.config.length > 20 ? maskApiKey(key.config) : key.config}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Switch
                                checked={key.alwaysUse}
                                onCheckedChange={(checked) =>
                                  updateByokKey(key.id, { alwaysUse: checked })
                                }
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{t("openrouterSettings.alwaysUseHint")}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <Switch
                          checked={key.enabled}
                          onCheckedChange={(checked) => updateByokKey(key.id, { enabled: checked })}
                        />
                        <Button variant="ghost" size="icon" onClick={() => removeByokKey(key.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  )
                })}

                <Separator />

                {/* Add New BYOK Key */}
                <div className="space-y-2.5">
                  <Label className="text-sm font-medium">
                    {t("openrouterSettings.addProviderKey")}
                  </Label>
                  <Select
                    value={newByokProvider}
                    onValueChange={(value) => setNewByokProvider(value as BYOKProvider)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {BYOK_PROVIDERS.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          <div className="flex flex-col">
                            <span>{provider.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {provider.description}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {newByokProvider && (
                    <>
                      <Input
                        placeholder="Key name (optional)"
                        value={newByokName}
                        onChange={(e) => setNewByokName(e.target.value)}
                      />

                      {selectedProviderConfig?.configType === "simple" ? (
                        <Input
                          type="password"
                          placeholder="API Key"
                          value={newByokConfig}
                          onChange={(e) => setNewByokConfig(e.target.value)}
                          autoComplete="new-password"
                          data-lpignore="true"
                          data-form-type="other"
                        />
                      ) : (
                        <div className="space-y-2">
                          <Textarea
                            placeholder={getConfigPlaceholder(selectedProviderConfig?.configType)}
                            value={newByokConfig}
                            onChange={(e) => setNewByokConfig(e.target.value)}
                            rows={5}
                            className="font-mono text-xs"
                          />
                          <p className="text-xs text-muted-foreground">
                            {getConfigHelp(selectedProviderConfig?.configType)}
                          </p>
                        </div>
                      )}

                      <Button onClick={addByokKey} disabled={!newByokConfig} className="w-full">
                        <Plus className="h-4 w-4 mr-2" />
                        {t("openrouterSettings.addKey")}
                      </Button>
                    </>
                  )}
                </div>

                <div className="text-xs text-muted-foreground">
                  <a
                    href="https://openrouter.ai/docs/guides/overview/auth/byok"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    {t("openrouterSettings.learnMoreByok")} <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Provider Ordering Section */}
      <Collapsible
        open={isProviderOrderOpen}
        onOpenChange={setIsProviderOrderOpen}
        className="mt-2.5"
      >
        <Card className="gap-0 py-0">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer space-y-0.5 hover:bg-muted/50 transition-colors py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4" />
                  <CardTitle className="text-sm">
                    {t("openrouterSettings.providerOrdering")}
                  </CardTitle>
                </div>
                {isProviderOrderOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </div>
              <CardDescription className="text-[11px] leading-tight">
                {t("openrouterSettings.providerOrderingDescription")}
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 pb-2.5">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="provider-ordering-enabled" className="text-sm">
                    {t("openrouterSettings.enableProviderOrdering")}
                  </Label>
                  <Switch
                    id="provider-ordering-enabled"
                    checked={openRouterSettings.providerOrdering?.enabled || false}
                    onCheckedChange={(checked) =>
                      updateOpenRouterSettings({
                        providerOrdering: {
                          ...openRouterSettings.providerOrdering,
                          enabled: checked,
                          allowFallbacks:
                            openRouterSettings.providerOrdering?.allowFallbacks ?? true,
                          order: openRouterSettings.providerOrdering?.order || [],
                        },
                      })
                    }
                  />
                </div>

                {openRouterSettings.providerOrdering?.enabled && (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label htmlFor="allow-fallbacks" className="text-sm">
                          {t("openrouterSettings.allowFallbacks")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t("openrouterSettings.allowFallbacksDesc")}
                        </p>
                      </div>
                      <Switch
                        id="allow-fallbacks"
                        checked={openRouterSettings.providerOrdering?.allowFallbacks ?? true}
                        onCheckedChange={(checked) =>
                          updateOpenRouterSettings({
                            providerOrdering: {
                              ...openRouterSettings.providerOrdering!,
                              allowFallbacks: checked,
                            },
                          })
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-sm">{t("openrouterSettings.providerOrder")}</Label>
                      <Textarea
                        placeholder="e.g., Amazon Bedrock, Google Vertex AI, Anthropic"
                        value={openRouterSettings.providerOrdering?.order?.join(", ") || ""}
                        onChange={(e) => {
                          const order = e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                          updateOpenRouterSettings({
                            providerOrdering: {
                              ...openRouterSettings.providerOrdering!,
                              order,
                            },
                          })
                        }}
                        rows={2}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("openrouterSettings.providerOrderHint")}
                      </p>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Site Attribution */}
      <Card className="mt-2.5 gap-0 py-0">
        <CardHeader className="space-y-0.5 py-2">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            <CardTitle className="text-sm">{t("openrouterSettings.appAttribution")}</CardTitle>
          </div>
          <CardDescription className="text-[11px] leading-tight">
            {t("openrouterSettings.appAttributionDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 pb-2.5">
          <div className="grid gap-2.5 md:grid-cols-2">
            <div>
              <Label htmlFor="site-url" className="text-xs">
                {t("openrouterSettings.siteUrl")}
              </Label>
              <Input
                id="site-url"
                placeholder="https://your-app.com"
                value={openRouterSettings.siteUrl || ""}
                onChange={(e) => updateOpenRouterSettings({ siteUrl: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="site-name" className="text-xs">
                {t("openrouterSettings.siteName")}
              </Label>
              <Input
                id="site-name"
                placeholder="Your App Name"
                value={openRouterSettings.siteName || ""}
                onChange={(e) => updateOpenRouterSettings({ siteName: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
