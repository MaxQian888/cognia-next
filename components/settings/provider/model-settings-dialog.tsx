"use client"

/**
 * ModelSettingsDialog - Dialog for configuring individual model settings
 * Matches the design spec with capabilities, context window, pricing configuration
 */

import { useState, useMemo } from "react"
import { X, Eye, Wrench, Image, Database, ArrowUpDown, Video, RefreshCw, Info } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { Model } from "@/types/provider"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"

interface ModelSettings {
  contextWindow: number
  maxOutputTokens: number
  inputPricePer1M: number
  outputPricePer1M: number
  capabilities: {
    vision: boolean
    tools: boolean
    imageGeneration: boolean
    embedding: boolean
    reranking: boolean
    video: boolean
  }
}

interface ModelSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  model: Model | null
  providerId: string
  onSave: (modelId: string, settings: Partial<ModelSettings>) => void
}

const DEFAULT_MAX_OUTPUT = 16384

export function ModelSettingsDialog({
  open,
  onOpenChange,
  model,
  providerId,
  onSave,
}: ModelSettingsDialogProps) {
  const t = useTranslations("providers")

  // Derive initial settings from model
  const initialSettings = useMemo<ModelSettings>(() => {
    if (model) {
      return {
        contextWindow: model.contextLength || 128000,
        maxOutputTokens: model.maxOutputTokens || 4096,
        inputPricePer1M: model.pricing?.promptPer1M || 0,
        outputPricePer1M: model.pricing?.completionPer1M || 0,
        capabilities: {
          vision: model.supportsVision || false,
          tools: model.supportsTools || false,
          imageGeneration: model.supportsImageGeneration || false,
          embedding: model.supportsEmbedding || false,
          reranking: false,
          video: false,
        },
      }
    }
    return {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputPricePer1M: 2.5,
      outputPricePer1M: 10.0,
      capabilities: {
        vision: false,
        tools: false,
        imageGeneration: false,
        embedding: false,
        reranking: false,
        video: false,
      },
    }
  }, [model])

  const [settings, setSettings] = useState<ModelSettings>(initialSettings)
  const [isFetchingPricing, setIsFetchingPricing] = useState(false)

  // Reset settings when model changes
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen && model) {
      setSettings(initialSettings)
    }
    onOpenChange(isOpen)
  }

  const handleCapabilityChange = (key: keyof ModelSettings["capabilities"], value: boolean) => {
    setSettings((prev) => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [key]: value,
      },
    }))
  }

  const handleFetchPricing = async () => {
    setIsFetchingPricing(true)
    // Simulate API fetch - in real implementation, fetch from provider API
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setIsFetchingPricing(false)
  }

  const handleSave = () => {
    if (model) {
      onSave(model.id, settings)
      onOpenChange(false)
    }
  }

  if (!model) return null

  const capabilities = [
    {
      key: "vision" as const,
      label: t("capabilityVision") || "Vision",
      icon: Eye,
      enabled: settings.capabilities.vision,
    },
    {
      key: "tools" as const,
      label: t("capabilityTools") || "Tools",
      icon: Wrench,
      enabled: settings.capabilities.tools,
    },
    {
      key: "imageGeneration" as const,
      label: t("capabilityImageGen") || "Image Generation",
      icon: Image,
      enabled: settings.capabilities.imageGeneration,
    },
    {
      key: "embedding" as const,
      label: t("capabilityEmbedding") || "Embedding",
      icon: Database,
      enabled: settings.capabilities.embedding,
    },
    {
      key: "reranking" as const,
      label: t("capabilityReranking") || "Reranking",
      icon: ArrowUpDown,
      enabled: settings.capabilities.reranking,
    },
    {
      key: "video" as const,
      label: t("capabilityVideo") || "Video",
      icon: Video,
      enabled: settings.capabilities.video,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-semibold">
              {t("modelSettings") || "Model Settings"}
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Model Info Header */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <ProviderIcon providerId={providerId} size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{model.name}</div>
            <div className="text-xs text-muted-foreground">
              {providerId} • {formatContextLength(settings.contextWindow)} context
            </div>
          </div>
        </div>

        {/* Capabilities Grid */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t("capabilities") || "Capabilities"}</Label>
          <div className="grid grid-cols-2 gap-2">
            {capabilities.map((cap) => {
              const Icon = cap.icon
              return (
                <div
                  key={cap.key}
                  className={cn(
                    "flex items-center justify-between p-2.5 rounded-lg border transition-colors",
                    cap.enabled ? "bg-primary/5 border-primary/30" : "bg-muted/30"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{cap.label}</span>
                  </div>
                  <Switch
                    checked={cap.enabled}
                    onCheckedChange={(checked) => handleCapabilityChange(cap.key, checked)}
                    className="scale-90"
                  />
                </div>
              )
            })}
          </div>
        </div>

        <Separator />

        {/* Context Window */}
        <div className="space-y-2">
          <Label htmlFor="context-window" className="text-sm font-medium">
            {t("contextWindow") || "Context Window"}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="context-window"
              type="number"
              value={settings.contextWindow}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  contextWindow: parseInt(e.target.value) || 0,
                }))
              }
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">tokens</span>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-xs text-muted-foreground flex items-center gap-1 cursor-help">
                  <Info className="h-3 w-3" />
                  {t("contextWindowHint") || "Recommended: 32000 tokens for optimal performance"}
                </p>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs text-xs">
                  Larger context windows allow more conversation history but may increase costs and
                  latency.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Max Output Tokens */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="max-output" className="text-sm font-medium">
              {t("maxOutputTokens") || "Max Output Tokens"}
            </Label>
            <span className="text-xs text-muted-foreground">
              Max: {DEFAULT_MAX_OUTPUT.toLocaleString()}
            </span>
          </div>
          <Input
            id="max-output"
            type="number"
            value={settings.maxOutputTokens}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                maxOutputTokens: Math.min(parseInt(e.target.value) || 0, DEFAULT_MAX_OUTPUT),
              }))
            }
          />
          <Slider
            value={[settings.maxOutputTokens]}
            onValueChange={([value]) =>
              setSettings((prev) => ({ ...prev, maxOutputTokens: value }))
            }
            max={DEFAULT_MAX_OUTPUT}
            min={256}
            step={256}
            className="mt-2"
          />
        </div>

        <Separator />

        {/* Pricing */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">
              {t("pricingPer1M") || "Pricing (per 1M tokens)"}
            </Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleFetchPricing}
              disabled={isFetchingPricing}
            >
              <RefreshCw className={cn("h-3 w-3", isFetchingPricing && "animate-spin")} />
              {t("fetchPricing") || "Fetch"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="input-price" className="text-xs text-muted-foreground">
                {t("inputPrice") || "Input"}
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="input-price"
                  type="number"
                  step="0.01"
                  value={settings.inputPricePer1M}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      inputPricePer1M: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="pl-7"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="output-price" className="text-xs text-muted-foreground">
                {t("outputPrice") || "Output"}
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="output-price"
                  type="number"
                  step="0.01"
                  value={settings.outputPricePer1M}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      outputPricePer1M: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="pl-7"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel") || "Cancel"}
          </Button>
          <Button onClick={handleSave}>{t("saveChanges") || "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${(length / 1000000).toFixed(1)}M`
  }
  return `${Math.round(length / 1000)}K`
}

export default ModelSettingsDialog
