"use client"

/**
 * QuickAddProviderDialog - Quick add mainstream OpenAI-compatible providers
 * Provides preset configurations for popular third-party API providers
 */

import { useMemo, useState } from "react"
import { ExternalLink, Eye, EyeOff, Zap, Search } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSettingsStore } from "@/stores/settings"
import type { CustomModelMetadata } from "@/stores/settings/settings-store"
import { useConnectionTest } from "@/hooks/settings/use-connection-test"
import { cn } from "@/lib/utils"
import {
  buildQuickAddProviderPresets,
  type BuiltInProviderQuickAddPreset as QuickAddPreset,
} from "@cognia/provider-types/built-in-provider-catalog"
import { getCustomProviderReadiness } from "./provider-readiness"
import { ConnectionStatusCard, toConnectionCardResult } from "./provider-config-tab"

export type { BuiltInProviderQuickAddPreset as QuickAddPreset } from "@cognia/provider-types/built-in-provider-catalog"
export const QUICK_ADD_PRESETS: QuickAddPreset[] = buildQuickAddProviderPresets()

type CategoryFilter = "all" | "china" | "global" | "proxy"

interface QuickAddProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Escape hatch to the full `CustomProviderDialog` (create mode) for an
   * arbitrary/unlisted OpenAI-compatible endpoint — the presets below only
   * cover curated third-party providers.
   */
  onAddCustom?: () => void
  /**
   * Fired after a preset was saved as a custom provider, with the new row's id
   * and display name — so the host can select/reveal it and confirm.
   */
  onAdded?: (providerId: string, name: string) => void
}

function buildQuickAddModelMetadata(preset: QuickAddPreset): Record<string, CustomModelMetadata> {
  return Object.fromEntries(
    preset.modelEntries.map((model) => [
      model.id,
      {
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        maxOutputTokens: model.maxOutputTokens,
        pricing: model.pricing,
        capabilities: {
          vision: model.supportsVision,
          functionCalling: model.supportsTools,
          streaming: model.supportsStreaming,
        },
      },
    ])
  )
}

function buildQuickAddProviderDraft(preset: QuickAddPreset, apiKey: string) {
  return {
    providerId: "",
    customName: preset.name,
    baseURL: preset.baseURL,
    apiKey,
    apiProtocol: preset.apiProtocol,
    customModels: preset.models,
    customModelMetadata: buildQuickAddModelMetadata(preset),
    defaultModel: preset.defaultModel,
    enabled: true,
  }
}

export function QuickAddProviderDialog({
  open,
  onOpenChange,
  onAddCustom,
  onAdded,
}: QuickAddProviderDialogProps) {
  const t = useTranslations("providers")
  const tc = useTranslations("common")

  const addCustomProvider = useSettingsStore((state) => state.addCustomProvider)

  const [selectedPreset, setSelectedPreset] = useState<QuickAddPreset | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const {
    testing,
    result: testResult,
    test: runConnectionTest,
    reset: resetTestResult,
  } = useConnectionTest()
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all")
  const [searchQuery, setSearchQuery] = useState("")

  const filteredPresets = useMemo(() => {
    return QUICK_ADD_PRESETS.filter((preset) => {
      if (categoryFilter !== "all" && preset.category !== categoryFilter) return false
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        return (
          preset.name.toLowerCase().includes(query) ||
          preset.description.toLowerCase().includes(query)
        )
      }
      return true
    })
  }, [categoryFilter, searchQuery])

  const providerDraft = useMemo(
    () => (selectedPreset ? buildQuickAddProviderDraft(selectedPreset, apiKey.trim()) : null),
    [apiKey, selectedPreset]
  )
  const providerReadiness = useMemo(
    () => (providerDraft ? getCustomProviderReadiness(providerDraft) : null),
    [providerDraft]
  )

  const handleSelectPreset = (preset: QuickAddPreset) => {
    setSelectedPreset(preset)
    setApiKey("")
    setSaveError(null)
    resetTestResult()
  }

  const handleTestConnection = async () => {
    if (!selectedPreset || !apiKey) return
    await runConnectionTest(
      selectedPreset.baseURL,
      apiKey,
      selectedPreset.apiProtocol,
      selectedPreset.defaultModel
    )
  }

  const handleSave = async () => {
    if (!providerDraft || !providerReadiness?.eligibility.enable.allowed || isSaving) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const providerId = await addCustomProvider(providerDraft)
      const addedName = providerDraft.customName
      setSelectedPreset(null)
      setApiKey("")
      resetTestResult()
      onOpenChange(false)
      onAdded?.(providerId, addedName)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleBack = () => {
    setSelectedPreset(null)
    setApiKey("")
    setSaveError(null)
    resetTestResult()
  }

  const canSave = Boolean(
    providerDraft && providerReadiness?.eligibility.enable.allowed && providerDraft.defaultModel
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving || nextOpen) onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-[600px] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            {selectedPreset ? selectedPreset.name : t("quickAddProvider")}
          </DialogTitle>
          <DialogDescription>
            {selectedPreset ? t("enterApiKeyForProvider") : t("quickAddDescription")}
          </DialogDescription>
        </DialogHeader>

        {!selectedPreset ? (
          // Provider Selection View
          <div className="space-y-4">
            {/* Search and Filter */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("searchProviders")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Tabs
                value={categoryFilter}
                onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}
              >
                <TabsList className="h-9">
                  <TabsTrigger value="all" className="text-xs px-3">
                    {tc("all")}
                  </TabsTrigger>
                  <TabsTrigger value="china" className="text-xs px-3">
                    {t("chinaProviders")}
                  </TabsTrigger>
                  <TabsTrigger value="global" className="text-xs px-3">
                    {t("globalProviders")}
                  </TabsTrigger>
                  <TabsTrigger value="proxy" className="text-xs px-3">
                    {t("proxyServices")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Provider List */}
            <ScrollArea className="h-[380px] pr-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {filteredPresets.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    onClick={() => handleSelectPreset(preset)}
                    className={cn(
                      "h-auto flex-col items-start justify-start whitespace-normal rounded-lg p-3 text-left font-normal",
                      "hover:bg-accent hover:border-primary/50",
                      "focus:outline-none focus:ring-2 focus:ring-primary"
                    )}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <ProviderIcon providerId={preset.id} size={24} />
                      <span className="font-medium text-sm truncate flex-1">{preset.name}</span>
                      {preset.popular && (
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {t("popular")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                      {preset.description}
                    </p>
                    <div className="flex items-center gap-1 mt-2">
                      <Badge variant="outline" className="text-[10px]">
                        {preset.models.length} {t("modelsCount")}
                      </Badge>
                    </div>
                  </Button>
                ))}
                {filteredPresets.length === 0 && (
                  <div className="col-span-2 py-8 text-center text-sm text-muted-foreground">
                    {t("noProvidersFound")}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        ) : (
          // API Key Input View
          <div className="space-y-4 py-2">
            <div className="rounded-lg border p-3 bg-muted/30">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <ProviderIcon providerId={selectedPreset.id} size={24} />
                    <p className="font-medium">{selectedPreset.name}</p>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {selectedPreset.description}
                  </p>
                </div>
                {selectedPreset.dashboardUrl && (
                  <Button variant="ghost" size="sm" className="shrink-0" asChild>
                    <a href={selectedPreset.dashboardUrl} target="_blank" rel="noopener noreferrer">
                      {t("getApiKey")}
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {selectedPreset.modelEntries.map((model) => (
                  <Badge
                    key={model.id}
                    variant={model.id === selectedPreset.defaultModel ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {model.name}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="quick-api-key">{t("apiKey")}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="quick-api-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value)
                      setSaveError(null)
                      resetTestResult()
                    }}
                    placeholder={t("apiKeyPlaceholder")}
                    className="pr-10"
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-form-type="other"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full"
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={!providerReadiness?.eligibility.testConnection.allowed || testing}
                >
                  {testing ? tc("loading") : t("test")}
                </Button>
              </div>
              {testResult && <ConnectionStatusCard result={toConnectionCardResult(testResult)} />}
            </div>

            <p className="text-xs text-muted-foreground">
              {t("baseURL")}:{" "}
              <code className="bg-muted px-1 rounded">{selectedPreset.baseURL}</code>
            </p>
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {t("quickAddSaveFailed", { error: saveError })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {selectedPreset ? (
            <>
              <Button variant="outline" onClick={handleBack} disabled={isSaving}>
                {tc("back")}
              </Button>
              <Button onClick={() => void handleSave()} disabled={!canSave || isSaving}>
                {isSaving ? tc("saving") : tc("save")}
              </Button>
            </>
          ) : (
            <>
              {onAddCustom && (
                <Button
                  variant="ghost"
                  className="mr-auto"
                  onClick={() => {
                    onOpenChange(false)
                    onAddCustom()
                  }}
                >
                  {t("addCustomProvider")}
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {tc("cancel")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default QuickAddProviderDialog
