"use client"

/**
 * Status-bar network segment: live download / upload speed and the round
 * trip to the endpoint the app talks to — `↓ 1.2 MB/s ↑ 48 KB/s · 182 ms`.
 *
 * The chip stays one quiet line; the popover carries what it abbreviates:
 * both rates with a minute of sparkline, the latency with where it was
 * measured to, through which route (direct, or which proxy), what opening
 * the connection cost, and the spread over the last few minutes (average,
 * best / worst, jitter, failed probes), plus the interfaces being counted.
 *
 * Measurement lives in `useNetworkMeter` (`lib/network/net-meter.ts` for the
 * what and why). Desktop-only — the catalog drops it off the Tauri shell —
 * and it renders nothing until the first counter read lands, so a machine
 * whose counters cannot be read shows no dead chip.
 */

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, Settings2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { PerfSparkline } from "@/components/performance/perf-sparkline"
import { useNetworkMeter } from "@/hooks/use-network-meter"
import { usePlatform } from "@/hooks/use-platform"
import { formatBytesPerSec } from "@/lib/perf/backend/format"
import {
  latencyQuality,
  summarizeLatency,
  type LatencyQuality,
  type LatencySample,
} from "@/lib/network/net-meter"
import { cn } from "@/lib/utils"
import { useUIStore } from "@/stores/ui/ui-store"

const QUALITY_DOT: Record<LatencyQuality, string> = {
  good: "bg-emerald-500",
  fair: "bg-amber-500",
  poor: "bg-orange-500",
  down: "bg-destructive",
}

/** Whole milliseconds — a status bar has no use for fractions of one. */
function ms(value: number): string {
  return `${Math.round(value)} ms`
}

export function StatusBarNetwork() {
  const t = useTranslations("desktop.statusBar.network")
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const desktop = usePlatform() === "tauri"
  const meter = useNetworkMeter({ enabled: desktop })

  if (!desktop || !meter.available) return null

  const { throughput, latency, latencyHistory, target } = meter
  const down = throughput ? formatBytesPerSec(throughput.rxBps) : "—"
  const up = throughput ? formatBytesPerSec(throughput.txBps) : "—"
  const quality = latencyQuality(latency)
  const latencyText = latencyLabel(latency, t)
  const summary = summarizeLatency(latencyHistory)
  const label = t("label", { down, up, latency: latencyText })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-network"
          aria-label={label}
          title={label}
          className="flex h-6 shrink-0 items-center gap-1.5 px-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex items-center gap-0.5 tabular-nums">
            <ArrowDownIcon aria-hidden className="size-2.5" />
            {down}
          </span>
          <span className="flex items-center gap-0.5 tabular-nums">
            <ArrowUpIcon aria-hidden className="size-2.5" />
            {up}
          </span>
          {target ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <span
                className="flex items-center gap-1 tabular-nums"
                data-testid="status-network-latency"
              >
                <span
                  aria-hidden
                  data-quality={quality ?? "pending"}
                  className={cn(
                    "size-1.5 rounded-full",
                    quality ? QUALITY_DOT[quality] : "bg-muted-foreground/40"
                  )}
                />
                {latencyText}
              </span>
            </>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-72 space-y-3 p-3 text-xs">
        <p className="font-medium">{t("title")}</p>

        <div className="space-y-2" data-testid="status-network-throughput">
          <RateRow label={t("download")} value={down} points={meter.rxHistory} />
          <RateRow label={t("upload")} value={up} points={meter.txHistory} />
          {meter.interfaces.length > 0 ? (
            <p className="truncate text-muted-foreground" data-testid="status-network-interfaces">
              {t("interfaces", { names: meter.interfaces.map((i) => i.name).join(", ") })}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5 border-t pt-3" data-testid="status-network-latency-details">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("latency")}</span>
            <span className="font-medium tabular-nums">{latencyText}</span>
          </div>
          {target ? (
            <p className="truncate text-muted-foreground" title={target.url}>
              {target.kind === "provider"
                ? t("targetProvider", { host: hostOf(target.url), provider: target.providerId })
                : t("targetRelay", { host: hostOf(target.url) })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("noTarget")}</p>
          )}
          {latency?.route ? (
            <p className="text-muted-foreground" data-testid="status-network-route">
              {latency.route.kind === "proxy"
                ? t("routeProxy", { proxy: `${latency.route.host}:${latency.route.port}` })
                : t("routeDirect")}
            </p>
          ) : null}
          {latency?.connectMs != null ? (
            <Figure label={t("connect")} value={ms(latency.connectMs)} />
          ) : null}
          {summary ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1" data-testid="status-network-summary">
              <Figure label={t("average")} value={ms(summary.avgMs)} />
              <Figure label={t("jitter")} value={ms(summary.jitterMs)} />
              <Figure label={t("best")} value={ms(summary.minMs)} />
              <Figure label={t("worst")} value={ms(summary.maxMs)} />
              <Figure label={t("loss")} value={`${Math.round(summary.lossRatio * 100)}%`} />
              <Figure label={t("samples")} value={String(latencyHistory.length)} />
            </div>
          ) : null}
          {latency && !latency.ok && latency.error ? (
            <p className="break-words text-destructive" data-testid="status-network-error">
              {latency.error}
            </p>
          ) : null}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5"
          data-testid="status-network-settings"
          onClick={() => requestOpenSettings("network")}
        >
          <Settings2Icon aria-hidden className="size-3.5" />
          {t("settings")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function latencyLabel(sample: LatencySample | null, t: (key: string) => string): string {
  if (!sample) return t("measuring")
  if (!sample.ok || sample.latencyMs == null) return t("unreachable")
  return ms(sample.latencyMs)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function RateRow({
  label,
  value,
  points,
}: {
  label: string
  value: string
  points: readonly (number | null)[]
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <PerfSparkline points={points} color="currentColor" className="h-5 min-w-0 flex-1" />
      <span className="w-20 shrink-0 text-right font-medium tabular-nums">{value}</span>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}
