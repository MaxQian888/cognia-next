"use client"

// Bulk-export many sessions as a ZIP. The user selects a subset of sessions
// (default: all), picks a format, and gets a single .zip file containing one
// rendered file per session. Progress feedback wires through `useBatchExport`.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { useBatchExport } from "@/hooks/data/use-batch-export"
import { notifyExportOutcome } from "@/lib/files/export-feedback"
import type { ChatSession } from "@/lib/claude/types"
import type { SingleExportFormat } from "@/lib/export/single"
import { listSessions } from "@/lib/db/sessions"
import { createLogger } from "@/lib/logging"

const log = createLogger("data-export")

interface Props {
  trigger: React.ReactNode
}

export function BatchExportDialog({ trigger }: Props) {
  const t = useTranslations("export")
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<SingleExportFormat>("markdown")
  const { run, busy, progress } = useBatchExport()

  useEffect(() => {
    if (!open) return
    listSessions()
      .then((rows) => {
        setSessions(rows)
        setSelectedIds(new Set(rows.map((r) => r.id)))
      })
      .catch((error) => {
        log.error("batch-export-list-sessions-failed", { error })
      })
  }, [open])

  const allSelected = sessions.length > 0 && selectedIds.size === sessions.length
  const someSelected = selectedIds.size > 0 && !allSelected

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(sessions.map((s) => s.id)))
  }

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onSubmit = async () => {
    const picked = sessions.filter((s) => selectedIds.has(s.id))
    if (picked.length === 0) return
    const { outcome, exportedCount } = await run({ sessions: picked, format })
    if (outcome.kind === "saved") {
      log.info("batch-export-completed", {
        format,
        count: exportedCount,
        platform: outcome.platform,
      })
      setOpen(false)
    } else if (outcome.kind === "error") {
      log.error("batch-export-failed", { format, count: picked.length, error: outcome.message })
    }
    notifyExportOutcome(outcome, { t, shareTitle: t("batchTitle") })
  }

  const progressPct = useMemo(() => {
    if (!progress || progress.total === 0) return 0
    return Math.round((progress.completed / progress.total) * 100)
  }, [progress])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("batchTitle")}</DialogTitle>
          <DialogDescription>{t("batchDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("formatLabel")}</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as SingleExportFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">{t("format.markdown")}</SelectItem>
                <SelectItem value="json">{t("format.json")}</SelectItem>
                <SelectItem value="text">{t("format.text")}</SelectItem>
                <SelectItem value="html">{t("format.html")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t("batch.sessionsLabel")}</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={toggleAll}
              >
                {allSelected ? t("batch.deselectAll") : t("batch.selectAll")}
              </button>
            </div>
            <ScrollArea className="h-44 rounded border bg-muted/20">
              <ul className="divide-y">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <Checkbox
                      checked={selectedIds.has(s.id)}
                      onCheckedChange={() => toggleOne(s.id)}
                    />
                    <span className="truncate">{s.title}</span>
                  </li>
                ))}
                {sessions.length === 0 && (
                  <li className="p-3 text-xs italic text-muted-foreground">{t("batch.empty")}</li>
                )}
              </ul>
            </ScrollArea>
            <p className="text-[11px] text-muted-foreground">
              {t("batch.selectedCount", { count: selectedIds.size, total: sessions.length })}
              {someSelected && ` — ${t("batch.someSelected")}`}
            </p>
          </div>

          {progress && (
            <div className="space-y-1">
              <Progress value={progressPct} />
              <p className="text-[11px] text-muted-foreground">
                {t("batch.progress", {
                  completed: progress.completed,
                  total: progress.total,
                  current: progress.currentTitle,
                })}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => void onSubmit()} disabled={busy || selectedIds.size === 0}>
            {busy ? t("batch.exporting") : t("batch.exportButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
