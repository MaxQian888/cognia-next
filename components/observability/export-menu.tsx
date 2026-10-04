"use client"

/**
 * Toolbar export/import control.
 *
 *   Explore     one button, "Export list" — the trace list on screen → CSV
 *   Dashboard   a menu: traces → CSV · dashboard config → JSON · import JSON
 *
 * The dashboard-config entries are grid things (layout, hidden panels,
 * thresholds), so they only appear where the grid is; offering "Import
 * dashboard…" from the trace list imported a layout nobody could see change.
 * And the label says WHAT is exported: the per-trace menu beside the timeline
 * is "Export trace", this one is "Export list" — two buttons both called
 * "Export" on one screen exported different things.
 *
 * `traces` is the caller's choice of rows, and the two sub-views choose
 * differently on purpose: Explore exports the list it shows (search and
 * errors-only applied), the Dashboard exports every trace its panels counted
 * (neither control exists there, so applying them silently would export a
 * subset the user cannot see).
 *
 * File writes go through the shared cross-platform `saveExport` (Tauri /
 * Capacitor / web); import reads the picked file, validates it with
 * `parseDashboardConfig`, and hands a normalized config back to the caller.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, FileJsonIcon, SheetIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { tracesToCsv } from "@/lib/observability/export-csv"
import {
  serializeDashboardConfig,
  parseDashboardConfig,
  type DashboardConfig,
} from "@/lib/observability/dashboard-config"
import { saveExport } from "@/lib/files/save-export"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"

/** Filesystem-safe timestamp for export filenames (event context only). */
function fileStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
}

export interface ExportMenuProps {
  traces: TraceRollupRow[]
  buildConfig: () => DashboardConfig
  onImportConfig: (cfg: DashboardConfig) => void
  /** Offer dashboard-config export/import (the Dashboard sub-view only). */
  showDashboardConfig?: boolean
  /** Icon-only trigger — narrow toolbars only. */
  compact?: boolean
}

export function ExportMenu({
  traces,
  buildConfig,
  onImportConfig,
  showDashboardConfig = false,
  compact = false,
}: ExportMenuProps) {
  const t = useTranslations("observability.export")
  const fileRef = useRef<HTMLInputElement>(null)

  const exportCsv = async () => {
    if (traces.length === 0) {
      toast.info(t("noTraces"))
      return
    }
    const outcome = await saveExport({
      filename: `cognia-traces-${fileStamp()}.csv`,
      data: tracesToCsv(traces),
      mimeType: "text/csv",
    })
    reportOutcome(outcome)
  }

  const exportJson = async () => {
    const outcome = await saveExport({
      filename: `cognia-observability-${fileStamp()}.json`,
      data: serializeDashboardConfig(buildConfig()),
      mimeType: "application/json",
    })
    reportOutcome(outcome)
  }

  const reportOutcome = (outcome: Awaited<ReturnType<typeof saveExport>>) => {
    if (outcome.kind === "saved") toast.success(t("saved", { location: outcome.location }))
    else if (outcome.kind === "error") toast.error(t("saveFailed", { message: outcome.message }))
  }

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    try {
      const cfg = parseDashboardConfig(await file.text())
      if (!cfg) {
        toast.error(t("importFailed"))
        return
      }
      onImportConfig(cfg)
      toast.success(t("imported"))
    } catch {
      toast.error(t("importFailed"))
    }
  }

  if (!showDashboardConfig) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={compact ? "px-2" : "gap-1.5"}
        onClick={() => void exportCsv()}
        data-testid="export-traces-csv"
        aria-label={t("exportList")}
        title={compact ? t("exportList") : undefined}
      >
        <DownloadIcon className="size-3.5" aria-hidden />
        {!compact && t("exportList")}
      </Button>
    )
  }

  return (
    <>
      <Input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFilePicked}
        data-testid="import-file-input"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={compact ? "px-2" : "gap-1.5"}
            data-testid="export-menu"
            aria-label={t("label")}
            title={compact ? t("label") : undefined}
          >
            <DownloadIcon className="size-3.5" aria-hidden />
            {!compact && t("label")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={exportCsv} data-testid="export-traces-csv">
              <SheetIcon className="size-4" />
              {t("tracesCsv")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportJson} data-testid="export-dashboard-json">
              <FileJsonIcon className="size-4" />
              {t("dashboardJson")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => fileRef.current?.click()}
              data-testid="import-dashboard"
            >
              <UploadIcon className="size-4" />
              {t("importDashboard")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
