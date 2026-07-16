"use client"

/**
 * CustomProviderDialog - Add/Edit custom providers with multi-protocol support
 * Supports OpenAI, Anthropic, and Gemini API protocols
 */

import { useState, useEffect, useMemo } from "react"
import { Plus, X, AlertCircle, Eye, EyeOff, Settings2, RefreshCw, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ApiFlavor, ApiProtocol, ProviderModelDiscoveryEntry } from "@cognia/provider-types"
import type { CustomModelMetadata, CustomProviderSettings } from "@/stores/settings/settings-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSettingsStore } from "@/stores/settings"
import { useConnectionTest } from "@/hooks/settings/use-connection-test"
import { ProtocolSelectContent } from "./protocol-select-content"
import {
  buildCustomProviderModelDiscoverySnapshot,
  discoverOpenAICompatibleModels,
} from "@cognia/provider-core/providers/model-discovery"
import { ConnectionStatusCard, toConnectionCardResult } from "./provider-config-tab"

const PROTOCOL_DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
}

/** Default base URL for a protocol; plugin protocols have none. */
function defaultBaseUrlFor(protocol: ApiProtocol): string {
  return PROTOCOL_DEFAULT_BASE_URLS[protocol] ?? ""
}

interface CustomProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingProviderId: string | null
}

export function CustomProviderDialog({
  open,
  onOpenChange,
  editingProviderId,
}: CustomProviderDialogProps) {
  const t = useTranslations("providers")
  const tc = useTranslations("common")

  const customProvidersList = useSettingsStore((state) => state.customProviders)
  // cognia-next stores customs as an array; Cognia's UI expects a record
  // keyed by id. Convert here so the index-access syntax below works.
  const customProviders = useMemo<Record<string, CustomProviderSettings>>(() => {
    const out: Record<string, CustomProviderSettings> = {}
    for (const cp of customProvidersList) {
      out[cp.id] = cp
    }
    return out
  }, [customProvidersList])
  const addCustomProvider = useSettingsStore((state) => state.addCustomProvider)
  const updateCustomProvider = useSettingsStore((state) => state.updateCustomProvider)
  const removeCustomProvider = useSettingsStore((state) => state.removeCustomProvider)

  const [name, setName] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [apiProtocol, setApiProtocol] = useState<ApiProtocol>("openai")
  // OpenAI endpoint family override. "auto" keeps the host heuristic; "responses"
  // forces the Responses API (unlocks it on Azure / gateways / custom URLs).
  const [apiFlavor, setApiFlavor] = useState<ApiFlavor>("auto")
  const {
    testing,
    result: testResult,
    test: runConnectionTest,
    reset: resetTestResult,
  } = useConnectionTest()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [modelMetadata, setModelMetadata] = useState<Record<string, CustomModelMetadata>>({})
  const [expandedModelSettings, setExpandedModelSettings] = useState<string | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModelDiscoveryEntry[]>([])
  const [discoveredModelsLastFetched, setDiscoveredModelsLastFetched] = useState<
    number | undefined
  >()
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)

  const availableModels = useMemo(
    () =>
      buildCustomProviderModelDiscoverySnapshot({
        providerId: editingProviderId || "custom-provider-draft",
        provider: {
          customModels: models,
          customModelMetadata: modelMetadata,
          discoveredModels,
          discoveredModelsLastFetched,
        },
      }).models,
    [discoveredModels, discoveredModelsLastFetched, editingProviderId, modelMetadata, models]
  )

  // Load data when editing
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      if (editingProviderId && customProviders[editingProviderId]) {
        const provider = customProviders[editingProviderId]
        setName(provider.customName)
        setBaseURL(provider.baseURL || "")
        setApiKey(provider.apiKey || "")
        setApiProtocol(provider.apiProtocol || "openai")
        setApiFlavor(provider.apiFlavor || "auto")
        setModels(provider.customModels || [])
        setDefaultModel(provider.defaultModel || "")
        setModelMetadata(provider.customModelMetadata || {})
        setDiscoveredModels(provider.discoveredModels || [])
        setDiscoveredModelsLastFetched(provider.discoveredModelsLastFetched)
      } else {
        // Reset for new provider
        setName("")
        setBaseURL("")
        setApiKey("")
        setApiProtocol("openai")
        setApiFlavor("auto")
        setModels([])
        setNewModel("")
        setDefaultModel("")
        setModelMetadata({})
        setExpandedModelSettings(null)
        setDiscoveredModels([])
        setDiscoveredModelsLastFetched(undefined)
      }
      resetTestResult()
      setShowDeleteConfirm(false)
      setShowKey(false)
      setDiscoveryError(null)
    }, 0)
    return () => clearTimeout(timer)
  }, [open, editingProviderId, customProviders, resetTestResult])

  const handleAddModel = () => {
    const trimmedModel = newModel.trim()
    if (trimmedModel && !models.includes(trimmedModel)) {
      const updatedModels = [...models, trimmedModel]
      setModels(updatedModels)
      if (!defaultModel) {
        setDefaultModel(trimmedModel)
      }
      // Initialize metadata for new model
      setModelMetadata((prev) => ({
        ...prev,
        [trimmedModel]: { id: trimmedModel },
      }))
      setNewModel("")
    }
  }

  const handleRemoveModel = (model: string) => {
    const updatedModels = models.filter((m) => m !== model)
    const updatedDiscoveredModels = discoveredModels.filter((candidate) => candidate.id !== model)
    const { [model]: _removedModel, ...remainingMetadata } = modelMetadata
    const nextAvailableModels = buildCustomProviderModelDiscoverySnapshot({
      providerId: editingProviderId || "custom-provider-draft",
      provider: {
        customModels: updatedModels,
        customModelMetadata: remainingMetadata,
        discoveredModels: updatedDiscoveredModels,
        discoveredModelsLastFetched,
      },
    }).models

    setModels(updatedModels)
    setDiscoveredModels(updatedDiscoveredModels)
    if (defaultModel === model) {
      setDefaultModel(nextAvailableModels[0]?.id || "")
    }
    setModelMetadata(remainingMetadata)
    if (expandedModelSettings === model) {
      setExpandedModelSettings(null)
    }
  }

  const updateModelMetadata = (modelId: string, updates: Partial<CustomModelMetadata>) => {
    setModelMetadata((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], id: modelId, ...updates },
    }))
  }

  const handleTestConnection = async () => {
    if (!baseURL || !apiKey) return
    await runConnectionTest(baseURL, apiKey, apiProtocol, defaultModel || models[0])
  }

  const handleDiscoverModels = async () => {
    if (apiProtocol !== "openai" || !baseURL.trim()) return

    setDiscoveringModels(true)
    setDiscoveryError(null)

    try {
      const remoteModels = await discoverOpenAICompatibleModels({
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim() || undefined,
      })
      const fetchedAt = Date.now()
      const nextAvailableModels = buildCustomProviderModelDiscoverySnapshot({
        providerId: editingProviderId || "custom-provider-draft",
        provider: {
          customModels: models,
          customModelMetadata: modelMetadata,
          discoveredModels: remoteModels,
          discoveredModelsLastFetched: fetchedAt,
        },
      }).models

      setDiscoveredModels(remoteModels)
      setDiscoveredModelsLastFetched(fetchedAt)
      if (!nextAvailableModels.some((model) => model.id === defaultModel)) {
        setDefaultModel(nextAvailableModels[0]?.id || "")
      }
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : "Failed to fetch models")
    } finally {
      setDiscoveringModels(false)
    }
  }

  const handleSave = () => {
    if (!name.trim() || !baseURL.trim() || availableModels.length === 0) return

    const providerData = {
      providerId: editingProviderId || "",
      customName: name.trim(),
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      apiProtocol,
      // Only the OpenAI family has a Responses/Chat split; force "auto" for the
      // others so a stale override can't ride along after a protocol switch.
      apiFlavor: apiProtocol === "openai" ? apiFlavor : "auto",
      customModels: models,
      customModelMetadata: modelMetadata,
      discoveredModels,
      discoveredModelsLastFetched,
      defaultModel: defaultModel || availableModels[0]?.id || "",
      enabled: editingProviderId ? (customProviders[editingProviderId]?.enabled ?? true) : true,
    }

    if (editingProviderId) {
      updateCustomProvider(editingProviderId, providerData)
    } else {
      addCustomProvider(providerData)
    }

    onOpenChange(false)
  }

  const handleDelete = () => {
    if (editingProviderId) {
      removeCustomProvider(editingProviderId)
      onOpenChange(false)
    }
  }

  const isEditing = !!editingProviderId
  const canSave = name.trim() && baseURL.trim() && availableModels.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? t("editCustomProvider") : t("addCustomProvider")}</DialogTitle>
          <DialogDescription>{t("customProviderDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Provider Name */}
          <div className="space-y-2">
            <Label htmlFor="provider-name">{t("providerName")}</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("providerNamePlaceholder")}
            />
          </div>

          {/* API Protocol */}
          <div className="space-y-2">
            <Label htmlFor="api-protocol">{t("apiProtocol")}</Label>
            <Select
              value={apiProtocol}
              onValueChange={(v) => {
                const nextProtocol = v as ApiProtocol
                const prevDefault = defaultBaseUrlFor(apiProtocol)
                setApiProtocol(nextProtocol)
                resetTestResult()
                setDiscoveryError(null)
                setDiscoveredModels([])
                setDiscoveredModelsLastFetched(undefined)
                // Auto-fill base URL when switching protocols if it's empty or matched the previous protocol's default
                if (!baseURL.trim() || baseURL.trim() === prevDefault) {
                  setBaseURL(defaultBaseUrlFor(nextProtocol))
                }
              }}
            >
              <SelectTrigger id="api-protocol">
                <SelectValue placeholder={t("selectProtocol")} />
              </SelectTrigger>
              <ProtocolSelectContent />
            </Select>
            <p className="text-xs text-muted-foreground">{t("apiProtocolHint")}</p>
          </div>

          {/* API Flavor (OpenAI family only): Responses vs Chat Completions */}
          {apiProtocol === "openai" && (
            <div className="space-y-2">
              <Label htmlFor="api-flavor">{t("apiFlavor")}</Label>
              <Select value={apiFlavor} onValueChange={(v) => setApiFlavor(v as ApiFlavor)}>
                <SelectTrigger id="api-flavor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorAuto")}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("apiFlavorAutoDesc")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="responses">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorResponses")}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("apiFlavorResponsesDesc")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="chat">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorChat")}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("apiFlavorChatDesc")}
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("apiFlavorHint")}</p>
            </div>
          )}

          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="base-url">{t("baseURL")}</Label>
            <Input
              id="base-url"
              value={baseURL}
              onChange={(e) => {
                const nextBaseURL = e.target.value
                setBaseURL(nextBaseURL)
                resetTestResult()
                setDiscoveryError(null)
                setDiscoveredModels([])
                setDiscoveredModelsLastFetched(undefined)
              }}
              placeholder={
                apiProtocol === "anthropic"
                  ? "https://api.anthropic.com/v1"
                  : apiProtocol === "gemini"
                    ? "https://generativelanguage.googleapis.com/v1beta"
                    : "https://api.example.com/v1"
              }
            />
            <p className="text-xs text-muted-foreground">{t("baseURLHint")}</p>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="api-key">{t("apiKey")}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
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
                disabled={!baseURL || !apiKey || testing}
              >
                {testing ? tc("loading") : t("test")}
              </Button>
            </div>
            {testResult && <ConnectionStatusCard result={toConnectionCardResult(testResult)} />}
          </div>

          {/* Models */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("models")}</Label>
              {apiProtocol === "openai" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDiscoverModels}
                  disabled={!baseURL.trim() || discoveringModels}
                  aria-label={t("clickRefreshToLoad")}
                >
                  {discoveringModels ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder={t("modelPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    handleAddModel()
                  }
                }}
              />
              <Button variant="outline" size="icon" onClick={handleAddModel}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {discoveryError && (
              <p className="flex items-center gap-1 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {discoveryError}
              </p>
            )}

            {availableModels.length > 0 && (
              <div className="space-y-2 mt-2">
                {availableModels.map((model) => (
                  <div key={model.id} className="border rounded-md p-2">
                    <div className="flex items-center justify-between">
                      <Badge
                        variant={model.id === defaultModel ? "default" : "secondary"}
                        className="cursor-pointer"
                        onClick={() => setDefaultModel(model.id)}
                      >
                        {model.name}
                        {model.id === defaultModel && (
                          <span className="ml-1 text-xs">({t("default")})</span>
                        )}
                      </Badge>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() =>
                            setExpandedModelSettings(
                              expandedModelSettings === model.id ? null : model.id
                            )
                          }
                          title={t("modelSettings") || "Model Settings"}
                        >
                          <Settings2 className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 hover:text-destructive"
                          onClick={() => handleRemoveModel(model.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Expandable Model Settings */}
                    {expandedModelSettings === model.id && (
                      <div className="mt-2 pt-2 border-t space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">
                              {t("contextLength") || "Context Length"}
                            </Label>
                            <Input
                              type="number"
                              className="h-7 text-xs"
                              placeholder="128000"
                              value={
                                modelMetadata[model.id]?.contextLength || model.contextLength || ""
                              }
                              onChange={(e) =>
                                updateModelMetadata(model.id, {
                                  contextLength: e.target.value
                                    ? parseInt(e.target.value)
                                    : undefined,
                                })
                              }
                            />
                          </div>
                          <div>
                            <Label className="text-xs">
                              {t("maxOutputTokens") || "Max Output"}
                            </Label>
                            <Input
                              type="number"
                              className="h-7 text-xs"
                              placeholder="4096"
                              value={
                                modelMetadata[model.id]?.maxOutputTokens ||
                                model.maxOutputTokens ||
                                ""
                              }
                              onChange={(e) =>
                                updateModelMetadata(model.id, {
                                  maxOutputTokens: e.target.value
                                    ? parseInt(e.target.value)
                                    : undefined,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">{t("inputPricing") || "Input $/1M"}</Label>
                            <Input
                              type="number"
                              step="0.01"
                              className="h-7 text-xs"
                              placeholder="0.00"
                              value={
                                modelMetadata[model.id]?.pricing?.promptPer1M ||
                                model.pricing?.promptPer1M ||
                                ""
                              }
                              onChange={(e) =>
                                updateModelMetadata(model.id, {
                                  pricing: {
                                    ...modelMetadata[model.id]?.pricing,
                                    promptPer1M: e.target.value
                                      ? parseFloat(e.target.value)
                                      : undefined,
                                  },
                                })
                              }
                            />
                          </div>
                          <div>
                            <Label className="text-xs">{t("outputPricing") || "Output $/1M"}</Label>
                            <Input
                              type="number"
                              step="0.01"
                              className="h-7 text-xs"
                              placeholder="0.00"
                              value={
                                modelMetadata[model.id]?.pricing?.completionPer1M ||
                                model.pricing?.completionPer1M ||
                                ""
                              }
                              onChange={(e) =>
                                updateModelMetadata(model.id, {
                                  pricing: {
                                    ...modelMetadata[model.id]?.pricing,
                                    completionPer1M: e.target.value
                                      ? parseFloat(e.target.value)
                                      : undefined,
                                  },
                                })
                              }
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("modelsHint")}</p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {isEditing && (
            <>
              {showDeleteConfirm ? (
                <div className="flex items-center gap-2 mr-auto">
                  <span className="text-sm text-destructive">{t("confirmDeleteProvider")}</span>
                  <Button variant="destructive" size="sm" onClick={handleDelete}>
                    {tc("confirm")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                    {tc("cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="mr-auto text-destructive hover:text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  {tc("delete")}
                </Button>
              )}
            </>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CustomProviderDialog
