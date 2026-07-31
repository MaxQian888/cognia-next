"use client"

/**
 * LocalProviderModelManager - Unified model management for local AI providers
 *
 * Supports model listing, downloading, and deletion for providers that support
 * model management (Ollama, LocalAI, Jan).
 */

import { useState, useCallback, useMemo } from "react"
import {
  Download,
  Trash2,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  Server,
  HardDrive,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Cpu,
  Zap,
  ExternalLink,
  Info,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type {
  LocalProviderName,
  LocalModelPullProgress,
} from "@cognia/provider-types/local-provider"
import { formatLocalModelSize } from "@cognia/provider-types/local-provider"
import { getInstallInstructions } from "@cognia/provider-core/providers/local-provider-service"
import {
  useLocalProvider,
  useOllamaModelCapabilities,
  type LocalPullState,
  type LocalProviderErrorCode,
} from "@/hooks/provider"

export interface LocalProviderModelManagerProps {
  providerId: LocalProviderName
  baseUrl?: string
  onModelSelect?: (modelId: string) => void
  selectedModel?: string
  compact?: boolean
}

export function LocalProviderModelManager({
  providerId,
  baseUrl,
  onModelSelect,
  selectedModel,
  compact = false,
}: LocalProviderModelManagerProps) {
  const t = useTranslations("providers")
  const tc = useTranslations("common")

  const {
    config,
    capabilities,
    status,
    isConnected,
    isLoading,
    error,
    models,
    pullStates,
    isPulling,
    refresh,
    pullModel,
    cancelPull,
    deleteModel,
    stopModel: _stopModel,
  } = useLocalProvider({
    providerId,
    baseUrl,
    autoRefresh: true,
    refreshInterval: 30000,
  })

  const [pullInput, setPullInput] = useState("")
  const [showSuggestedModels, setShowSuggestedModels] = useState(false)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)

  // Probed from the server, not guessed from the model name. `useMemo` keeps the
  // id list identity-stable so the probe effect does not re-run every render.
  const modelIds = useMemo(() => models.map((m) => m.id), [models])
  const { capabilities: modelCapabilities } = useOllamaModelCapabilities({
    providerId,
    baseUrl,
    modelIds,
  })

  const installInfo = getInstallInstructions(providerId)

  const handlePullModel = useCallback(async () => {
    const modelName = pullInput.trim()
    if (!modelName) return

    setPullInput("")
    await pullModel(modelName)
  }, [pullInput, pullModel])

  const handleDeleteModel = useCallback(
    async (modelId: string) => {
      setDeletingModel(modelId)
      try {
        await deleteModel(modelId)
      } finally {
        setDeletingModel(null)
      }
    },
    [deleteModel]
  )

  // Format pull progress
  const formatPullProgress = (
    progress: LocalModelPullProgress
  ): { percentage: number; text: string } => {
    if (!progress.total || !progress.completed) {
      return { percentage: progress.percentage || 0, text: progress.status }
    }

    const percentage = Math.round((progress.completed / progress.total) * 100)
    const completedStr = formatLocalModelSize(progress.completed)
    const totalStr = formatLocalModelSize(progress.total)

    return {
      percentage,
      text: `${progress.status} - ${completedStr} / ${totalStr} (${percentage}%)`,
    }
  }

  /**
   * Badges for what a model can actually do, from `/api/show`.
   *
   * Renders nothing until the probe answers, and nothing at all for a provider
   * without `/api/show` — an absent badge means "we did not ask", never "it
   * cannot". A probe that had to fall back to name-matching is marked
   * `inferred` and gets a "guess" affordance rather than being presented with
   * the same confidence as a real answer.
   */
  const renderCapabilityBadges = (modelId: string) => {
    const caps = modelCapabilities.get(modelId)
    if (!caps) return null

    const badges: Array<{ key: string; label: string }> = []
    if (caps.supportsVision) badges.push({ key: "vision", label: t("capabilityVision") })
    if (caps.supportsTools) badges.push({ key: "tools", label: t("capabilityTools") })
    if (caps.supportsEmbedding) badges.push({ key: "embed", label: t("capabilityEmbedding") })
    if (caps.supportsThinking)
      badges.push({ key: "thinking", label: t("modelCapabilityReasoning") })
    if (badges.length === 0) return null

    return (
      <span className="flex items-center gap-1">
        {badges.map((badge) => (
          <Badge
            key={badge.key}
            variant="secondary"
            className="text-[10px]"
            title={
              caps.inferred
                ? t("capabilityInferredHint")
                : caps.contextLength
                  ? t("capabilityContextHint", { tokens: caps.contextLength })
                  : undefined
            }
          >
            {badge.label}
            {caps.inferred && "?"}
          </Badge>
        ))}
      </span>
    )
  }

  /**
   * Translate a hook error. The hook has no `t()`, so anything it authors comes
   * back as a stable code; raw server/exception text falls through unchanged.
   */
  const translateError = useCallback(
    (error: string, modelName?: string): string => {
      switch (error as LocalProviderErrorCode) {
        case "pull-failed":
          return t("pullFailed", { model: modelName ?? "" })
        case "delete-unsupported":
          return t("deleteUnsupported")
        case "stop-unsupported":
          return t("stopUnsupported")
        default:
          return error
      }
    },
    [t]
  )

  /**
   * What to render for one pull row.
   *
   * `indeterminate` comes from the hook and MUST be honored: Ollama's opening
   * lines ("pulling manifest") carry no byte counts, so a percentage during
   * that window would be invented. A determinate 0% bar is a claim; a spinner
   * is the truth.
   */
  const describePull = (state: LocalPullState) => {
    if (state.status === "cancelled") {
      // Ollama's server cannot cancel a pull — the bytes keep coming. Saying so
      // is the whole point; letting the row vanish would imply it stopped.
      return { kind: "cancelled" as const, text: t("pullContinuesInBackground") }
    }
    if (state.error) {
      return { kind: "error" as const, text: translateError(state.error, state.modelName) }
    }
    if (state.indeterminate || !state.progress) {
      return { kind: "indeterminate" as const, text: t("pullStarting") }
    }
    const { percentage, text } = formatPullProgress(state.progress)
    return { kind: "progress" as const, percentage, text }
  }

  // Render connection status
  const renderStatus = () => (
    <div className="flex items-center gap-2">
      <div
        className={cn("h-2 w-2 rounded-full", isConnected ? "bg-green-500" : "bg-destructive")}
      />
      <span className="text-sm text-muted-foreground">
        {isConnected ? (
          <>
            {t("connected")}
            {status?.version && <span className="ml-1 text-xs">v{status.version}</span>}
          </>
        ) : (
          t("disconnected")
        )}
      </span>
      {isConnected && (
        <Badge variant="secondary" className="text-xs">
          {t("modelCount", { count: models.length })}
        </Badge>
      )}
    </div>
  )

  // Compact view - just show model list
  if (compact) {
    return (
      <div className="space-y-3">
        {renderStatus()}

        {isConnected && models.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {models.map((model) => {
              const isSelected = selectedModel === model.id

              return (
                <button
                  key={model.id}
                  onClick={() => onModelSelect?.(model.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  )}
                >
                  {model.id}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Full view
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              {t("providerModels", { provider: config?.name ?? providerId })}
            </CardTitle>
            <CardDescription className="mt-1">{renderStatus()}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {translateError(error)}
          </div>
        )}

        {!isConnected ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            <Server className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{t("providerNotRunning", { provider: config?.name ?? providerId })}</p>
            <p className="mt-2 text-xs">
              <a
                href={installInfo.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t("installProvider", { provider: config?.name ?? providerId })}
              </a>
            </p>
          </div>
        ) : (
          <>
            {/* Pull new model (only for providers that support it) */}
            {capabilities.canPullModels && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    placeholder={`Pull a model (e.g., llama3.2)`}
                    value={pullInput}
                    onChange={(e) => setPullInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        handlePullModel()
                      }
                    }}
                    className="flex-1"
                  />
                  <Button onClick={handlePullModel} disabled={!pullInput.trim() || isPulling}>
                    {isPulling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </Button>
                </div>

                {/* Suggested models dropdown */}
                {providerId === "ollama" && (
                  <Collapsible open={showSuggestedModels} onOpenChange={setShowSuggestedModels}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="w-full justify-between">
                        <span className="text-xs text-muted-foreground">{t("popularModels")}</span>
                        {showSuggestedModels ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                      <div className="grid grid-cols-2 gap-2">
                        {SUGGESTED_MODELS.slice(0, 8).map((model) => {
                          const isInstalled = models.some(
                            (m) => m.id === model.name || m.id.startsWith(model.name + ":")
                          )
                          const isPullingThis = pullStates.get(model.name)?.isActive

                          return (
                            <button
                              key={model.name}
                              onClick={() =>
                                !isInstalled && !isPullingThis && pullModel(model.name)
                              }
                              disabled={isInstalled || isPullingThis}
                              className={cn(
                                "flex flex-col items-start rounded-lg border p-2 text-left text-xs transition-colors",
                                isInstalled
                                  ? "border-green-500/30 bg-green-500/5"
                                  : "hover:bg-muted"
                              )}
                            >
                              <div className="flex w-full items-center justify-between">
                                <span className="font-medium">{model.name}</span>
                                {isInstalled && <Check className="h-3 w-3 text-green-500" />}
                                {isPullingThis && <Loader2 className="h-3 w-3 animate-spin" />}
                              </div>
                              <span className="text-muted-foreground">{model.size}</span>
                            </button>
                          )
                        })}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            )}

            {/* Active pulls progress */}
            {pullStates.size > 0 && (
              <div className="space-y-2">
                {Array.from(pullStates.entries()).map(([modelName, state]) => {
                  // A cancelled row STAYS: it is the only place the user learns
                  // the download did not actually stop. Only a completed pull
                  // leaves quietly — the model list itself is the receipt.
                  if (state.status === "completed") return null

                  const detail = describePull(state)

                  return (
                    <div key={modelName} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {detail.kind === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : detail.kind === "cancelled" ? (
                            <Info className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <Download className="h-4 w-4 animate-pulse text-primary" />
                          )}
                          <span className="text-sm font-medium">{modelName}</span>
                        </div>
                        {state.isActive && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={t("stopShowingPullProgress", { model: modelName })}
                            onClick={() => cancelPull(modelName)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                      {detail.kind === "error" ? (
                        <p className="text-xs text-destructive">{detail.text}</p>
                      ) : detail.kind === "cancelled" ? (
                        <p className="text-xs text-muted-foreground">{detail.text}</p>
                      ) : detail.kind === "indeterminate" ? (
                        <>
                          {/* A spinner, NOT a bar. The server has sent no byte
                              counts yet, so there is no percentage to draw —
                              and `components/ui/progress.tsx` cannot express
                              "unknown" anyway: it never forwards `value` to
                              Radix and renders `value || 0`, so an omitted
                              value is pixel-identical to a definite 0%. A bar
                              here would state a number we do not have. */}
                          <div
                            role="status"
                            aria-live="polite"
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {detail.text}
                          </div>
                        </>
                      ) : (
                        <>
                          <Progress value={detail.percentage} className="h-2" />
                          <p className="text-xs text-muted-foreground">{detail.text}</p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Installed models list */}
            {models.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t("installedModels")}</h4>
                <div className="space-y-1">
                  {models.map((model) => {
                    const isSelected = selectedModel === model.id
                    const isDeleting = deletingModel === model.id

                    return (
                      <div
                        key={model.id}
                        className={cn(
                          "flex items-center justify-between rounded-lg border p-2 transition-colors",
                          isSelected && "border-primary bg-primary/5"
                        )}
                      >
                        <button
                          onClick={() => onModelSelect?.(model.id)}
                          className="flex flex-1 items-center gap-2 text-left"
                        >
                          <Cpu className="h-4 w-4 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm truncate">{model.id}</span>
                              {model.quantization && (
                                <Badge variant="outline" className="text-[10px]">
                                  {model.quantization}
                                </Badge>
                              )}
                              {renderCapabilityBadges(model.id)}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {model.size && (
                                <span className="flex items-center gap-1">
                                  <HardDrive className="h-3 w-3" />
                                  {formatLocalModelSize(model.size)}
                                </span>
                              )}
                              {model.family && (
                                <span className="flex items-center gap-1">
                                  <Zap className="h-3 w-3" />
                                  {model.family}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>

                        {capabilities.canDeleteModels && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                disabled={isDeleting}
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t("deleteModel")}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("deleteModelConfirm", { model: model.id })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDeleteModel(model.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  {tc("delete")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                <Plus className="mx-auto mb-2 h-6 w-6 opacity-50" />
                <p>{t("noModelsInstalled")}</p>
                {capabilities.canPullModels && (
                  <p className="mt-1 text-xs">{t("pullModelToStart")}</p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// Suggested models for quick installation
const SUGGESTED_MODELS = [
  { name: "llama3.2", description: "Meta Llama 3.2 (3B)", size: "2.0GB" },
  { name: "llama3.2:1b", description: "Meta Llama 3.2 (1B)", size: "1.3GB" },
  { name: "qwen2.5", description: "Qwen 2.5 (7B)", size: "4.7GB" },
  { name: "qwen2.5:3b", description: "Qwen 2.5 (3B)", size: "1.9GB" },
  { name: "mistral", description: "Mistral (7B)", size: "4.1GB" },
  { name: "gemma2:2b", description: "Google Gemma 2 (2B)", size: "1.6GB" },
  { name: "phi3", description: "Microsoft Phi-3 (3.8B)", size: "2.2GB" },
  { name: "nomic-embed-text", description: "Nomic Embed", size: "274MB" },
]

export default LocalProviderModelManager
