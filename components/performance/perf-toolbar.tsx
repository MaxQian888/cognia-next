"use client"

/**
 * PerfToolbar — pause/resume, sampling-interval select, and reset-hotspots
 * controls for the performance panel header.
 */

import { useTranslations } from "next-intl"
import { DownloadIcon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PERF_INTERVAL_OPTIONS } from "@/hooks/perf/use-perf-stream"
import type { PerfExportFormat } from "@/lib/perf/backend/export"

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

  return (
    <div className="flex items-center gap-2" data-testid="perf-toolbar">
      <Button
        variant="outline"
        size="sm"
        onClick={onTogglePause}
        data-testid="perf-toggle-pause"
        aria-pressed={paused}
      >
        {paused ? <PlayIcon className="mr-1 size-4" /> : <PauseIcon className="mr-1 size-4" />}
        {paused ? t("resume") : t("pause")}
      </Button>

      <Select value={String(intervalMs)} onValueChange={(v) => onIntervalChange(Number(v))}>
        <SelectTrigger className="h-8 w-[130px]" data-testid="perf-interval-trigger">
          <SelectValue aria-label={t("intervalLabel")} />
        </SelectTrigger>
        <SelectContent align="end">
          {PERF_INTERVAL_OPTIONS.map((ms) => (
            <SelectItem key={ms} value={String(ms)}>
              {t("intervalValue", { seconds: ms / 1000 })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="outline" size="sm" onClick={onReset} data-testid="perf-reset">
        <RotateCcwIcon className="mr-1 size-4" />
        {t("reset")}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" data-testid="perf-export-trigger">
            <DownloadIcon className="mr-1 size-4" />
            {t("export.label")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
