"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { PerformanceCaptureAttachmentRow } from "@/lib/perf/capture-types"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  PlayIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { getDb } from "@/lib/db/schema"
import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { useAccountStore } from "@/stores/account/account-store"
import { getPerformanceCaptureController } from "@/lib/perf/capture-controller"
import {
  deletePerformanceCapture,
  PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS,
} from "@/lib/perf/capture-service"
import {
  exportPerformanceCapture,
  importPerformanceCapture,
  preparePerformanceRawExport,
  readPerformanceCaptureFrames,
} from "@/lib/perf/capture-portability"
import { compareMetricSeries } from "@/lib/perf/comparison"
import { PerformanceQuotaManager, PERFORMANCE_ACCOUNT_QUOTA_BYTES } from "@/lib/perf/quota"
import type { PerfFrame, PerfSourceKind } from "@/lib/perf/backend/types"

const controller = getPerformanceCaptureController()

function captureState() {
  return controller.snapshot
}

function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/vnd.cognia.perf+zip" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function validCpuIntervals(frames: PerfFrame[]) {
  return frames.map((frame) => ({
    value: frame.processes.find((process) => process.role === "main")?.cpuPct ?? null,
    valid:
      !frame.flags.reset &&
      !frame.flags.discontinuity &&
      !frame.flags.counterReset &&
      frame.missedTicks === 0,
  }))
}

/** Typed empty default — a bare `[]` infers `never[]` and poisons every row read. */
const EMPTY_ATTACHMENTS: PerformanceCaptureAttachmentRow[] = []

export function PerfCapturesTab({ hostAvailable }: { hostAvailable: boolean }) {
  const t = useTranslations("performance.captures")
  const state = useSyncExternalStore(
    controller.subscribe.bind(controller),
    captureState,
    captureState
  )
  const accountId = useAccountStore((value) => value.unlockedAccountId)
  const [sourceKind, setSourceKind] = useState<PerfSourceKind>("renderer")
  const [cadenceMs, setCadenceMs] = useState(1000)
  const [durationMs, setDurationMs] = useState(PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [comparison, setComparison] = useState<ReturnType<typeof compareMetricSeries> | null>(null)
  const [rawCaptureId, setRawCaptureId] = useState<string | null>(null)
  const [rawAttachmentIds, setRawAttachmentIds] = useState<string[]>([])
  const [now, setNow] = useState(Date.now)
  const fileRef = useRef<HTMLInputElement>(null)
  const db = getDb()
  const captures = useLiveQuery(
    () => db.performanceCaptures.orderBy("startedAt").reverse().toArray(),
    [db.name],
    []
  )
  const scope = getActiveRuntimeTargetContext()
  // The empty branch and the default both need the row type spelled out —
  // otherwise they infer `never[]`, the union collapses, and every field read
  // off a row below fails with "does not exist on type 'never'".
  const rawAttachments = useLiveQuery(
    () =>
      rawCaptureId
        ? db.performanceCaptureAttachments.where("captureId").equals(rawCaptureId).sortBy("ordinal")
        : Promise.resolve<PerformanceCaptureAttachmentRow[]>([]),
    [db.name, rawCaptureId],
    EMPTY_ATTACHMENTS
  )

  useEffect(() => {
    if (!state.active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [state.active])

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const start = () =>
    run(async () => {
      await controller.start({ sourceKind, cadenceMs, durationMs })
      toast.success(t("toast.started"))
    })

  const stop = () =>
    run(async () => {
      await controller.stop("manual")
      toast.success(t("toast.stopped"))
    })

  const remove = (captureId: string) =>
    run(async () => {
      if (!accountId) throw new Error(t("errors.locked"))
      const quota = new PerformanceQuotaManager()
      try {
        await deletePerformanceCapture({
          db,
          quota,
          accountId,
          targetDatabase: db.name,
          captureId,
        })
      } finally {
        quota.close()
      }
    })

  const exportCapture = (captureId: string) =>
    run(async () => {
      if (!accountId) throw new Error(t("errors.locked"))
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      const bytes = await exportPerformanceCapture({
        db,
        accountId,
        targetDatabase: db.name,
        captureId,
        key,
        redactionMode: "redacted",
        producerFingerprint: `cognia:${location.origin}`,
      })
      download(bytes, `${captureId}.cognia-perf`)
      toast.success(t("toast.exported"))
    })

  const exportRawCapture = () =>
    run(async () => {
      if (!accountId || !rawCaptureId) throw new Error(t("errors.locked"))
      const prepared = await preparePerformanceRawExport({
        db,
        captureId: rawCaptureId,
        attachmentIds: rawAttachmentIds,
      })
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      const bytes = await exportPerformanceCapture({
        db,
        accountId,
        targetDatabase: db.name,
        captureId: rawCaptureId,
        key,
        redactionMode: "raw",
        attachmentIds: prepared.attachmentIds,
        rawConfirmation: prepared.confirmation,
        producerFingerprint: `cognia:${location.origin}`,
      })
      download(bytes, `${rawCaptureId}-raw.cognia-perf`)
      setRawCaptureId(null)
      setRawAttachmentIds([])
      toast.success(t("toast.rawExported"))
    })

  const importFile = (file: File) =>
    run(async () => {
      if (!accountId) throw new Error(t("errors.locked"))
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      const quota = new PerformanceQuotaManager()
      try {
        await importPerformanceCapture({
          db,
          quota,
          accountId,
          targetDatabase: db.name,
          targetId: scope?.targetId ?? "web-standalone",
          key,
          packageBytes: new Uint8Array(await file.arrayBuffer()),
        })
      } finally {
        quota.close()
      }
      toast.success(t("toast.imported"))
    })

  const compare = () =>
    run(async () => {
      if (!accountId || selected.length !== 2) throw new Error(t("errors.compareSelection"))
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      const [baseline, candidate] = await Promise.all(
        selected.map((captureId) =>
          readPerformanceCaptureFrames({
            db,
            accountId,
            targetDatabase: db.name,
            captureId,
            key,
          })
        )
      )
      setComparison(compareMetricSeries(validCpuIntervals(baseline), validCpuIntervals(candidate)))
    })

  const elapsed = useMemo(
    () => (state.startedAt ? Math.max(0, now - state.startedAt) : 0),
    [now, state.startedAt]
  )

  return (
    <div className="space-y-4" data-testid="perf-captures-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("active.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t("controls.source")}</Label>
              <Select
                value={sourceKind}
                onValueChange={(value) => setSourceKind(value as PerfSourceKind)}
                disabled={state.active}
              >
                <SelectTrigger aria-label={t("controls.source")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="renderer">{t("source.renderer")}</SelectItem>
                  <SelectItem value="host" disabled={!hostAvailable}>
                    {t("source.host")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("controls.cadence")}</Label>
              <Select
                value={String(cadenceMs)}
                onValueChange={(value) => setCadenceMs(Number(value))}
                disabled={state.active}
              >
                <SelectTrigger aria-label={t("controls.cadence")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[500, 1000, 2000, 4000].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {t("milliseconds", { value })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("controls.duration")}</Label>
              <Select
                value={String(durationMs)}
                onValueChange={(value) => setDurationMs(Number(value))}
                disabled={state.active}
              >
                <SelectTrigger aria-label={t("controls.duration")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[60_000, 600_000, 1_800_000, 3_600_000].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {t("minutes", { value: value / 60_000 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {state.active ? (
              <Button onClick={stop} disabled={busy}>
                <SquareIcon />
                {t("controls.stop")}
              </Button>
            ) : (
              <Button onClick={start} disabled={busy || !accountId}>
                <PlayIcon />
                {t("controls.start")}
              </Button>
            )}
            <Badge variant={state.active ? "default" : "secondary"}>
              {state.active ? t("state.recording") : t("state.idle")}
            </Badge>
            {state.active && (
              <span className="text-sm text-muted-foreground">
                {t("active.elapsed", { seconds: Math.floor(elapsed / 1000) })} ·{" "}
                {t("active.gaps", { count: state.gapCount })}
              </span>
            )}
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{t("library.title")}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("library.retention", {
                count: 20,
                days: 30,
                quota: Math.round(PERFORMANCE_ACCOUNT_QUOTA_BYTES / 1024 / 1024 / 1024),
              })}
            </p>
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".cognia-perf"
              className="sr-only"
              aria-label={t("controls.import")}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importFile(file)
                event.target.value = ""
              }}
            />
            <Button
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={busy || !accountId}
            >
              <UploadIcon />
              {t("controls.import")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {captures.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("library.empty")}</p>
          ) : (
            captures.map((capture) => (
              <div
                key={capture.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3"
              >
                <Checkbox
                  aria-label={t("controls.selectCompare", { id: capture.id })}
                  checked={selected.includes(capture.id)}
                  disabled={!selected.includes(capture.id) && selected.length >= 2}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked ? [...current, capture.id] : current.filter((id) => id !== capture.id)
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{capture.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(capture.startedAt).toLocaleString()} ·{" "}
                    {t(`source.${capture.sourceKind}`)} ·{" "}
                    {t("library.frames", { count: capture.frameCount })} ·{" "}
                    {t("library.bytes", { value: capture.payloadBytes + capture.attachmentBytes })}
                  </p>
                </div>
                <Badge variant="outline">{capture.stopReason ?? capture.status}</Badge>
                {capture.trustState && <Badge variant="secondary">{capture.trustState}</Badge>}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("controls.export", { id: capture.id })}
                  onClick={() => void exportCapture(capture.id)}
                  disabled={busy || capture.status !== "ready"}
                >
                  <DownloadIcon />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("controls.rawExport", { id: capture.id })}
                  onClick={() => {
                    setRawCaptureId(capture.id)
                    setRawAttachmentIds([])
                  }}
                  disabled={busy || !accountId || capture.status !== "ready"}
                >
                  <ShieldAlertIcon />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("controls.delete", { id: capture.id })}
                  onClick={() => void remove(capture.id)}
                  disabled={busy || capture.status === "recording"}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))
          )}
          <Button variant="outline" onClick={compare} disabled={busy || selected.length !== 2}>
            {t("comparison.compare")}
          </Button>
          {comparison && (
            <div role="status" className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-5">
              <span>
                {t("comparison.median")}:{" "}
                {comparison.baseline.median?.toFixed(2) ?? t("comparison.na")} →{" "}
                {comparison.candidate.median?.toFixed(2) ?? t("comparison.na")}
              </span>
              <span>
                {t("comparison.p95")}: {comparison.baseline.p95?.toFixed(2) ?? t("comparison.na")} →{" "}
                {comparison.candidate.p95?.toFixed(2) ?? t("comparison.na")}
              </span>
              <span>
                {t("comparison.mad")}: {comparison.baseline.mad?.toFixed(2) ?? t("comparison.na")} →{" "}
                {comparison.candidate.mad?.toFixed(2) ?? t("comparison.na")}
              </span>
              <span>
                {t("comparison.absolute")}:{" "}
                {comparison.absoluteDelta?.toFixed(2) ?? t("comparison.na")}
              </span>
              <span>
                {t("comparison.percent")}:{" "}
                {comparison.percentDelta === null
                  ? t("comparison.na")
                  : `${comparison.percentDelta.toFixed(2)}%`}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(rawCaptureId)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRawCaptureId(null)
            setRawAttachmentIds([])
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("raw.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("raw.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("raw.attachments")}</p>
            {rawAttachments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("raw.noAttachments")}</p>
            ) : (
              rawAttachments.map((attachment) => (
                <Label
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-md border p-2"
                >
                  <Checkbox
                    checked={rawAttachmentIds.includes(attachment.id)}
                    onCheckedChange={(checked) =>
                      setRawAttachmentIds((current) =>
                        checked
                          ? [...current, attachment.id]
                          : current.filter((id) => id !== attachment.id)
                      )
                    }
                  />
                  <span>
                    {t("raw.attachment", {
                      ordinal: attachment.ordinal,
                      type: attachment.contentType,
                      bytes: attachment.byteCount,
                    })}
                  </span>
                </Label>
              ))
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("raw.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void exportRawCapture()
              }}
            >
              {t("raw.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
