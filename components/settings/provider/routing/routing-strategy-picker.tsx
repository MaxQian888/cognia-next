"use client"

// Global routing strategy picker + the two routing-config numbers worth
// exposing (request timeout / max fallback attempts).

import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEFAULT_ROUTING_CONFIG } from "@/types/provider/model-mapping"
import type { RoutingStrategy } from "@/types/provider/auto-router"

const STRATEGIES: RoutingStrategy[] = ["quality", "cost", "speed", "balanced", "adaptive"]

export function RoutingStrategyPicker() {
  const t = useTranslations("providers.routingView")
  const routingConfig = useSettingsStore((s) => s.settings?.routingConfig) ?? DEFAULT_ROUTING_CONFIG
  const setRoutingConfig = useSettingsStore((s) => s.setRoutingConfig)

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("strategyLabel")}</Label>
        <Select
          value={routingConfig.strategy}
          onValueChange={(v) => void setRoutingConfig({ strategy: v as RoutingStrategy })}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("strategyLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STRATEGIES.map((s) => (
              <SelectItem key={s} value={s} textValue={t(`strategy.${s}`)}>
                <div className="flex flex-col items-start">
                  <span className="text-xs font-medium">{t(`strategy.${s}`)}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t(`strategyExplain.${s}`)}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {t(`strategyExplain.${routingConfig.strategy}`)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="routing-timeout">
            {t("timeoutMs")}
          </Label>
          <Input
            id="routing-timeout"
            type="number"
            min={1000}
            step={1000}
            value={routingConfig.requestTimeoutMs}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n > 0) void setRoutingConfig({ requestTimeoutMs: n })
            }}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="routing-max-fallbacks">
            {t("maxFallbackAttempts")}
          </Label>
          <Input
            id="routing-max-fallbacks"
            type="number"
            min={0}
            max={10}
            value={routingConfig.maxFallbackAttempts}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= 0) void setRoutingConfig({ maxFallbackAttempts: n })
            }}
            className="h-8 text-xs"
          />
        </div>
      </div>
    </div>
  )
}

export default RoutingStrategyPicker
