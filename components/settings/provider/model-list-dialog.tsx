"use client"

/**
 * ModelListDialog - Dialog for selecting and managing available models
 * Matches the design spec with search, filters, and multi-select capability
 */

import { useState, useMemo, useCallback } from "react"
import { Search, X, Eye, Wrench, Brain, Sparkles, Settings2, Star } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSettingsStore } from "@/stores"
import { getCurrencyForLocale, CURRENCIES } from "@/types/system/usage"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { Model } from "@cognia/provider-types"

type FilterType = "all" | "vision" | "tools" | "reasoning"

interface ModelListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: Model[]
  /** Model IDs that are enabled (checked). */
  selectedModels: string[]
  /** Called with the new set of enabled model IDs on confirm. */
  onModelsChange: (models: string[]) => void
  /** Current default model ID (shown with a star). */
  defaultModelId?: string
  /** Called when the user sets a model as default. */
  onDefaultModelChange?: (modelId: string) => void
  providerName?: string
  onModelSettings?: (model: Model) => void
}

export function ModelListDialog({
  open,
  onOpenChange,
  models,
  selectedModels,
  onModelsChange,
  defaultModelId,
  onDefaultModelChange,
  providerName: _providerName = "Provider",
  onModelSettings,
}: ModelListDialogProps) {
  const t = useTranslations("providers")
  const translate = useCallback(
    (key: string, fallback: string, values?: Record<string, unknown>) => {
      if (typeof t.has === "function" && !t.has(key)) {
        return fallback
      }

      return t(key as never, values as never)
    },
    [t]
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilter, setActiveFilter] = useState<FilterType>("all")
  const [localSelected, setLocalSelected] = useState<string[]>(selectedModels)

  // Reset local state when dialog opens
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        setLocalSelected(selectedModels)
        setSearchQuery("")
        setActiveFilter("all")
      }
      onOpenChange(isOpen)
    },
    [selectedModels, onOpenChange]
  )

  // Filter models based on search and capabilities
  const filteredModels = useMemo(() => {
    return models.filter((model) => {
      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        if (!model.name.toLowerCase().includes(query) && !model.id.toLowerCase().includes(query)) {
          return false
        }
      }

      // Capability filter
      switch (activeFilter) {
        case "vision":
          return model.supportsVision
        case "tools":
          return model.supportsTools
        case "reasoning":
          return model.supportsReasoning
        default:
          return true
      }
    })
  }, [models, searchQuery, activeFilter])

  // Count models by capability
  const capabilityCounts = useMemo(() => {
    return {
      all: models.length,
      vision: models.filter((m) => m.supportsVision).length,
      tools: models.filter((m) => m.supportsTools).length,
      reasoning: models.filter((m) => m.supportsReasoning).length,
    }
  }, [models])

  const toggleModel = (modelId: string) => {
    setLocalSelected((prev) =>
      prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]
    )
  }

  const toggleSelectAll = () => {
    if (localSelected.length === filteredModels.length) {
      setLocalSelected([])
    } else {
      setLocalSelected(filteredModels.map((m) => m.id))
    }
  }

  const handleConfirm = () => {
    onModelsChange(localSelected)
    onOpenChange(false)
  }

  const filterButtons: { key: FilterType; icon: React.ReactNode; label: string }[] = [
    { key: "all", icon: <Sparkles className="h-3 w-3" />, label: translate("filterAll", "All") },
    {
      key: "vision",
      icon: <Eye className="h-3 w-3" />,
      label: translate("filterVision", "Vision"),
    },
    {
      key: "tools",
      icon: <Wrench className="h-3 w-3" />,
      label: translate("filterTools", "Tools"),
    },
    {
      key: "reasoning",
      icon: <Brain className="h-3 w-3" />,
      label: translate("filterReasoning", "Reasoning"),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-full max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:max-w-[500px]"
      >
        {/* Header */}
        <DialogHeader className="gap-3 border-b px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-semibold">
              {translate("availableModels", "Available Models")}
            </DialogTitle>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg">
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="text-left text-sm text-muted-foreground">
            {translate(
              "modelSelectionDescription",
              "Search, filter, and enable the models available for this provider."
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="px-4 py-3 sm:px-5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={translate("searchModels", "Search models...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-10"
              autoComplete="off"
              data-form-type="other"
              data-lpignore="true"
            />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col gap-3 px-4 pb-3 sm:px-5">
          <div className="flex items-start gap-2 sm:items-center">
            <Checkbox
              id="select-all"
              checked={filteredModels.length > 0 && localSelected.length === filteredModels.length}
              onCheckedChange={toggleSelectAll}
            />
            <label
              htmlFor="select-all"
              className="cursor-pointer whitespace-nowrap text-sm font-medium leading-5"
            >
              {translate("selectAll", "Select All")}
            </label>
          </div>
          <Tabs value={activeFilter} onValueChange={(v) => setActiveFilter(v as FilterType)}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-secondary/50 lg:flex lg:w-auto">
              {filterButtons.map((filter) => (
                <TabsTrigger
                  key={filter.key}
                  value={filter.key}
                  className="min-w-0 justify-start text-xs gap-1 px-2 data-[state=active]:bg-background sm:justify-center sm:px-2.5"
                >
                  {filter.icon}
                  {filter.label}
                  <span className="ml-0.5 opacity-70">{capabilityCounts[filter.key]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Model List */}
        <ScrollArea className="min-h-0 flex-1 px-4 sm:px-5">
          <div className="space-y-2 pb-4">
            {filteredModels.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {translate("noModelsFound", "No models found")}
              </div>
            ) : (
              filteredModels.map((model) => (
                <ModelListItem
                  key={model.id}
                  model={model}
                  selected={localSelected.includes(model.id)}
                  isDefault={defaultModelId === model.id}
                  onToggle={() => toggleModel(model.id)}
                  onSetDefault={
                    onDefaultModelChange ? () => onDefaultModelChange(model.id) : undefined
                  }
                  onSettings={onModelSettings ? () => onModelSettings(model) : undefined}
                />
              ))
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <DialogFooter className="flex items-start justify-between gap-3 border-t bg-muted/30 px-4 py-4 sm:px-5 max-md:flex-col md:items-center">
          <span className="text-sm text-muted-foreground max-md:w-full">
            {translate("modelsSelected", `${localSelected.length} models enabled`, {
              count: localSelected.length,
            })}
          </span>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end md:w-auto">
            <DialogClose asChild>
              <Button variant="outline" className="w-full sm:w-auto">
                {translate("cancel", "Cancel")}
              </Button>
            </DialogClose>
            <Button onClick={handleConfirm} className="w-full sm:w-auto">
              {translate("confirmSelection", "Confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ModelListItemProps {
  model: Model
  selected: boolean
  isDefault?: boolean
  onToggle: () => void
  onSetDefault?: () => void
  onSettings?: () => void
}

function ModelListItem({
  model,
  selected,
  isDefault,
  onToggle,
  onSetDefault,
  onSettings,
}: ModelListItemProps) {
  const t = useTranslations("providers")
  const language = useSettingsStore((s) => s.language)
  const currency = getCurrencyForLocale(language)
  const currencyConfig = CURRENCIES[currency]

  const formatContextLength = (length: number) => {
    if (length >= 1000000) {
      return `${(length / 1000000).toFixed(1)}M`
    }
    return `${Math.round(length / 1000)}K`
  }

  const pricingCurrency = model.pricing?.currency
  const isCNY = pricingCurrency === "CNY"

  const formatPrice = (price?: number) => {
    if (price === undefined || price === null) return null
    if (isCNY) {
      return `¥${price}`
    }
    const converted = price * currencyConfig.rateFromUSD
    return `${currencyConfig.symbol}${converted.toFixed(currencyConfig.decimals)}`
  }

  const hasCachePrice = model.pricing?.cachedInputPer1M !== undefined
  const hasBatchPrice = model.pricing?.batchInputPer1M !== undefined

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onToggle()
        }
      }}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        "flex items-start justify-between gap-3 max-sm:flex-col",
        selected ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-muted/50"
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Checkbox
          checked={selected}
          className="shrink-0"
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{model.name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>
              {formatContextLength(model.contextLength)} {t("context")}
            </span>
            {model.pricing && model.pricing.promptPer1M > 0 && (
              <>
                <span>•</span>
                <span>
                  {formatPrice(model.pricing.promptPer1M)}/
                  {formatPrice(model.pricing.completionPer1M)} /1M
                </span>
              </>
            )}
            {model.pricing && model.pricing.promptPer1M === 0 && (
              <>
                <span>•</span>
                <span className="text-green-600">{t("free")}</span>
              </>
            )}
            {hasCachePrice && (
              <>
                <span>•</span>
                <span title={t("cachedInputPrice")}>
                  {t("cachedInputShort")} {formatPrice(model.pricing!.cachedInputPer1M)}
                </span>
              </>
            )}
            {hasBatchPrice && (
              <>
                <span>•</span>
                <span title={t("batchApiPrice")}>
                  {t("batchShort")} {formatPrice(model.pricing!.batchInputPer1M)}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:w-full max-sm:justify-end">
        {model.supportsVision && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1">
            <Eye className="h-2.5 w-2.5" />
            {t("filterVision")}
          </Badge>
        )}
        {model.supportsTools && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1">
            <Wrench className="h-2.5 w-2.5" />
            {t("filterTools")}
          </Badge>
        )}
        {model.supportsReasoning && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 gap-1">
            <Brain className="h-2.5 w-2.5" />
            {t("filterReasoning")}
          </Badge>
        )}
        {onSetDefault && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              onSetDefault()
            }}
            className={cn(isDefault && "text-amber-500")}
            title={isDefault ? t("defaultModel") : t("setAsDefault")}
          >
            <Star
              className={cn("h-3.5 w-3.5", isDefault ? "fill-current" : "text-muted-foreground")}
            />
          </Button>
        )}
        {onSettings && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              onSettings()
            }}
            title={t("modelSettings")}
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  )
}

export default ModelListDialog
