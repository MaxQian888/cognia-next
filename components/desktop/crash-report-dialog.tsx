"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import {
  takePendingCrash,
  readCrashReport,
  openCrashReportDir,
  type PendingCrash,
} from "@/lib/native/crash-reports"

/**
 * Surfaces an abnormal previous exit once per launch. On mount it consumes the
 * pending-crash signal from Rust (`crash_take_pending`, which `.take()`s so it
 * fires only once); when present, it tells the user the app closed unexpectedly
 * and offers to view the saved report or open the reports folder.
 *
 * Renders nothing on web — the crash subsystem only runs under Tauri.
 */
export function CrashReportDialog() {
  const t = useTranslations("crashDialog")
  const [pending, setPending] = useState<PendingCrash | null>(null)
  const [reportText, setReportText] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void takePendingCrash()
      .then((result) => {
        if (!cancelled && result) setPending(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleClose = () => {
    setPending(null)
    setReportText(null)
  }

  const handleView = async () => {
    if (!pending?.latestReportStem) return
    const text = await readCrashReport(pending.latestReportStem)
    setReportText(text ?? "")
  }

  if (!pending) return null

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangleIcon className="size-5 text-amber-500" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description", {
              time: new Date(pending.startedAt).toLocaleString(),
              version: pending.version,
            })}
          </DialogDescription>
        </DialogHeader>

        {reportText !== null && (
          <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {reportText || t("noReport")}
          </pre>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            {t("dismiss")}
          </Button>
          <Button variant="outline" onClick={() => void openCrashReportDir()}>
            {t("openFolder")}
          </Button>
          {pending.latestReportStem && reportText === null && (
            <Button onClick={() => void handleView()}>{t("viewReport")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
