"use client"

/**
 * BackfillDialog — manually re-run the past schedule slots of a cron/interval
 * task over a [start, end] range (Temporal backfill semantics). Shows a live
 * slot-count preview via `enumerateBackfillSlots` before confirming; the
 * actual execution goes through `scheduler.backfillTask` (sequential, slot
 * provenance, no `nextRunAt` mutation).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { History } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { enumerateBackfillSlots, BACKFILL_MAX_SLOTS } from "@/lib/scheduler/backfill"
import type { ScheduledTask } from "@/types/scheduler"

export interface BackfillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: ScheduledTask | null
  /** Executes the backfill; resolves with the number of slots that ran. */
  onBackfill: (range: { start: Date; end: Date }) => Promise<number>
}

function parseLocalDateTime(date: string, time: string, fallbackTime: string): Date | null {
  if (!date) return null
  const parsed = new Date(`${date}T${time || fallbackTime}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function BackfillDialog({ open, onOpenChange, task, onBackfill }: BackfillDialogProps) {
  const t = useTranslations("scheduler")
  const [startDate, setStartDate] = useState("")
  const [startTime, setStartTime] = useState("")
  const [endDate, setEndDate] = useState("")
  const [endTime, setEndTime] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; count?: number; error?: string } | null>(null)
  // Sampled in event handlers (render must stay pure); drives the
  // "range must be in the past" validation.
  const [nowMs, setNowMs] = useState(0)

  const isRecurring = task?.trigger.type === "cron" || task?.trigger.type === "interval"
  const start = parseLocalDateTime(startDate, startTime, "00:00")
  const end = parseLocalDateTime(endDate, endTime, "23:59")

  const validation = useMemo((): string | null => {
    if (!task || !isRecurring) return t("backfill.unsupportedTrigger")
    if (!start || !end) return null // incomplete input — no error yet, just no preview
    if (end.getTime() <= start.getTime()) return t("backfill.rangeInvalid")
    if (nowMs > 0 && end.getTime() > nowMs) return t("backfill.endMustBePast")
    return null
  }, [task, isRecurring, start, end, nowMs, t])

  const slots = useMemo(() => {
    if (!task || !isRecurring || !start || !end || validation) return []
    return enumerateBackfillSlots(task, start, end)
  }, [task, isRecurring, start, end, validation])

  const canConfirm = Boolean(
    task && isRecurring && start && end && !validation && slots.length > 0 && !isRunning
  )

  const handleConfirm = async () => {
    if (!start || !end) return
    setIsRunning(true)
    setResult(null)
    try {
      const count = await onBackfill({ start, end })
      setResult({ ok: true, count })
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsRunning(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) setResult(null)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="scheduler-backfill-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("backfill.title")}
          </DialogTitle>
          <DialogDescription>{t("backfill.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-sm">{t("backfill.start")}</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value)
                setNowMs(Date.now())
              }}
              data-testid="backfill-start-date"
            />
            <Input
              type="time"
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value)
                setNowMs(Date.now())
              }}
              disabled={!startDate}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t("backfill.end")}</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value)
                setNowMs(Date.now())
              }}
              data-testid="backfill-end-date"
            />
            <Input
              type="time"
              value={endTime}
              onChange={(e) => {
                setEndTime(e.target.value)
                setNowMs(Date.now())
              }}
              disabled={!endDate}
            />
          </div>
        </div>

        {validation ? (
          <p className="text-xs text-destructive" data-testid="backfill-validation">
            {validation}
          </p>
        ) : start && end ? (
          <p className="text-xs text-muted-foreground" data-testid="backfill-preview">
            {slots.length >= BACKFILL_MAX_SLOTS
              ? t("backfill.slotCountCapped", { count: BACKFILL_MAX_SLOTS })
              : t("backfill.slotCount", { count: slots.length })}
          </p>
        ) : null}

        {result && (
          <p
            className={result.ok ? "text-xs text-green-600" : "text-xs text-destructive"}
            data-testid="backfill-result"
          >
            {result.ok
              ? t("backfill.success", { count: result.count ?? 0 })
              : t("backfill.error", { message: result.error ?? "" })}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isRunning}>
            {t("cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} data-testid="backfill-confirm">
            {isRunning ? t("backfill.inProgress") : t("backfill.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
