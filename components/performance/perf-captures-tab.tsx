"use client"

/**
 * Captures — record encrypted performance evidence, keep a library of it,
 * compare two captures and check one against a budget (ADR-0035).
 *
 * Layout, top to bottom, in the order the work happens:
 *
 *   Recorder   source / cadence / duration, start-stop, progress and gaps
 *   Library    stored captures with localized status and trust, export,
 *              raw export (second confirmation), delete (confirmation);
 *              ticking two opens the comparison right under the list
 *   Budgets    immutable named thresholds and a capture check
 *
 * What changed from the first version: deleting was a single unconfirmed
 * click; status, stop reason and trust were printed as raw enum strings
 * (`duration-limit`, `valid-untrusted`); errors surfaced as raw codes
 * (`performance-capture-account-locked`) in toasts; Start was silently
 * disabled while the account was locked; comparison skipped every
 * eligibility rule; and budgets had no UI at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type {
  PerformanceCaptureAttachmentRow,
  PerformanceCaptureRow,
} from "@/lib/perf/capture-types"
import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useTranslations } from "next-intl"
import {
  DownloadIcon,
  LockIcon,
  PlayIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
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
} from "@/lib/perf/capture-portability"
import { readDecodedCapture } from "@/lib/perf/capture-analysis"
import { PerformanceBudgetService } from "@/lib/perf/budget-service"
import { PerformanceQuotaManager, PERFORMANCE_ACCOUNT_QUOTA_BYTES } from "@/lib/perf/quota"
import { formatBytes } from "@/lib/perf/backend/format"
import type { PerfSourceKind } from "@/lib/perf/backend/types"
import { formatDurationShort } from "@/lib/utils"
import { PERF_INTERVAL_OPTIONS } from "@/hooks/perf/use-perf-stream"
import { PerfCaptureCompare } from "./perf-capture-compare"
import { PerfBudgetPanel, type PerfBudgetStore } from "./perf-budget-panel"

const controller = getPerformanceCaptureController()
const DURATION_OPTIONS = [60_000, 600_000, 1_800_000, 3_600_000] as const

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

/** Typed empty default — a bare `[]` infers `never[]` and poisons every row read. */
const EMPTY_ATTACHMENTS: PerformanceCaptureAttachmentRow[] = []

/**
 * The lookup key for a thrown capture error. Codes can carry a suffix
 * (`account-locked:<accountId>`); the prefix is what is translated.
 */
export function captureErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(":")[0].trim()
}

const STATUS_TONE: Record<
  PerformanceCaptureRow["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  recording: "default",
  finalizing: "secondary",
  importing: "secondary",
  ready: "outline",
  failed: "destructive",
}

export function PerfCapturesTab({ hostAvailable }: { hostAvailable: boolean }) {
  const t = useTranslations("performance.captures")
  const formatter = useFormatter()
  const state = useSyncExternalStore(
    controller.subscribe.bind(controller),
    captureState,
    captureState
  )
  const accountId = useAccountStore((value) => value.unlockedAccountId)
  const [sourceKind, setSourceKind] = useState<PerfSourceKind>("renderer")
  const [cadenceMs, setCadenceMs] = useState(1000)
  const [durationMs, setDurationMs] = useState(PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS)
  const [activeDurationMs, setActiveDurationMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [rawCaptureId, setRawCaptureId] = useState<string | null>(null)
  const [rawAttachmentIds, setRawAttachmentIds] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<PerformanceCaptureRow | null>(null)
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

  const describeError = useCallback(
    (error: unknown) => {
      const code = captureErrorCode(error)
      return t.has(`errorCodes.${code}`)
        ? t(`errorCodes.${code}`)
        : t("errorCodes.unknown", {
            detail: error instanceof Error ? error.message : String(error),
          })
    },
    [t]
  )

  const run = useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true)
      try {
        await operation()
      } catch (error) {
        toast.error(describeError(error))
      } finally {
        setBusy(false)
      }
    },
    [describeError]
  )

  const loadCapture = useCallback(
    async (captureId: string) => {
      if (!accountId) throw new Error("performance-capture-account-locked")
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      return readDecodedCapture({ db, accountId, targetDatabase: db.name, captureId, key })
    },
    [accountId, db]
  )

  const budgetStore = useMemo<PerfBudgetStore | null>(() => {
    if (!accountId) return null
    const withService = async <T,>(
      operation: (service: PerformanceBudgetService, key: Uint8Array) => Promise<T>
    ) => {
      const key = await loadOrCreateAccountArtifactKey(accountId, "performance")
      const service = new PerformanceBudgetService()
      try {
        return await operation(service, key)
      } finally {
        service.close()
      }
    }
    return {
      list: () => withService((service, key) => service.list(accountId, key)),
      create: (input) => withService((service, key) => service.create(accountId, key, input)),
    }
  }, [accountId])

  const start = () =>
    run(async () => {
      await controller.start({ sourceKind, cadenceMs, durationMs })
      setActiveDurationMs(durationMs)
      toast.success(t("toast.started"))
    })

  const stop = () =>
    run(async () => {
      await controller.stop("manual")
      toast.success(t("toast.stopped"))
    })

  const remove = (captureId: string) =>
    run(async () => {
      if (!accountId) throw new Error("performance-capture-account-locked")
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
      setSelected((current) => current.filter((id) => id !== captureId))
      toast.success(t("toast.deleted"))
    })

  const exportCapture = (captureId: string) =>
    run(async () => {
      if (!accountId) throw new Error("performance-capture-account-locked")
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
      if (!accountId || !rawCaptureId) throw new Error("performance-capture-account-locked")
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
      if (!accountId) throw new Error("performance-capture-account-locked")
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

  const elapsed = useMemo(
    () => (state.startedAt ? Math.max(0, now - state.startedAt) : 0),
    [now, state.startedAt]
  )
  // The controller does not expose the requested duration, so the progress
  // bar uses the duration this tab started with; a capture started elsewhere
  // (or before a reload) shows elapsed time without a bar.
  const progress =
    state.active && activeDurationMs ? Math.min(100, (elapsed / activeDurationMs) * 100) : null
  const comparePair = useMemo(() => {
    const rows = selected
      .map((id) => captures.find((capture) => capture.id === id))
      .filter((row): row is PerformanceCaptureRow => Boolean(row))
    return rows.length === 2 ? ([rows[0], rows[1]] as const) : null
  }, [captures, selected])
  const readyCaptures = useMemo(
    () => captures.filter((capture) => capture.status === "ready"),
    [captures]
  )

  return (
    <div className="space-y-4" data-testid="perf-captures-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("active.title")}</CardTitle>
          <CardDescription className="text-xs">{t("active.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="perf-capture-source">{t("controls.source")}</Label>
              <Select
                value={sourceKind}
                onValueChange={(value) => setSourceKind(value as PerfSourceKind)}
                disabled={state.active}
              >
                <SelectTrigger id="perf-capture-source" aria-label={t("controls.source")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="renderer">{t("source.renderer")}</SelectItem>
                  <SelectItem value="host" disabled={!hostAvailable}>
                    {hostAvailable ? t("source.host") : t("source.hostUnavailable")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-capture-cadence">{t("controls.cadence")}</Label>
              <Select
                value={String(cadenceMs)}
                onValueChange={(value) => setCadenceMs(Number(value))}
                disabled={state.active}
              >
                <SelectTrigger id="perf-capture-cadence" aria-label={t("controls.cadence")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERF_INTERVAL_OPTIONS.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {t("milliseconds", { value })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-capture-duration">{t("controls.duration")}</Label>
              <Select
                value={String(durationMs)}
                onValueChange={(value) => setDurationMs(Number(value))}
                disabled={state.active}
              >
                <SelectTrigger id="perf-capture-duration" aria-label={t("controls.duration")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((value) => (
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
              <Button onClick={stop} disabled={busy} data-testid="perf-capture-stop">
                <SquareIcon />
                {t("controls.stop")}
              </Button>
            ) : (
              <Button
                onClick={start}
                disabled={busy || !accountId}
                data-testid="perf-capture-start"
              >
                <PlayIcon />
                {t("controls.start")}
              </Button>
            )}
            <Badge variant={state.active ? "default" : "secondary"}>
              {state.active ? t("state.recording") : t("state.idle")}
            </Badge>
            {state.active && (
              <span className="text-sm text-muted-foreground" data-testid="perf-capture-elapsed">
                {t("active.elapsed", { seconds: Math.floor(elapsed / 1000) })} ·{" "}
                {t("active.gaps", { count: state.gapCount })}
              </span>
            )}
          </div>
          {progress !== null ? (
            <Progress
              value={progress}
              className="h-1.5"
              aria-label={t("active.progress")}
              data-testid="perf-capture-progress"
            />
          ) : null}
          {!accountId ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="perf-capture-locked"
            >
              <LockIcon className="size-4" aria-hidden />
              {t("errors.locked")}
            </p>
          ) : null}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(state.error)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("library.title")}</CardTitle>
          <CardDescription className="text-xs">
            {t("library.retention", {
              count: 20,
              days: 30,
              quota: Math.round(PERFORMANCE_ACCOUNT_QUOTA_BYTES / 1024 / 1024 / 1024),
            })}
          </CardDescription>
          <CardAction>
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
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy || !accountId}
            >
              <UploadIcon />
              {t("controls.import")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {captures.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("library.empty")}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t("library.compareHint")}</p>
              <ul className="space-y-2" data-testid="perf-capture-library">
                {captures.map((capture) => {
                  const endedAt = capture.stoppedAt ?? capture.updatedAt
                  return (
                    <li
                      key={capture.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border p-3"
                      data-testid={`perf-capture-${capture.id}`}
                    >
                      <Checkbox
                        aria-label={t("controls.selectCompare", { id: capture.id })}
                        checked={selected.includes(capture.id)}
                        disabled={
                          capture.status !== "ready" ||
                          (!selected.includes(capture.id) && selected.length >= 2)
                        }
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, capture.id]
                              : current.filter((id) => id !== capture.id)
                          )
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {formatter.dateTime(capture.startedAt, {
                            dateStyle: "medium",
                            timeStyle: "medium",
                          })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(`source.${capture.sourceKind}`)} ·{" "}
                          {formatDurationShort(Math.max(0, endedAt - capture.startedAt))} ·{" "}
                          {t("library.frames", { count: capture.frameCount })} ·{" "}
                          {formatBytes(capture.payloadBytes + capture.attachmentBytes)}
                        </p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground/80">
                          {capture.id}
                        </p>
                      </div>
                      <Badge variant={STATUS_TONE[capture.status]}>
                        {t(`status.${capture.status}`)}
                      </Badge>
                      {capture.stopReason && capture.stopReason !== "manual" ? (
                        <Badge variant="outline">{t(`stopReason.${capture.stopReason}`)}</Badge>
                      ) : null}
                      {capture.gapCount > 0 ? (
                        <Badge variant="outline" className="border-warning/50 text-warning">
                          {t("active.gaps", { count: capture.gapCount })}
                        </Badge>
                      ) : null}
                      {capture.trustState && (
                        <Badge variant="secondary">{t(`trust.${capture.trustState}`)}</Badge>
                      )}
                      <div className="flex items-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("controls.export", { id: capture.id })}
                          title={t("controls.exportShort")}
                          onClick={() => void exportCapture(capture.id)}
                          disabled={busy || capture.status !== "ready"}
                        >
                          <DownloadIcon />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("controls.rawExport", { id: capture.id })}
                          title={t("controls.rawExportShort")}
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
                          title={t("controls.deleteShort")}
                          onClick={() => setDeleteTarget(capture)}
                          disabled={busy || capture.status === "recording"}
                          data-testid={`perf-capture-delete-${capture.id}`}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          {comparePair ? (
            <PerfCaptureCompare
              key={comparePair.map((row) => row.id).join(":")}
              captures={comparePair}
              loadCapture={loadCapture}
              describeError={describeError}
              disabled={busy || !accountId}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <PerfBudgetPanel
            store={budgetStore}
            captures={readyCaptures}
            loadCapture={loadCapture}
            describeError={describeError}
          />
        </CardContent>
      </Card>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("delete.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              data-testid="perf-capture-delete-confirm"
              onClick={(event) => {
                event.preventDefault()
                const target = deleteTarget
                if (!target) return
                void remove(target.id).finally(() => setDeleteTarget(null))
              }}
            >
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                      bytes: formatBytes(attachment.byteCount),
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
