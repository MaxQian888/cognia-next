"use client"

// Reliability section: PERSISTED circuit-breaker settings (global enable,
// absolute vs failure-rate trip mode, cooldown clamps) + a read-only view of
// the active pre-call filter chain. Settings live on
// AppSettings.routingConfig.circuitBreaker and are hydrated into the
// in-memory breaker store by `applyCircuitBreakerSettings` on every send.

import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEFAULT_FILTER_CHAIN, listDeploymentFilters } from "@/lib/ai/routing/filter-registry"
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_MAX_COOLDOWN_MS,
  DEFAULT_MIN_REQUEST_VOLUME,
} from "@/types/provider/circuit-breaker"
import { DEFAULT_ROUTING_CONFIG } from "@/types/provider/model-mapping"
import type { RoutingCircuitBreakerSettings } from "@/types/provider/model-mapping"

export function ReliabilitySection() {
  const t = useTranslations("providers.routingView.reliability")
  const routingConfig = useSettingsStore((s) => s.settings?.routingConfig) ?? DEFAULT_ROUTING_CONFIG
  const setRoutingConfig = useSettingsStore((s) => s.setRoutingConfig)

  const cb: RoutingCircuitBreakerSettings = routingConfig.circuitBreaker ?? { enabled: false }
  const rateMode = cb.failureRateThreshold !== undefined

  const patchBreaker = (patch: Partial<RoutingCircuitBreakerSettings>) =>
    void setRoutingConfig({ circuitBreaker: { ...cb, ...patch } })

  const setMode = (mode: string) => {
    if (mode === "failure-rate") {
      patchBreaker({
        failureRateThreshold: cb.failureRateThreshold ?? 0.5,
        minRequestVolume: cb.minRequestVolume ?? DEFAULT_MIN_REQUEST_VOLUME,
      })
    } else {
      // Rebuild WITHOUT the rate fields — their absence selects absolute mode.
      const next = { ...cb }
      delete next.failureRateThreshold
      delete next.minRequestVolume
      void setRoutingConfig({ circuitBreaker: next })
    }
  }

  const numberInput = (
    id: string,
    label: string,
    value: number,
    onValid: (n: number) => void,
    opts: { min?: number; max?: number; step?: number } = {}
  ) => (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={opts.min}
        max={opts.max}
        step={opts.step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= (opts.min ?? 0)) onValid(n)
        }}
        className="h-8 text-xs"
      />
    </div>
  )

  const chain = routingConfig.filterChain ?? [...DEFAULT_FILTER_CHAIN]
  const known = new Map(listDeploymentFilters().map((f) => [f.id, f]))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-xs" htmlFor="breaker-enabled">
            {t("breakerEnabled")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("breakerEnabledDesc")}</p>
        </div>
        <Switch
          id="breaker-enabled"
          checked={cb.enabled}
          onCheckedChange={(checked) => patchBreaker({ enabled: checked })}
          aria-label={t("breakerEnabled")}
        />
      </div>

      {cb.enabled ? (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("mode")}</Label>
            <Select value={rateMode ? "failure-rate" : "absolute"} onValueChange={setMode}>
              <SelectTrigger className="h-8 text-xs" aria-label={t("mode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="absolute" textValue={t("modeAbsolute")}>
                  <div className="flex flex-col items-start">
                    <span className="text-xs font-medium">{t("modeAbsolute")}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t("modeAbsoluteDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="failure-rate" textValue={t("modeFailureRate")}>
                  <div className="flex flex-col items-start">
                    <span className="text-xs font-medium">{t("modeFailureRate")}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t("modeFailureRateDesc")}
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {numberInput(
              "breaker-failure-threshold",
              t("failureThreshold"),
              cb.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
              (n) => patchBreaker({ failureThreshold: n }),
              { min: 1 }
            )}
            {numberInput(
              "breaker-cooldown",
              t("cooldownMs"),
              cb.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs,
              (n) => patchBreaker({ cooldownMs: n }),
              { min: 1000, step: 1000 }
            )}
            {rateMode ? (
              <>
                {numberInput(
                  "breaker-rate-pct",
                  t("failureRatePct"),
                  Math.round((cb.failureRateThreshold ?? 0.5) * 100),
                  (n) => patchBreaker({ failureRateThreshold: Math.min(n, 100) / 100 }),
                  { min: 1, max: 100 }
                )}
                {numberInput(
                  "breaker-min-volume",
                  t("minRequestVolume"),
                  cb.minRequestVolume ?? DEFAULT_MIN_REQUEST_VOLUME,
                  (n) => patchBreaker({ minRequestVolume: n }),
                  { min: 1 }
                )}
              </>
            ) : null}
            {numberInput(
              "breaker-max-cooldown",
              t("maxCooldownMs"),
              cb.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS,
              (n) => patchBreaker({ maxCooldownMs: n }),
              { min: 1000, step: 1000 }
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("retryAfterNote")}</p>
        </>
      ) : null}

      <div className="space-y-1.5">
        <Label className="text-xs">{t("filterChainTitle")}</Label>
        <p className="text-[11px] text-muted-foreground">{t("filterChainDesc")}</p>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-chain">
          {chain.map((id, i) => {
            const meta = known.get(id)
            return (
              <span key={id} className="flex items-center gap-1.5">
                {i > 0 ? <span className="text-[10px] text-muted-foreground">→</span> : null}
                <Badge
                  variant={meta ? (meta.builtIn ? "secondary" : "outline") : "destructive"}
                  className="text-[10px]"
                >
                  {meta?.label ?? id}
                  {meta && !meta.builtIn ? (
                    <span className="ml-1 opacity-70">{t("pluginBadge")}</span>
                  ) : null}
                </Badge>
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ReliabilitySection
