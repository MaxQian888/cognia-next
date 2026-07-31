"use client"

import { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Check, X, BarChart3, Cpu } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { ProviderConfig } from "@cognia/provider-types/provider"

interface CompareProvider {
  id: string
  name: string
  modelCount: number
  maxContextWindow: number
  protocol: string
  type: "cloud" | "local"
  capabilities: {
    tools: boolean
    vision: boolean
    streaming: boolean
    reasoning: boolean
    audio: boolean
  }
}

function getProviderCompareData(id: string): CompareProvider | null {
  const cfg: ProviderConfig | undefined = PROVIDERS[id]
  if (!cfg) return null

  const maxContext = Math.max(...cfg.models.map((m) => m.contextLength ?? 0), 0)
  const tools = cfg.models.some((m) => m.supportsTools)
  const vision = cfg.models.some((m) => m.supportsVision)
  const streaming = cfg.models.some((m) => m.supportsStreaming)
  const reasoning = cfg.models.some((m) => m.supportsReasoning)
  const audio = cfg.models.some((m) => m.supportsAudio)

  const protocol = cfg.protocol ?? "openai"
  const type: "cloud" | "local" = cfg.category === "local" ? "local" : "cloud"

  return {
    id,
    name: cfg.name,
    modelCount: cfg.models.length,
    maxContextWindow: maxContext,
    protocol,
    type,
    capabilities: { tools, vision, streaming, reasoning, audio },
  }
}

interface ProviderCompareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableProviders: Array<{ id: string; name: string }>
  initialSelectedProviderIds?: string[]
  onSelectedProviderIdsChange?: (ids: string[]) => void
}

const MAX_COMPARE = 4
const EMPTY_PROVIDER_SELECTION: string[] = []

function CapabilityCell({ has }: { has: boolean }) {
  return has ? (
    <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
  ) : (
    <X className="h-4 w-4 text-muted-foreground/30" />
  )
}

function formatContextLength(len: number): string {
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M`
  if (len >= 1_000) return `${Math.round(len / 1_000)}K`
  return String(len)
}

export function ProviderCompareDialog({
  open,
  onOpenChange,
  availableProviders,
  initialSelectedProviderIds = EMPTY_PROVIDER_SELECTION,
  onSelectedProviderIdsChange,
}: ProviderCompareDialogProps) {
  const t = useTranslations("providers")
  const [selected, setSelected] = useState<string[]>(() => {
    const availableIds = new Set(availableProviders.map((provider) => provider.id))
    return initialSelectedProviderIds
      .filter((providerId) => availableIds.has(providerId))
      .slice(0, MAX_COMPARE)
  })

  const compareData = useMemo(
    () => selected.map((id) => getProviderCompareData(id)).filter(Boolean) as CompareProvider[],
    [selected]
  )

  const toggleProvider = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id)
        ? prev.filter((p) => p !== id)
        : prev.length < MAX_COMPARE
          ? [...prev, id]
          : prev
      if (next !== prev) onSelectedProviderIdsChange?.(next)
      return next
    })
  }

  const columns = Math.min(compareData.length, MAX_COMPARE)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            {t("comparison.title") || "Model Comparison"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("comparison.selectModels") || "Select up to 4 providers to compare"}
          </DialogDescription>
        </DialogHeader>

        {/* Provider selection */}
        <div className="space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">
            {t("compareSelectedCount", { count: selected.length, max: MAX_COMPARE })}
          </Label>
          <ScrollArea className="max-h-32">
            <div className="flex flex-wrap gap-1.5">
              {availableProviders.map((p) => {
                const isSelected = selected.includes(p.id)
                const isDisabled = !isSelected && selected.length >= MAX_COMPARE
                return (
                  <label
                    key={p.id}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors cursor-pointer",
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "hover:bg-muted/50",
                      isDisabled && "opacity-40 cursor-not-allowed"
                    )}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleProvider(p.id)}
                      disabled={isDisabled}
                      className="h-3 w-3"
                    />
                    {p.name}
                  </label>
                )
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Comparison table */}
        {compareData.length > 0 && (
          <ScrollArea className="max-h-[400px]">
            <div
              className="grid gap-0"
              style={{
                gridTemplateColumns: `minmax(120px, auto) repeat(${columns}, minmax(140px, 1fr))`,
              }}
            >
              {/* Header row */}
              <div className="border-b p-2" />
              {compareData.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col items-center justify-center border-b border-l p-3 text-center"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="mt-1 text-xs font-medium">{p.name}</span>
                </div>
              ))}

              {/* Model count */}
              <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                {t("compareModels")}
              </div>
              {compareData.map((p) => (
                <div key={p.id} className="border-b border-l p-2 text-center text-sm tabular-nums">
                  {p.modelCount}
                </div>
              ))}

              {/* Context window */}
              <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                {t("comparison.contextWindow") || "Context"}
              </div>
              {compareData.map((p) => (
                <div key={p.id} className="border-b border-l p-2 text-center text-sm tabular-nums">
                  {p.maxContextWindow > 0 ? formatContextLength(p.maxContextWindow) : "—"}
                </div>
              ))}

              {/* Protocol */}
              <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                {t("compareProtocol")}
              </div>
              {compareData.map((p) => (
                <div key={p.id} className="border-b border-l p-2 text-center">
                  <Badge variant="secondary" className="text-[10px]">
                    {p.protocol}
                  </Badge>
                </div>
              ))}

              {/* Type */}
              <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                {t("compareType")}
              </div>
              {compareData.map((p) => (
                <div key={p.id} className="border-b border-l p-2 text-center">
                  <Badge
                    variant={p.type === "local" ? "outline" : "default"}
                    className={cn(
                      "text-[10px]",
                      p.type === "local" &&
                        "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
                    )}
                  >
                    {p.type}
                  </Badge>
                </div>
              ))}

              {/* Capabilities header */}
              <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                {t("context") || "Capabilities"}
              </div>
              {compareData.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-center gap-2 border-b border-l p-2"
                >
                  <CapabilityCell has={p.capabilities.tools} />
                  <CapabilityCell has={p.capabilities.vision} />
                  <CapabilityCell has={p.capabilities.streaming} />
                  <CapabilityCell has={p.capabilities.reasoning} />
                  <CapabilityCell has={p.capabilities.audio} />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {compareData.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Cpu className="mb-2 h-10 w-10 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">
              {t("comparison.emptyDescription") || "Select providers above to compare"}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
