"use client"

/**
 * OllamaModelManager - UI for managing local Ollama models
 * Features: model list, pull/download, delete, status monitoring
 */

import { useState, useCallback } from "react"
import {
  Download,
  Trash2,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  Server,
  HardDrive,
  Clock,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Cpu,
  Zap,
  Eye,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useOllama } from "@/hooks/ai"
import {
  formatModelSize,
  formatPullProgress,
  parseModelName,
  POPULAR_OLLAMA_MODELS,
} from "@cognia/provider-types/ollama"

interface OllamaModelManagerProps {
  baseUrl: string
  onModelSelect?: (modelName: string) => void
  selectedModel?: string
  compact?: boolean
}

export function OllamaModelManager({
  baseUrl,
  onModelSelect,
  selectedModel,
  compact = false,
}: OllamaModelManagerProps) {
  const t = useTranslations("providers")
  const tc = useTranslations("common")

  const {
    status,
    isConnected,
    isLoading,
    error,
    models,
    runningModels,
    pullStates,
    isPulling,
    refresh,
    pullModel,
    cancelPull,
    deleteModel,
    stopModel,
  } = useOllama({ baseUrl, autoRefresh: true, refreshInterval: 30000 })

  const [pullInput, setPullInput] = useState("")
  const [showPopularModels, setShowPopularModels] = useState(false)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)

  const handlePullModel = useCallback(async () => {
    const modelName = pullInput.trim()
    if (!modelName) return

    setPullInput("")
    await pullModel(modelName)
  }, [pullInput, pullModel])

  const handleQuickPull = useCallback(
    async (modelName: string) => {
      await pullModel(modelName)
      setShowPopularModels(false)
    },
    [pullModel]
  )

  const handleDeleteModel = useCallback(
    async (modelName: string) => {
      setDeletingModel(modelName)
      try {
        await deleteModel(modelName)
      } finally {
        setDeletingModel(null)
      }
    },
    [deleteModel]
  )

  const isModelRunning = useCallback(
    (modelName: string) => {
      return runningModels.some((m) => m.name === modelName || m.model === modelName)
    },
    [runningModels]
  )

  // Render connection status
  const renderStatus = () => (
    <div className="flex items-center gap-2">
      <div
        className={cn("h-2 w-2 rounded-full", isConnected ? "bg-green-500" : "bg-destructive")}
      />
      <span className="text-sm text-muted-foreground">
        {isConnected ? (
          <>
            {t("ollamaConnected")}
            {status?.version && <span className="ml-1 text-xs">v{status.version}</span>}
          </>
        ) : (
          t("ollamaDisconnected")
        )}
      </span>
      {isConnected && (
        <Badge variant="secondary" className="text-xs">
          {models.length} {t("modelsCount")}
        </Badge>
      )}
    </div>
  )

  // Render compact version
  if (compact) {
    return (
      <div className="space-y-3">
        {renderStatus()}

        {isConnected && models.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {models.map((model) => {
              const { name, tag } = parseModelName(model.name)
              const isSelected = selectedModel === model.name
              const isRunning = isModelRunning(model.name)

              return (
                <Button
                  key={model.name}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onModelSelect?.(model.name)}
                  className={cn(
                    "h-auto gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  )}
                >
                  {isRunning && <Zap className="h-3 w-3" />}
                  {name}
                  {tag !== "latest" && <span className="opacity-60">:{tag}</span>}
                </Button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Render full version
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              {t("ollamaModels")}
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
            {error}
          </div>
        )}

        {!isConnected ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            <Server className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{t("ollamaNotRunning")}</p>
            <p className="mt-1 text-xs">
              {/* i18n-exempt: executable command */}
              {t("ollamaStartHint")} <code className="rounded bg-muted px-1">ollama serve</code>
            </p>
          </div>
        ) : (
          <>
            {/* Pull new model */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  placeholder={t("ollamaPullPlaceholder")}
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

              {/* Popular models dropdown */}
              <Collapsible open={showPopularModels} onOpenChange={setShowPopularModels}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between">
                    <span className="text-xs text-muted-foreground">
                      {t("ollamaPopularModels")}
                    </span>
                    {showPopularModels ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="grid grid-cols-2 gap-2">
                    {POPULAR_OLLAMA_MODELS.slice(0, 8).map((model) => {
                      const isInstalled = models.some(
                        (m) => m.name === model.name || m.name.startsWith(model.name + ":")
                      )
                      const isPullingThis = pullStates.get(model.name)?.isActive

                      return (
                        <Button
                          key={model.name}
                          type="button"
                          variant="outline"
                          onClick={() =>
                            !isInstalled && !isPullingThis && handleQuickPull(model.name)
                          }
                          disabled={isInstalled || isPullingThis}
                          className={cn(
                            "h-auto flex-col items-start justify-start whitespace-normal rounded-lg p-2 text-left text-xs font-normal",
                            isInstalled ? "border-green-500/30 bg-green-500/5" : "hover:bg-muted"
                          )}
                        >
                          <div className="flex w-full items-center justify-between">
                            <span className="font-medium">{model.name}</span>
                            {isInstalled && <Check className="h-3 w-3 text-green-500" />}
                            {isPullingThis && <Loader2 className="h-3 w-3 animate-spin" />}
                          </div>
                          <span className="text-muted-foreground">{model.size}</span>
                        </Button>
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>

            {/* Active pulls progress */}
            {pullStates.size > 0 && (
              <div className="space-y-2">
                {Array.from(pullStates.entries()).map(([modelName, state]) => {
                  if (!state.isActive && !state.error) return null

                  const { percentage, text } = state.progress
                    ? formatPullProgress(state.progress)
                    : { percentage: 0, text: t("starting") }

                  return (
                    <div key={modelName} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {state.error ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <Download className="h-4 w-4 animate-pulse text-primary" />
                          )}
                          <span className="text-sm font-medium">{modelName}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => cancelPull(modelName)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      {state.error ? (
                        <p className="text-xs text-destructive">{state.error}</p>
                      ) : (
                        <>
                          <Progress value={percentage} className="h-2" />
                          <p className="text-xs text-muted-foreground">{text}</p>
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
                <h4 className="text-sm font-medium">{t("ollamaInstalledModels")}</h4>
                <div className="space-y-1">
                  {models.map((model) => {
                    const { name, tag } = parseModelName(model.name)
                    const isSelected = selectedModel === model.name
                    const isRunning = isModelRunning(model.name)
                    const isDeleting = deletingModel === model.name

                    return (
                      <div
                        key={model.name}
                        className={cn(
                          "flex items-center justify-between rounded-lg border p-2 transition-colors",
                          isSelected && "border-primary bg-primary/5",
                          isRunning && "border-green-500/30"
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => onModelSelect?.(model.name)}
                          className="h-auto flex-1 justify-start gap-2 whitespace-normal p-0 text-left font-normal hover:bg-transparent"
                        >
                          <Cpu className="h-4 w-4 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm truncate">{name}</span>
                              {tag !== "latest" && (
                                <Badge variant="outline" className="text-[10px]">
                                  {tag}
                                </Badge>
                              )}
                              {isRunning && (
                                <Badge variant="success" className="text-[10px]">
                                  <Zap className="h-2.5 w-2.5 mr-0.5" />
                                  {t("running")}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <HardDrive className="h-3 w-3" />
                                {formatModelSize(model.size ?? 0)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {model.modified_at
                                  ? new Date(model.modified_at).toLocaleDateString()
                                  : "—"}
                              </span>
                            </div>
                          </div>
                        </Button>

                        <div className="flex items-center gap-1">
                          {isRunning && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => stopModel(model.name)}
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t("stopModel")}</TooltipContent>
                            </Tooltip>
                          )}

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
                                <AlertDialogTitle>{t("ollamaDeleteTitle")}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("ollamaDeleteDescription", { model: model.name })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDeleteModel(model.name)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  {tc("delete")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                <Plus className="mx-auto mb-2 h-6 w-6 opacity-50" />
                <p>{t("ollamaNoModels")}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
