"use client"

/**
 * Toolbar export/import menu:
 *   - Recent traces → CSV
 *   - Dashboard config (layout + thresholds + filters) → JSON
 *   - Import a dashboard config JSON
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
import {
  DropdownMenu,
  DropdownMenuContent,
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
}

export function ExportMenu({ traces, buildConfig, onImportConfig }: ExportMenuProps) {
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

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFilePicked}
        data-testid="import-file-input"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" data-testid="export-menu">
            <DownloadIcon className="size-3.5" />
            {t("label")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={exportCsv} data-testid="export-traces-csv">
            <SheetIcon className="size-4" />
            {t("tracesCsv")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportJson} data-testid="export-dashboard-json">
            <FileJsonIcon className="size-4" />
            {t("dashboardJson")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => fileRef.current?.click()} data-testid="import-dashboard">
            <UploadIcon className="size-4" />
            {t("importDashboard")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
