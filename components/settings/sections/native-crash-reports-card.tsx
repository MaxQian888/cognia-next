"use client"

// Native crash reports — the Rust crash subsystem's MC-style reports
// (`.txt` / `.json` / `.dmp`) written by the panic hook + out-of-process
// minidump monitor. Read-only list with view / open-folder / delete.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, RefreshCwIcon, FileTextIcon, Trash2Icon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { isTauri } from "@/lib/tauri"
import {
  listCrashReports,
  readCrashReport,
  openCrashReportDir,
  deleteCrashReport,
  type CrashReportSummary,
} from "@/lib/native/crash-reports"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function NativeCrashReportsCard() {
  const t = useTranslations("settings.diagnostics.crashReports")
  const desktop = isTauri()
  const [reports, setReports] = useState<CrashReportSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [viewing, setViewing] = useState<{ stem: string; text: string } | null>(null)

  const refresh = useCallback(async () => {
    if (!desktop) return
    setLoading(true)
    try {
      setReports(await listCrashReports())
    } finally {
      setLoading(false)
    }
  }, [desktop])

  // Load on mount without a synchronous setState in the effect body (which
  // `react-hooks/set-state-in-effect` flags): kick off the fetch and only
  // update state in the async continuation, guarded against unmount.
  useEffect(() => {
    if (!desktop) return
    let active = true
    void (async () => {
      const list = await listCrashReports()
      if (active) setReports(list)
    })()
    return () => {
      active = false
    }
  }, [desktop])

  const handleView = useCallback(async (stem: string) => {
    const text = await readCrashReport(stem)
    setViewing({ stem, text: text ?? "" })
  }, [])

  const handleDelete = useCallback(
    async (stem: string) => {
      if (await deleteCrashReport(stem)) {
        await refresh()
      }
    },
    [refresh]
  )

  const kindLabel = (kind?: string) =>
    kind === "native" ? t("kindNative") : kind === "panic" ? t("kindPanic") : t("kindUnknown")

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={!desktop || loading}
            >
              <RefreshCwIcon className="size-4" />
              {t("refresh")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openCrashReportDir()}
              disabled={!desktop}
            >
              <FolderOpenIcon className="size-4" />
              {t("openFolder")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        {!desktop ? (
          <p className="text-muted-foreground">{t("desktopOnly")}</p>
        ) : reports.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y">
            {reports.map((report) => (
              <li
                key={report.stem}
                className="flex items-center justify-between gap-3 py-2"
                data-testid="crash-report-row"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={report.kind === "native" ? "destructive" : "secondary"}>
                      {kindLabel(report.kind)}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {report.capturedAt
                        ? new Date(report.capturedAt).toLocaleString()
                        : report.stem}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {(
                      [
                        ["txt", report.hasTxt],
                        ["json", report.hasJson],
                        ["dmp", report.hasDmp],
                      ] as const
                    )
                      .filter(([, present]) => present)
                      .map(([ext]) => (
                        <span key={ext}>{ext.toUpperCase()}</span>
                      ))}
                    <span>{formatBytes(report.sizeBytes)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleView(report.stem)}
                    aria-label={t("view")}
                  >
                    <FileTextIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete(report.stem)}
                    aria-label={t("delete")}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{viewing?.stem}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {viewing?.text || t("empty")}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
