"use client"

/**
 * Import/Export Dialogs for scheduler tasks
 */

import { useState, useRef, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Download, Upload, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "sonner"
import { useScheduler } from "@/hooks/scheduler"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface ExportTasksDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedTaskIds?: Set<string>
}

export function ExportTasksDialog({ open, onOpenChange, selectedTaskIds }: ExportTasksDialogProps) {
  const t = useTranslations("scheduler")
  const { exportTasks } = useScheduler()
  const [scope, setScope] = useState<"all" | "selected">("all")
  const [isExporting, setIsExporting] = useState(false)

  const hasSelection = selectedTaskIds && selectedTaskIds.size > 0

  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      const taskIds =
        scope === "selected" && hasSelection ? Array.from(selectedTaskIds!) : undefined
      const data = await exportTasks(taskIds)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `cognia-scheduler-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      log.info("Tasks exported", { scope, selectedCount: taskIds?.length ?? "all" })
      toast.success(t("exportSuccess"))
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("Task export failed", { error: message })
      toast.error(t("exportError", { message }))
    } finally {
      setIsExporting(false)
    }
  }, [scope, hasSelection, selectedTaskIds, exportTasks, onOpenChange, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            {t("importExport.exportTitle") || "Export Tasks"}
          </DialogTitle>
          <DialogDescription>
            {t("importExport.exportDescription") || "Download your scheduled tasks as a JSON file"}
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={scope} onValueChange={(v) => setScope(v as "all" | "selected")}>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="all" id="export-all" />
            <Label htmlFor="export-all" className="text-sm">
              {t("importExport.exportAll") || "Export all tasks"}
            </Label>
          </div>
          {hasSelection && (
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="selected" id="export-selected" />
              <Label htmlFor="export-selected" className="text-sm">
                {t("importExport.exportSelected", { count: selectedTaskIds!.size }) ||
                  `Export selected (${selectedTaskIds!.size})`}
              </Label>
            </div>
          )}
        </RadioGroup>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel") || "Cancel"}
          </Button>
          <Button size="sm" onClick={handleExport} disabled={isExporting}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {isExporting ? "..." : t("importExport.exportTitle") || "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ImportTasksDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportTasksDialog({ open, onOpenChange }: ImportTasksDialogProps) {
  const t = useTranslations("scheduler")
  const { importTasks } = useScheduler()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<"merge" | "replace">("merge")
  const [fileData, setFileData] = useState<string | null>(null)
  const [previewCount, setPreviewCount] = useState(0)
  const [isImporting, setIsImporting] = useState(false)

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      setFileData(text)
      try {
        const parsed = JSON.parse(text)
        const tasks = Array.isArray(parsed) ? parsed : parsed.tasks || []
        setPreviewCount(tasks.length)
      } catch {
        setPreviewCount(0)
      }
    }
    reader.readAsText(file)
  }, [])

  const handleImport = useCallback(async () => {
    if (!fileData) return
    setIsImporting(true)
    try {
      const result = await importTasks(fileData, mode)
      const imported = result?.imported ?? 0
      const skipped = result?.skipped ?? 0
      const errors = result?.errors?.length ?? 0
      log.info("Tasks imported", { mode, imported, skipped, errors })
      const msg = t("importExport.importResult", { imported, skipped, errors })
      toast.success(msg)
      onOpenChange(false)
      setFileData(null)
      setPreviewCount(0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("Task import failed", { error: message, mode })
      toast.error(t("importError", { message }))
    } finally {
      setIsImporting(false)
    }
  }, [fileData, mode, importTasks, onOpenChange, t])

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          setFileData(null)
          setPreviewCount(0)
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            {t("importExport.importTitle") || "Import Tasks"}
          </DialogTitle>
          <DialogDescription>
            {t("importExport.importDescription") || "Import scheduled tasks from a JSON file"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/20"
            />
            {previewCount > 0 && (
              <Badge variant="secondary" className="mt-2 text-xs">
                {t("importExport.preview", { count: previewCount }) ||
                  `${previewCount} task(s) found in file`}
              </Badge>
            )}
          </div>

          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "merge" | "replace")}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="merge" id="import-merge" />
              <Label htmlFor="import-merge" className="text-sm">
                {t("importExport.mergeMode") || "Merge with existing tasks"}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="replace" id="import-replace" />
              <Label htmlFor="import-replace" className="text-sm">
                {t("importExport.replaceMode") || "Replace all existing tasks"}
              </Label>
            </div>
          </RadioGroup>

          {mode === "replace" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("importExport.replaceWarning") ||
                "This will delete all existing tasks before importing"}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel") || "Cancel"}
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={isImporting || !fileData || previewCount === 0}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            {isImporting ? "..." : t("importExport.importTitle") || "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
