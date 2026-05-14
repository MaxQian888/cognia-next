"use client"

/**
 * Generic audit-log export dialog. Used by both the GitHub Delivery and the
 * Workflow audit tabs.
 *
 * Inputs:
 *   • title  — dialog heading.
 *   • rows   — already-filtered audit rows. The dialog never re-queries.
 *   • columns — CSV/Markdown column projector. Lets the GitHub vs Workflow
 *               tabs ship different schemas without forking this file.
 *   • filename — base name for the downloaded blob. The dialog appends the
 *               extension (.zip / .md / .json / .csv) per format.
 *
 * Output formats:
 *   • zip  — bundles audit.csv + audit.json + meta.json (filter snapshot).
 *   • md   — single Markdown table.
 *   • csv  — raw CSV (RFC 4180 quoting).
 *   • json — pretty-printed array.
 */

import { useState } from "react"
import { DownloadIcon, Loader2Icon } from "lucide-react"
import JSZip from "jszip"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"

export type AuditExportFormat = "zip" | "md" | "csv" | "json"

export interface AuditExportColumn<TRow> {
  header: string
  accessor: (row: TRow) => string
}

export interface AuditExportDialogProps<TRow> {
  title?: string
  description?: string
  rows: TRow[]
  columns: AuditExportColumn<TRow>[]
  filename: string
  /** Snapshot of filters used to produce `rows`. Serialised into meta.json. */
  filtersSnapshot?: Record<string, unknown>
  /** Override the default trigger button (text-only "Export"). */
  trigger?: React.ReactNode
  /** Test seam — replaces the default click-to-download with a noop callback. */
  onExport?: (format: AuditExportFormat, blob: Blob) => void
}

export function AuditExportDialog<TRow>({
  title = "Export audit log",
  description = "Pick a format. The export only includes rows visible under the current filters.",
  rows,
  columns,
  filename,
  filtersSnapshot,
  trigger,
  onExport,
}: AuditExportDialogProps<TRow>) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<AuditExportFormat>("zip")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleExport = async () => {
    setBusy(true)
    setError(null)
    try {
      const blob = await buildExportBlob(format, rows, columns, filtersSnapshot)
      const extension = format === "zip" ? "zip" : format
      const finalName = `${filename}.${extension}`
      if (onExport) {
        onExport(format, blob)
      } else {
        triggerDownload(blob, finalName)
      }
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" data-testid="audit-export-trigger">
            <DownloadIcon className="h-4 w-4 mr-1.5" /> Export
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3" data-testid="audit-export-dialog">
          <div className="space-y-1.5">
            <Label htmlFor="audit-export-format">Format</Label>
            <Select
              value={format}
              onValueChange={(v) => setFormat(v as AuditExportFormat)}
              disabled={busy}
            >
              <SelectTrigger id="audit-export-format" aria-label="format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zip">ZIP (csv + json + meta)</SelectItem>
                <SelectItem value="md">Markdown table</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "row" : "rows"} will be exported.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            onClick={handleExport}
            disabled={busy || rows.length === 0}
            data-testid="audit-export-confirm"
          >
            {busy && <Loader2Icon className="h-4 w-4 mr-1 animate-spin" />}
            Download {format.toUpperCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Format builders ─────────────────────────────────────────────────────────

export async function buildExportBlob<TRow>(
  format: AuditExportFormat,
  rows: TRow[],
  columns: AuditExportColumn<TRow>[],
  filtersSnapshot?: Record<string, unknown>
): Promise<Blob> {
  if (format === "csv") return new Blob([toCsv(rows, columns)], { type: "text/csv;charset=utf-8" })
  if (format === "md") return new Blob([toMarkdown(rows, columns)], { type: "text/markdown" })
  if (format === "json")
    return new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" })
  // ZIP
  const zip = new JSZip()
  zip.file("audit.csv", toCsv(rows, columns))
  zip.file("audit.json", JSON.stringify(rows, null, 2))
  zip.file(
    "meta.json",
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        rowCount: rows.length,
        columns: columns.map((c) => c.header),
        filters: filtersSnapshot ?? {},
      },
      null,
      2
    )
  )
  return await zip.generateAsync({ type: "blob" })
}

function toCsv<TRow>(rows: TRow[], columns: AuditExportColumn<TRow>[]): string {
  const lines: string[] = []
  lines.push(columns.map((c) => csvCell(c.header)).join(","))
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.accessor(row))).join(","))
  }
  return lines.join("\n")
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function toMarkdown<TRow>(rows: TRow[], columns: AuditExportColumn<TRow>[]): string {
  const headerCells = columns.map((c) => c.header)
  const separator = columns.map(() => "---")
  const out = [`| ${headerCells.join(" | ")} |`, `| ${separator.join(" | ")} |`]
  for (const row of rows) {
    const cells = columns.map((c) =>
      c.accessor(row).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")
    )
    out.push(`| ${cells.join(" | ")} |`)
  }
  return out.join("\n")
}

function triggerDownload(blob: Blob, filename: string): void {
  if (typeof URL === "undefined" || typeof document === "undefined") return
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
