"use client"

/**
 * PerfToolbar — pause/resume, sampling-interval select, clear-graphs and
 * export controls for the performance panel header, plus `PerfLiveStatus`,
 * the header's one-glance "is this live?" indicator.
 *
 * "Clear graphs" was labelled "Reset hotspots", but it only ever reset the
 * panel's own rolling history: the host's span registry is cumulative and
 * process-wide. Resetting that now lives on the hotspot table itself, behind a
 * confirmation, where its effect is visible.
 *
 * It sits in the page header's `actions` slot, which does not shrink. Four
 * labelled controls there were ~420px, so on a phone they pushed the title out
 * and slid over the live status ("● L"). Below the header's `@2xl` the labels
 * fold away (the same breakpoint the header's own actions fold at), each
 * button keeps its name as `aria-label` and a tooltip, and the row stays one
 * line instead of wrapping.
 */

/** Visible only once the header is wide enough to hold labelled buttons. */
const LABEL = "hidden @2xl/feature-header:inline"
/** Icon-only square below `@2xl`, a labelled button above it. */
const FOLDING_BUTTON = "size-8 px-0 @2xl/feature-header:w-auto @2xl/feature-header:px-3"

import { useTranslations } from "next-intl"
import { CircleDotIcon, DownloadIcon, EraserIcon, PauseIcon, PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PERF_INTERVAL_OPTIONS } from "@/hooks/perf/use-perf-stream"
import type { PerfExportFormat } from "@/lib/perf/backend/export"
import { cn } from "@/lib/utils"

export interface PerfToolbarProps {
  paused: boolean
  intervalMs: number
  onTogglePause: () => void
  onIntervalChange: (ms: number) => void
  onReset: () => void
  onExport: (format: PerfExportFormat) => void
}

export function PerfToolbar({
  paused,
  intervalMs,
  onTogglePause,
  onIntervalChange,
  onReset,
  onExport,
}: PerfToolbarProps) {
  const t = useTranslations("performance.toolbar")
  const tStatus = useTranslations("performance.toolbar.status")

  return (
    <div className="flex items-center justify-end gap-1.5" data-testid="perf-toolbar">
      {/* The header drops its `status` slot below `@md`, which took
          `PerfLiveStatus` with it: on a phone nothing said whether the graphs
          were live or frozen. This dot stands in for it there. */}
      <span
        role="status"
        aria-label={paused ? tStatus("paused") : tStatus("live", { seconds: intervalMs / 1000 })}
        title={paused ? tStatus("paused") : tStatus("live", { seconds: intervalMs / 1000 })}
        className="flex size-6 items-center justify-center @md/feature-header:hidden"
        data-state={paused ? "paused" : "live"}
        data-testid="perf-toolbar-live-dot"
      >
        <span
          aria-hidden
          className={cn("size-2 rounded-full", paused ? "bg-warning" : "animate-pulse bg-success")}
        />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onTogglePause}
            data-testid="perf-toggle-pause"
            aria-pressed={paused}
            aria-label={paused ? t("resume") : t("pause")}
            className={FOLDING_BUTTON}
          >
            {paused ? (
              <PlayIcon className="size-4 @2xl/feature-header:mr-1" />
            ) : (
              <PauseIcon className="size-4 @2xl/feature-header:mr-1" />
            )}
            <span className={LABEL}>{paused ? t("resume") : t("pause")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{paused ? t("resume") : t("pause")}</TooltipContent>
      </Tooltip>

      <Select value={String(intervalMs)} onValueChange={(v) => onIntervalChange(Number(v))}>
        {/* The label belongs on the trigger — it is the combobox. On
            `SelectValue` it is announced as the value, not the control. */}
        <SelectTrigger
          className="h-8 w-auto gap-1 px-2 @2xl/feature-header:w-[130px] @2xl/feature-header:px-3"
          aria-label={t("intervalLabel")}
          data-testid="perf-interval-trigger"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {PERF_INTERVAL_OPTIONS.map((ms) => (
              <SelectItem key={ms} value={String(ms)}>
                {t("intervalValue", { seconds: ms / 1000 })}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            data-testid="perf-reset"
            aria-label={t("reset")}
            className={FOLDING_BUTTON}
          >
            <EraserIcon className="size-4 @2xl/feature-header:mr-1" />
            <span className={LABEL}>{t("reset")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("resetHint")}</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-testid="perf-export-trigger"
            aria-label={t("export.label")}
            title={t("export.label")}
            className={FOLDING_BUTTON}
          >
            <DownloadIcon className="size-4 @2xl/feature-header:mr-1" />
            <span className={LABEL}>{t("export.label")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onExport("json")} data-testid="perf-export-json">
              {t("export.json")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onExport("csv-processes")}
              data-testid="perf-export-processes"
            >
              {t("export.processes")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onExport("csv-hotspots")}
              data-testid="perf-export-hotspots"
            >
              {t("export.hotspots")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export interface PerfLiveStatusProps {
  paused: boolean
  intervalMs: number
  /** An active capture keeps recording regardless of the live view. */
  recording: boolean
  /** Jumps to the Captures tab. */
  onOpenCaptures?: () => void
}

/**
 * Live / paused / recording, in the header next to the title. Pausing froze
 * the graphs with nothing but the button label changing, so a frozen chart
 * read as a quiet process.
 */
export function PerfLiveStatus({
  paused,
  intervalMs,
  recording,
  onOpenCaptures,
}: PerfLiveStatusProps) {
  const t = useTranslations("performance.toolbar.status")
  return (
    <div className="flex items-center gap-1.5" data-testid="perf-live-status">
      <Badge
        variant="outline"
        className={cn(
          "gap-1.5 font-mono text-[11px] tabular-nums",
          paused && "border-warning/50 text-warning"
        )}
        data-state={paused ? "paused" : "live"}
        data-testid="perf-live-status-view"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            paused ? "bg-warning" : "animate-pulse bg-success"
          )}
        />
        {paused ? t("paused") : t("live", { seconds: intervalMs / 1000 })}
      </Badge>
      {recording ? (
        <Badge asChild variant="outline" className="gap-1 border-destructive/40 text-destructive">
          <button type="button" onClick={onOpenCaptures} data-testid="perf-live-status-recording">
            <CircleDotIcon aria-hidden className="size-3 animate-pulse" />
            {t("recording")}
          </button>
        </Badge>
      ) : null}
    </div>
  )
}
