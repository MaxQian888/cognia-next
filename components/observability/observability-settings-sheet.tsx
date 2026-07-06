"use client"

/**
 * Dashboard settings drawer (gear button in the toolbar). Four sections:
 *   - Defaults: default time range + auto-refresh cadence
 *   - Thresholds: per-metric warn/crit overrides for stat + time-series coloring
 *   - Panels: show/hide individual panels
 *   - Data: stored-span count, retention prune, and clear-all
 *
 * Config lives in the persisted observability store (via `useObservabilityControls`);
 * data operations go straight to the Dexie agent-traces layer.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RotateCcwIcon, Trash2Icon } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { RefreshSelect } from "./refresh-select"
import { PANELS } from "./panel-registry"
import { useObservabilityControls } from "@/hooks/observability/use-observability-controls"
import { useClientLiveQuery } from "@/hooks/data"
import { countAllSpans, pruneOlderThan, clearAllSpans } from "@/lib/db/agent-traces"
import { mergeThresholds, type ThresholdMetric } from "@/lib/observability/thresholds"
import { RANGE_PRESETS, type RangePreset } from "@/lib/observability/time-range"

const THRESHOLD_METRICS: { metric: ThresholdMetric; unitKey: string }[] = [
  { metric: "errorRate", unitKey: "unitFraction" },
  { metric: "latencyP95", unitKey: "unitMs" },
  { metric: "cost", unitKey: "unitUsd" },
  { metric: "cacheHitRate", unitKey: "unitFraction" },
]

const PRUNE_DAYS = [7, 30, 90] as const
const DAY_MS = 86_400_000

export interface ObservabilitySettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ObservabilitySettingsSheet({
  open,
  onOpenChange,
}: ObservabilitySettingsSheetProps) {
  const t = useTranslations("observability.settings")
  const tObs = useTranslations("observability")
  const controls = useObservabilityControls()
  const merged = mergeThresholds(controls.thresholds)
  const count = useClientLiveQuery<number>(() => countAllSpans(), [], 0) ?? 0
  const [pruneDays, setPruneDays] = useState<number>(30)

  const setBound = (metric: ThresholdMetric, bound: "warn" | "crit", raw: number) => {
    if (!Number.isFinite(raw)) return
    const cur = merged[metric]
    controls.setThreshold(metric, { warn: cur.warn, crit: cur.crit, [bound]: raw })
  }

  const handlePrune = async () => {
    const removed = await pruneOlderThan(Date.now() - pruneDays * DAY_MS)
    toast.success(t("pruneDone", { count: removed }))
  }

  const handleClear = async () => {
    const removed = await clearAllSpans()
    toast.success(t("cleared", { count: removed }))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-4" data-testid="observability-settings">
            {/* Defaults */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{t("defaults.title")}</h3>
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">{t("defaults.range")}</Label>
                <Select
                  value={controls.rangePreset === "custom" ? "1h" : controls.rangePreset}
                  onValueChange={(v) => controls.setRangePreset(v as RangePreset)}
                >
                  <SelectTrigger size="sm" className="w-[140px]" data-testid="settings-range">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RANGE_PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {tObs(`range.presets.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">{t("defaults.refresh")}</Label>
                <RefreshSelect value={controls.refreshMs} onChange={controls.setRefreshMs} />
              </div>
            </section>

            <Separator />

            {/* Thresholds */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">{t("thresholds.title")}</h3>
                  <p className="text-xs text-muted-foreground">{t("thresholds.description")}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={controls.resetThresholds}
                  data-testid="thresholds-reset"
                >
                  <RotateCcwIcon className="size-3.5" />
                  {t("thresholds.reset")}
                </Button>
              </div>
              <div className="space-y-3">
                {THRESHOLD_METRICS.map(({ metric, unitKey }) => (
                  <div key={metric} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium">{t(`metrics.${metric}`)}</Label>
                      <span className="text-[10px] text-muted-foreground">{t(unitKey)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label
                          htmlFor={`th-${metric}-warn`}
                          className="text-[10px] text-warning uppercase tracking-wide"
                        >
                          {t("thresholds.warn")}
                        </Label>
                        <Input
                          id={`th-${metric}-warn`}
                          type="number"
                          value={merged[metric].warn}
                          onChange={(e) => setBound(metric, "warn", e.target.valueAsNumber)}
                          className="h-8 text-xs"
                          data-testid={`threshold-${metric}-warn`}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor={`th-${metric}-crit`}
                          className="text-[10px] text-destructive uppercase tracking-wide"
                        >
                          {t("thresholds.crit")}
                        </Label>
                        <Input
                          id={`th-${metric}-crit`}
                          type="number"
                          value={merged[metric].crit}
                          onChange={(e) => setBound(metric, "crit", e.target.valueAsNumber)}
                          className="h-8 text-xs"
                          data-testid={`threshold-${metric}-crit`}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <Separator />

            {/* Panels */}
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">{t("panels.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("panels.description")}</p>
              </div>
              <div className="space-y-2">
                {PANELS.map((p) => {
                  const visible = !controls.hiddenPanels.includes(p.id)
                  return (
                    <div key={p.id} className="flex items-center justify-between gap-3">
                      <Label htmlFor={`panel-vis-${p.id}`} className="truncate text-xs">
                        {tObs(`panels.${p.titleKey}`)}
                      </Label>
                      <Switch
                        id={`panel-vis-${p.id}`}
                        checked={visible}
                        onCheckedChange={() => controls.togglePanelVisibility(p.id)}
                        data-testid={`panel-visibility-${p.id}`}
                      />
                    </div>
                  )
                })}
              </div>
            </section>

            <Separator />

            {/* Data */}
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">{t("data.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("data.stored", { count })}</p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={String(pruneDays)} onValueChange={(v) => setPruneDays(Number(v))}>
                  <SelectTrigger size="sm" className="w-[130px]" data-testid="prune-age">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRUNE_DAYS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t("data.olderThan", { days: d })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrune}
                  data-testid="prune-button"
                >
                  {t("data.prune")}
                </Button>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-1.5"
                    data-testid="clear-all"
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("data.clearAll")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("data.clearConfirmTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>{t("data.clearConfirmBody")}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("data.clearCancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClear} data-testid="clear-all-confirm">
                      {t("data.clearConfirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
